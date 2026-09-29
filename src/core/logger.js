/**
 * 事件日志模块（环形缓冲 + 计数器）
 * ------------------------------------------------------------
 * 界面的"通知日志"和统计数字全部来自这里；任何模块都不许自己往 KV 写日志键。
 */
const LOG_KEY = "logs:recent";
const STATS_KEY = "stats:counters";
const MAX_LOGS = 200;

export class EventLog {
  constructor(store, { max = MAX_LOGS } = {}) {
    this.store = store;
    this.max = max;
  }

  /**
   * @param {{level?:string, title?:string, content?:string, source?:string,
   *          route?:string, ok?:boolean, reason?:string, detail?:string,
   *          ms?:number, requestId?:string, fingerprint?:string, force?:boolean}} entry
   */
  async push(entry = {}) {
    const now = new Date();
    const item = {
      id: Math.random().toString(36).slice(2, 10),
      ts: now.getTime(),
      iso: now.toISOString(),
      level: entry.level || (entry.ok ? "ok" : entry.ok === false ? "error" : "info"),
      title: String(entry.title ?? "").slice(0, 60),
      content: String(entry.content ?? "").slice(0, 200),
      source: entry.source || "unknown",
      route: entry.route || "",
      ok: entry.ok === undefined ? null : Boolean(entry.ok),
      reason: entry.reason || "",
      detail: String(entry.detail ?? "").slice(0, 300),
      ms: Number(entry.ms ?? 0),
      requestId: entry.requestId || "",
      fingerprint: entry.fingerprint || "",
      force: Boolean(entry.force)
    };

    const list = await this.store.get(LOG_KEY, []);
    const next = [item, ...(Array.isArray(list) ? list : [])].slice(0, this.max);
    await this.store.set(LOG_KEY, next);

    const s = await this.store.get(STATS_KEY, { total: 0, ok: 0, fail: 0, skipped: 0, lastAt: 0 });
    s.total = (s.total || 0) + 1;
    if (item.level === "ok") s.ok = (s.ok || 0) + 1;
    else if (item.level === "error") s.fail = (s.fail || 0) + 1;
    else if (item.level === "skip") s.skipped = (s.skipped || 0) + 1;
    s.lastAt = item.ts;
    await this.store.set(STATS_KEY, s);

    return item;
  }

  async list(limit = 50) {
    const list = await this.store.get(LOG_KEY, []);
    return (Array.isArray(list) ? list : []).slice(0, Math.max(1, Math.min(200, limit)));
  }

  async clear() {
    await this.store.set(LOG_KEY, []);
  }

  async stats() {
    return await this.store.get(STATS_KEY, { total: 0, ok: 0, fail: 0, skipped: 0, lastAt: 0 });
  }
}
