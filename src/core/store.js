/**
 * 存储模块（唯一的数据落地入口）
 * ------------------------------------------------------------
 * 上层任何模块都不直接碰 KV / 缓存 / 内存，只调用这里的 5 个方法。
 *
 * 三级后端，按可用性自动挑一个（保存配置后能不能读回来，全看这里）：
 *  1. Cloudflare KV（env.NOTIFY_KV）—— 真持久化，跨机房一致；
 *  2. 边缘缓存 Cache API（caches.default）—— 不需要建任何绑定，
 *     但**只在自定义域名 / Pages（*.pages.dev）上真的能用**；
 *     Cloudflare 文档明确写了 workers.dev 上 Cache API 不生效，
 *     所以跑在 *.workers.dev 时这里会直接判成不可用（不然就是自欺欺人）；
 *  3. 进程内存 —— 本地开发（node local/server.mjs）或上面两者都不可用时兜底。
 *
 * 无论哪种后端，都额外维护一份内存热缓存，规避 KV 最终一致带来的"刚写完读不到"。
 *
 * 将来要换成 D1 / Durable Object / Redis，只改这个文件，上层零改动。
 */
export class Store {
  constructor(kv = null, cache = null, opts = {}) {
    this.kv = kv;
    this.cache = cache;
    /** 跑在 *.workers.dev 这类 Cache API 不生效的地方时置 true（用来如实提示用户） */
    this.cacheUnusable = Boolean(opts.cacheUnusable);
    this.mem = new Map();
  }

  /** 是否真正持久化（KV） */
  get persistent() {
    return Boolean(this.kv);
  }

  /** 实际用的后端名，会出现在 /api/health 里 */
  get backend() {
    if (this.kv) return "cloudflare-kv";
    if (this.cache && !this.cacheUnusable) return "edge-cache";
    return "memory";
  }

  /** 给界面用的一句人话 */
  get backendLabel() {
    if (this.kv) return "KV 持久化";
    if (this.cache && !this.cacheUnusable) return "边缘缓存（同机房有效）";
    if (this.cacheUnusable) return "内存（临时；*.workers.dev 上 Cache API 不生效）";
    return "内存（临时，重启/换机房会丢）";
  }

  /** 存不住配置时，给用户一句"怎么办" */
  get backendHint() {
    if (this.kv) return "";
    if (this.cache && !this.cacheUnusable) {
      return "配置写在边缘缓存里：同一个机房能读到，跨机房或缓存被清会退回默认值。建议绑 KV 彻底解决。";
    }
    if (this.cacheUnusable) {
      return "当前是 *.workers.dev 域名：Cache API 在这里不生效，所以配置只能临时放在内存里。绑一个 KV 命名空间就能存住（控制台 30 秒搞定，不用改代码、不用重新部署）。";
    }
    return "当前只有进程内存可用，配置存不住。请给 Worker 绑定 KV 命名空间（变量名 NOTIFY_KV）。";
  }

  /** 缓存 URL 用的假域名（只在本模块内部使用，不会真的出网） */
  _cacheUrl(key) {
    return `https://notify-store.internal/${encodeURIComponent(key)}`;
  }

  async _cacheGet(key) {
    if (!this.cache) return null;
    try {
      const hit = await this.cache.match(this._cacheUrl(key));
      if (!hit) return null;
      return await hit.text();
    } catch {
      return null;
    }
  }

  async _cacheSet(key, raw) {
    if (!this.cache) return false;
    try {
      await this.cache.put(
        this._cacheUrl(key),
        new Response(raw, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "max-age=31536000" }
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async _cacheDelete(key) {
    if (!this.cache) return;
    try {
      await this.cache.delete(this._cacheUrl(key));
    } catch {
      /* 删不掉就算了，上层有覆盖写 */
    }
  }

  async get(key, fallback = null) {
    // 1) 进程内热缓存（同一个 isolate 里最快）
    let raw = this.mem.has(key) ? this.mem.get(key) : null;
    // 2) KV
    if (raw === null && this.kv) {
      raw = await this.kv.get(key);
      if (raw !== null && raw !== undefined) this.mem.set(key, raw);
    }
    // 3) 边缘缓存
    if (raw === null && this.cache) {
      raw = await this._cacheGet(key);
      if (raw !== null && raw !== undefined) this.mem.set(key, raw);
    }
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // 兼容非 JSON 的裸字符串
    }
  }

  async set(key, value) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    this.mem.set(key, raw);
    if (this.kv) {
      await this.kv.put(key, raw);
      return;
    }
    // 没绑 KV 时落边缘缓存：这是"保存完刷新还在"的关键
    await this._cacheSet(key, raw);
  }

  async delete(key) {
    this.mem.delete(key);
    if (this.kv) await this.kv.delete(key);
    await this._cacheDelete(key);
  }

  /**
   * 写后校验：把刚才写的内容重新读回来比对。
   * 后端不可用（比如两者都退化到内存且换了 isolate）时返回 false，路由层据此如实回报"没存住"。
   */
  async verify(key, value) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    this.mem.delete(key); // 先清热缓存，强制走真后端
    const back = await this.get(key, null);
    if (back === null) return false;
    const backRaw = typeof back === "string" ? back : JSON.stringify(back);
    return backRaw === raw;
  }

  /** 只列出内存缓存里的 key（KV/缓存的 list 是异步分页的，这里不做全量扫描） */
  keys(prefix = "") {
    return [...this.mem.keys()].filter((k) => k.startsWith(prefix));
  }
}

/**
 * @param {object} env      Worker 的 env（含 NOTIFY_KV / KV 绑定）
 * @param {object} runtime  可注入的运行时：{ caches, hostname }
 *   hostname 用来判断是不是 *.workers.dev —— Cloudflare 文档写明 workers.dev
 *   上 Cache API 不生效（自定义域名 / Pages 才生效），所以那种情况别假装有缓存兜底。
 */
export function createStore(env = {}, runtime = {}) {
  // 兼容两种绑定名：wrangler.toml 里的 NOTIFY_KV，或控制台模板默认的 KV
  const kv = env.NOTIFY_KV || env.KV || null;
  const host = String(runtime.hostname || "");
  const onWorkersDev = /\.workers\.dev$/i.test(host);
  const cacheUnusable = !kv && onWorkersDev;

  let cache = runtime.caches && runtime.caches.default ? runtime.caches.default : null;
  if (!cache && typeof caches !== "undefined" && caches && caches.default) cache = caches.default;
  if (kv || cacheUnusable) cache = null; // 有 KV 不必走缓存；workers.dev 上缓存本来就不生效

  return new Store(kv, cache, { cacheUnusable });
}
