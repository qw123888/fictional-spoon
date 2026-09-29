import { loadConfig } from "../core/config.js";
import { evaluateWindow, describeWindow } from "../core/window.js";
import { checkGuard, commitGuard, fingerprintOf, guardStatus } from "../core/guard.js";
import { ChannelRegistry } from "./channel.js";
import { PhoneCallAdapter } from "./channels/spug_voice.js";
import { WebhookAdapter } from "./channels/webhook.js";

/**
 * ============================================================
 *  主通信接口 CommModule（通信模块）
 * ============================================================
 * 约定：站点内任何"要发通知"的地方（信号接口 / 测试电话 / 将来的定时任务）
 *      一律调用 comm.notify(signal)，不许绕过它直接 fetch 电话接口。
 *
 * 一次 notify 的流水线：
 *   归一化信号 → 找通道适配器 → 总开关 → 时间段 → 防轰炸 → 适配器发送(带重试) → 记录 → (可选)备用通道
 *
 * 扩展方式：写一个新的 ChannelAdapter，然后 comm.register(new XxxAdapter())，
 *          信号里 kind 填它的 kind 即可，本文件不用改。
 */
const PHONE_HEALTH_KEY = "health:phone";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CommModule {
  constructor({ store, log, env = {} }) {
    this.store = store;
    this.log = log;
    this.env = env;
    this.registry = new ChannelRegistry();
    // 默认通道：电话 + Webhook 备用
    this.register(new PhoneCallAdapter());
    this.register(new WebhookAdapter());
  }

  register(adapter) {
    this.registry.register(adapter);
    return this;
  }

  adapters() {
    return this.registry.list().map((a) => a.describe());
  }

  async config() {
    return await loadConfig(this.store, this.env);
  }

  /** 通道自检（不产生真实通知） */
  async probe(kind = "phone") {
    const cfg = await this.config();
    const adapter = this.registry.get(kind);
    if (!adapter) return { ok: false, reason: "unknown_channel", detail: `未知通道：${kind}` };
    const started = Date.now();
    const result = await adapter.probe({ config: cfg, store: this.store, log: this.log, env: this.env });
    return { adapter: adapter.name, kind: adapter.kind, ms: Date.now() - started, ...result };
  }

  /**
   * 主通信接口：发一条通知
   * @param {object} signal {kind, title, content, source, id, meta, force}
   * @param {{force?:boolean}} [opts]
   */
  async notify(signal = {}, opts = {}) {
    const started = Date.now();
    const cfg = await this.config();
    const kind = String(signal.kind || "phone").toLowerCase();
    const force = Boolean(opts.force || signal.force);
    const source = signal.source || "unknown";

    const adapter = this.registry.get(kind);
    if (!adapter) {
      return this._finish({
        ok: false, skipped: false, reason: "unknown_channel",
        detail: `未知通道：${kind}（已注册：${this.registry.list().map((a) => a.kind).join(", ")}）`,
        signal, cfg, started, source
      });
    }

    // 1) 总开关（force 穿透）
    if (!cfg.enabled && !force) {
      return this._finish({
        ok: false, skipped: true, reason: "disabled", detail: "站点通知总开关已关闭",
        signal, cfg, started, source, kind
      });
    }

    // 2) 时间段
    const win = evaluateWindow(cfg);
    if (!force && !win.active) {
      return this._finish({
        ok: false, skipped: true, reason: "outside_window",
        detail: `不在可拨打时间段（${win.detail}）`,
        signal, cfg, started, source, kind, window: win
      });
    }

    // 3) 防轰炸（force 不占额度也不受限）
    const fp = signal.fingerprint || fingerprintOf(signal);
    let guard = { allow: true, detail: "" };
    if (!force) {
      guard = await checkGuard(
        { store: this.store, guard: cfg.guard },
        { fingerprint: fp, nowMs: Date.now(), hourKey: win.now.hourKey }
      );
      if (!guard.allow) {
        return this._finish({
          ok: false, skipped: true, reason: guard.reason, detail: guard.detail,
          signal, cfg, started, source, kind, window: win, fingerprint: fp
        });
      }
      await commitGuard(
        { store: this.store, guard: cfg.guard },
        { fingerprint: fp, nowMs: Date.now(), hourKey: win.now.hourKey }
      );
    }

    // 4) 组装 payload 并发送
    const payload = this._buildPayload(cfg, signal);
    const ctx = { config: cfg, store: this.store, log: this.log, env: this.env };
    const result = await this._sendWithRetry(adapter, payload, ctx, cfg.phone.retry);

    // 5) 电话通道的健康快照
    if (adapter.kind === "phone") {
      await this.store.set(PHONE_HEALTH_KEY, {
        ok: result.ok, ts: Date.now(), reason: result.reason || "", detail: result.detail || "", ms: result.ms ?? 0
      });
    }

    // 6) 备用通道（电话挂了但还有网时）
    let fallback = null;
    if (!result.ok && cfg.fallback.enabled && adapter.kind !== "webhook") {
      const fb = this.registry.get("webhook");
      if (fb) {
        const r = await this._sendWithRetry(fb, payload, ctx, 0);
        fallback = { ok: r.ok, detail: r.detail, reason: r.reason };
        await this.log.push({
          level: r.ok ? "warn" : "error",
          title: payload.title, content: payload.content, source: `${source}#fallback`,
          route: "webhook", ok: r.ok, reason: r.reason, detail: r.detail, ms: r.ms,
          fingerprint: fp, force
        });
      }
    }

    return this._finish({
      ok: result.ok, skipped: false, reason: result.reason, detail: result.detail,
      requestId: result.requestId, attempts: result.attempts,
      signal, cfg, started, source, kind, window: win, fingerprint: force ? "" : fp, force, fallback
    });
  }

  /** 测试电话：force=true，绕过开关/时间段/去重，但完整走一遍通道 */
  async testCall({ title = "测试电话", content = "", source = "test" } = {}) {
    return await this.notify({ kind: "phone", title, content, source, force: true }, { force: true });
  }

  /** 运行状态汇总，给界面顶部状态栏用 */
  async health() {
    const cfg = await this.config();
    const win = evaluateWindow(cfg);
    const guard = await guardStatus({ store: this.store, guard: cfg.guard }, { hourKey: win.now.hourKey });
    const phone = await this.store.get(PHONE_HEALTH_KEY, null);
    const token = this.env.SIGNAL_TOKEN ? true : Boolean(await this.store.get("auth:token", ""));
    return {
      ok: true,
      now: { iso: win.now.hhmm, date: win.now.dateKey, weekday: win.now.weekday, tz: cfg.window.tz },
      enabled: cfg.enabled,
      window: { active: win.active, detail: win.detail, description: describeWindow(cfg) },
      guard,
      storage: { persistent: this.store.persistent, backend: this.store.persistent ? "cloudflare-kv" : "memory" },
      auth: { configured: token },
      phone: { configured: Boolean(cfg.spug.appKey), last: phone },
      adapters: this.adapters()
    };
  }

  // ---------- 内部 ----------

  _buildPayload(cfg, signal) {
    const p = cfg.phone.titlePrefix ? `${cfg.phone.titlePrefix} ` : "";
    const rawTitle = String(signal.title || "通知");
    // 标题硬上限 32 字符，前缀会把标题挤爆时优先保标题
    const title = (p + rawTitle).length <= 32 ? p + rawTitle : rawTitle.slice(0, 32);
    return {
      title: title || "通知",
      content: String(signal.content || ""),
      source: signal.source || "unknown",
      meta: { id: signal.id || "", ts: signal.ts || "", ...(signal.meta || {}) }
    };
  }

  async _sendWithRetry(adapter, payload, ctx, retry) {
    let last = null;
    for (let attempt = 0; attempt <= retry; attempt++) {
      const t0 = Date.now();
      last = await adapter.send(payload, ctx);
      last.ms = Date.now() - t0;
      last.attempts = attempt + 1;
      if (last.ok || !last.retryable) break;
      if (attempt < retry) await sleep(Math.min(1000 * 2 ** attempt, 4000));
    }
    return last;
  }

  async _finish(info) {
    const { ok, skipped, reason, detail, signal, started, source, kind, requestId, attempts, window: win, fingerprint, force, fallback } = info;
    const ms = Date.now() - started;
    const item = await this.log.push({
      level: skipped ? "skip" : ok ? "ok" : "error",
      title: signal.title || "",
      content: signal.content || "",
      source,
      route: kind || "unknown",
      ok,
      reason: reason || "",
      detail: detail || "",
      ms,
      requestId: requestId || "",
      fingerprint: fingerprint || "",
      force: Boolean(force)
    });
    return {
      ok,
      skipped,
      reason: reason || "",
      detail: detail || "",
      requestId: requestId || "",
      attempts: attempts || 1,
      ms,
      kind: kind || "unknown",
      source,
      logId: item.id,
      window: win ? { active: win.active, detail: win.detail, now: win.now.hhmm } : null,
      fallback: fallback || null
    };
  }
}
