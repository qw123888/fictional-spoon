/**
 * 存储模块（唯一的数据落地入口）
 * ------------------------------------------------------------
 * 上层任何模块都不直接碰 KV / 内存，只调用这里的 5 个方法。
 *  - 绑定了 Cloudflare KV（env.NOTIFY_KV）时用它做持久化；
 *  - 没绑定（本地开发 / 忘了建命名空间）时自动退化成进程内存，站点依然可用；
 *  - 无论哪种后端，都额外维护一份内存热缓存，规避 KV 最终一致带来的"刚写完读不到"。
 *
 * 将来要换成 D1 / Durable Object / Redis，只改这个文件，上层零改动。
 */
export class Store {
  constructor(kv = null) {
    this.kv = kv;
    this.mem = new Map();
  }

  /** 是否真正持久化 */
  get persistent() {
    return Boolean(this.kv);
  }

  async get(key, fallback = null) {
    let raw = this.mem.has(key) ? this.mem.get(key) : null;
    if (raw === null && this.kv) {
      raw = await this.kv.get(key);
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
    if (this.kv) await this.kv.put(key, raw);
  }

  async delete(key) {
    this.mem.delete(key);
    if (this.kv) await this.kv.delete(key);
  }

  /** 只列出内存缓存里的 key（KV 的 list 是异步分页的，这里不做全量扫描） */
  keys(prefix = "") {
    return [...this.mem.keys()].filter((k) => k.startsWith(prefix));
  }
}

export function createStore(env = {}) {
  // 兼容两种绑定名：wrangler.toml 里的 NOTIFY_KV，或控制台模板默认的 KV
  return new Store(env.NOTIFY_KV || env.KV || null);
}
