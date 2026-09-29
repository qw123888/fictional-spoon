import { fingerprintOf } from "./core/guard.js";

/**
 * 信号接收接口（电脑 → 网站）
 * ------------------------------------------------------------
 * 电脑端发过来的任何东西都先经过 normalizeSignal() 归一化，
 * 再交给主通信接口 comm.notify()。这里是唯一的入口，不允许旁路。
 *
 * 请求：POST /api/signal
 * {
 *   "kind": "phone",              // 可选，默认 phone（通道类型）
 *   "title": "Discord 新消息",     // 必填（≤32 字会被电话接口截断）
 *   "content": "作者: 内容",       // 可选
 *   "source": "discord",           // 可选，来源标识，用于日志区分
 *   "id": "1234567890",            // 可选，消息唯一 id（无 fingerprint 时用来自动去重）
 *   "force": false,                // 可选，true = 忽略时间段/去重（慎用）
 *   "ts": "2026-09-30T04:37:00Z",  // 可选
 *   "meta": {}                     // 可选，透传
 * }
 * 兼容字段：type/channel → kind，msg/text/message/body → content
 */
export function normalizeSignal(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const kind = String(raw.kind || raw.type || raw.channel || "phone").trim().toLowerCase() || "phone";
  const title = String(raw.title ?? raw.subject ?? "").trim();
  const content = String(raw.content ?? raw.msg ?? raw.text ?? raw.message ?? raw.body ?? "").trim();
  return {
    kind,
    title: title || (content ? content.slice(0, 30) : ""),
    content,
    source: String(raw.source || raw.from || "pc").trim().slice(0, 40) || "pc",
    id: raw.id !== undefined && raw.id !== null ? String(raw.id).slice(0, 80) : "",
    ts: raw.ts || new Date().toISOString(),
    force: Boolean(raw.force),
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
    fingerprint: raw.fingerprint ? String(raw.fingerprint) : ""
  };
}

export function validateSignal(signal) {
  if (!signal.title && !signal.content) {
    return { ok: false, detail: "title 与 content 不能同时为空" };
  }
  if (signal.title.length > 200 || signal.content.length > 2000) {
    return { ok: false, detail: "title/content 过长（title ≤200，content ≤2000）" };
  }
  return { ok: true, detail: "" };
}

/** 没有显式 fingerprint 时，用 source + id 或内容生成 */
export function ensureFingerprint(signal) {
  if (signal.fingerprint) return signal.fingerprint;
  if (signal.id) return fingerprintOf({ ...signal, content: "", title: "" });
  return fingerprintOf(signal);
}

/** 完整的信号处理流程：归一化 → 校验 → 交主通信接口 */
export async function handleSignal(comm, rawSignal, opts = {}) {
  const signal = normalizeSignal(rawSignal);
  const check = validateSignal(signal);
  if (!check.ok) {
    return { ok: false, skipped: true, reason: "invalid_signal", detail: check.detail, kind: signal.kind, source: signal.source, ms: 0 };
  }
  signal.fingerprint = ensureFingerprint(signal);
  return await comm.notify(signal, opts);
}
