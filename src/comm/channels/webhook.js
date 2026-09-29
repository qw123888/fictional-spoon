import { ChannelAdapter } from "../channel.js";

/**
 * 备用/扩展通道示例：通用 Webhook
 * ------------------------------------------------------------
 * 用途一：电话接口挂掉时的兜底（配置 fallback.enabled = true）
 * 用途二：将来接新服务商时照抄这个文件改 30 行即可，不用动别的地方
 */
export class WebhookAdapter extends ChannelAdapter {
  constructor(name = "webhook", opts = {}) {
    super(name, {
      label: opts.label || "Webhook（备用通道）",
      description: opts.description || "把信号原文 POST 到指定 URL"
    });
    this.resolveUrl = opts.resolveUrl || ((cfg) => cfg.fallback.webhookUrl);
  }

  get kind() {
    return "webhook";
  }

  supports(feature) {
    return ["text"].includes(String(feature));
  }

  async send(payload, ctx) {
    const url = this.resolveUrl(ctx.config);
    if (!url) return { ok: false, retryable: false, reason: "missing_url", detail: "未配置 Webhook 地址" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ctx.config.phone.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: payload.title,
          content: payload.content,
          source: payload.source,
          ts: new Date().toISOString(),
          meta: payload.meta || {}
        }),
        signal: ctrl.signal
      });
      const text = await resp.text().catch(() => "");
      if (resp.ok) return { ok: true, reason: "sent", detail: `HTTP ${resp.status}`, raw: text.slice(0, 200) };
      return { ok: false, retryable: resp.status >= 500, reason: `http_${resp.status}`, detail: text.slice(0, 200) };
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      return { ok: false, retryable: true, reason: aborted ? "timeout" : "network", detail: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(ctx) {
    const url = this.resolveUrl(ctx.config);
    if (!url) return { ok: true, supported: true, detail: "未配置（备用通道已关闭）" };
    try {
      const resp = await fetch(url, { method: "HEAD" });
      return { ok: resp.ok || resp.status < 500, supported: true, detail: `HTTP ${resp.status}` };
    } catch (err) {
      return { ok: false, supported: true, reason: "network", detail: String((err && err.message) || err) };
    }
  }
}
