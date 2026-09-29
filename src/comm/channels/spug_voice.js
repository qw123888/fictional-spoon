import { ChannelAdapter } from "../channel.js";

/**
 * 电话通道适配器：Spug 推送助手「语音」通道
 * ------------------------------------------------------------
 * 只负责把统一 payload 翻译成 push.spug.cc 的 xsend 请求，
 * 不做时间判断、不做去重、不做重试 —— 那些属于上层 CommModule / core 模块。
 * 换服务商（阿里云语音、Twilio…）时新增一个同 kind 的适配器即可，上层零改动。
 */
const XSEND_PATH = "/xsend";

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

export class PhoneCallAdapter extends ChannelAdapter {
  constructor() {
    super("phone", {
      label: "电话（Spug 语音）",
      description: "push.spug.cc 的 voice 通道，接通后语音播报 title + content"
    });
  }

  get kind() {
    return "phone";
  }

  supports(feature) {
    return ["voice", "text", "balance", "query"].includes(String(feature));
  }

  async send(payload, ctx) {
    const cfg = ctx.config;
    const key = cfg.spug.appKey;
    if (!key) {
      return { ok: false, retryable: false, reason: "missing_app_key", detail: "未配置 Spug App Key" };
    }

    const body = {
      title: truncate(payload.title || "通知", 32), // 官方限制 32 字符
      type: "text"
    };
    const content = truncate(payload.content || "", cfg.phone.contentLimit);
    if (content) body.content = content;

    // channel 与 targets 互斥：填了 targets 就用 targets（可跨多个推送对象）
    if (cfg.phone.targets) {
      body.targets = cfg.phone.targets;
    } else if (cfg.phone.channel) {
      body.channel = cfg.phone.channel;
    }

    const url = `${cfg.spug.baseUrl}${XSEND_PATH}/${encodeURIComponent(key)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.phone.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const text = await resp.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (resp.ok && data && Number(data.code) === 200) {
        return {
          ok: true,
          reason: "sent",
          requestId: data.request_id || "",
          detail: data.msg || "请求成功",
          raw: data
        };
      }

      const code = data ? Number(data.code) : null;
      const retryable = resp.status >= 500 || code === null || code === 500;
      return {
        ok: false,
        retryable,
        reason: `spug_${code ?? resp.status}`,
        detail: (data && data.msg) || `HTTP ${resp.status}: ${truncate(text, 150)}`,
        raw: data || truncate(text, 200)
      };
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      return {
        ok: false,
        retryable: true,
        reason: aborted ? "timeout" : "network",
        detail: aborted ? `请求超时（${cfg.phone.timeoutMs}ms）` : String((err && err.message) || err)
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 自检：故意不传 title，期望服务端返回 code=400「请求参数缺失：title」。
   * 能拿到这个响应 ⇒ 域名可达 + App Key 在路径上被正确识别，且不会真的打电话。
   */
  async probe(ctx) {
    const cfg = ctx.config;
    const key = cfg.spug.appKey;
    if (!key) return { ok: false, supported: true, detail: "未配置 Spug App Key", reason: "missing_app_key" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(cfg.phone.timeoutMs, 10000));
    const started = Date.now();
    try {
      const resp = await fetch(`${cfg.spug.baseUrl}${XSEND_PATH}/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: ctrl.signal
      });
      const data = await resp.json().catch(() => null);
      const ms = Date.now() - started;
      const code = data ? Number(data.code) : 0;
      if (code === 400) {
        return { ok: true, supported: true, detail: `接口可达（${ms}ms），App Key 格式有效`, ms, raw: data };
      }
      if (code === 401 || code === 403) {
        return { ok: false, supported: true, reason: "auth", detail: `App Key 无效或未授权：${data?.msg || resp.status}`, ms };
      }
      return {
        ok: code === 200,
        supported: true,
        reason: `spug_${code || resp.status}`,
        detail: (data && data.msg) || `HTTP ${resp.status}`,
        ms
      };
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      return { ok: false, supported: true, reason: aborted ? "timeout" : "network", detail: aborted ? "自检超时" : String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 余额 / 语音资源查询。只有开发者 Token 能查，App Key 不行。
   * 用来做「电话接口会不会打到没分钟数」的前置告警。
   */
  async balance(ctx) {
    const cfg = ctx.config;
    const token = cfg.spug.devToken;
    if (!token) {
      return {
        ok: false,
        supported: true,
        reason: "missing_dev_token",
        detail: "未配置开发者 Token（只能查余额和发送状态，App Key 不行）"
      };
    }
    const data = await this._post(cfg, "/request/balance", { token }, cfg.phone.timeoutMs);
    if (!data.ok) return { ...data, supported: true };
    const d = data.raw?.data || {};
    return {
      ok: true,
      supported: true,
      money: Number(d.money_balance ?? 0),
      voiceMinutes: Number(d.voice_resource_balance ?? 0),
      sms: Number(d.sms_resource_balance ?? 0),
      mail: Number(d.mail_resource_balance ?? 0),
      wxMp: Number(d.wx_mp_resource_balance ?? 0),
      detail: `语音剩余 ${Number(d.voice_resource_balance ?? 0)} 分钟，余额 ${Number(d.money_balance ?? 0)} 元`
    };
  }

  /** 按 request_id 查这一条通知在各个渠道的实际发送结果 */
  async query(requestId, ctx) {
    const cfg = ctx.config;
    const token = cfg.spug.devToken;
    if (!token) {
      return { ok: false, supported: true, reason: "missing_dev_token", detail: "未配置开发者 Token" };
    }
    if (!requestId) return { ok: false, supported: true, reason: "missing_request_id", detail: "缺少 request_id" };
    const data = await this._post(cfg, "/request/query", { token, request_id: requestId }, cfg.phone.timeoutMs);
    if (!data.ok) return { ...data, supported: true };
    return { ok: true, supported: true, items: data.raw?.data || [], detail: "查询成功" };
  }

  /** 给开发者 Token 类接口用的通用 POST */
  async _post(cfg, path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${cfg.spug.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const text = await resp.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      const code = data ? Number(data.code) : null;
      if (resp.ok && code === 200) {
        return { ok: true, reason: "ok", detail: data?.msg || "请求成功", raw: data };
      }
      return {
        ok: false,
        retryable: resp.status >= 500 || code === null,
        reason: `spug_${code ?? resp.status}`,
        detail: (data && data.msg) || `HTTP ${resp.status}: ${truncate(text, 150)}`,
        raw: data
      };
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      return {
        ok: false,
        retryable: true,
        reason: aborted ? "timeout" : "network",
        detail: aborted ? `请求超时（${timeoutMs}ms）` : String((err && err.message) || err)
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
