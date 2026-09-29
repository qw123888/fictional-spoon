/**
 * 配置模块
 * ------------------------------------------------------------
 * 一份默认配置 + 归一化/校验 + 读写。所有功能模块只拿"已归一化的配置对象"，
 * 不做自己的字段兜底，这样新增字段只改这一个文件。
 */
export const CONFIG_KEY = "config:v1";

export const DEFAULT_CONFIG = {
  version: 1,
  // 总开关：关掉后只有带 force=true 的信号能穿透（测试电话走 force）
  enabled: true,
  // 电话通道参数
  phone: {
    channel: "voice",        // Spug 的 channel 参数，voice = 语音电话
    targets: "",             // 推送对象编码（逗号分隔）；留空则用账号默认语音通道
    retry: 2,                // 失败重试次数（不含首次）
    timeoutMs: 15000,
    titlePrefix: "[监听器]",
    contentLimit: 120        // 语音播报内容截断长度
  },
  // 自动电话时间段
  window: {
    mode: "inside",          // inside = 仅时间段内拨打；outside = 仅时间段外拨打
    tz: "Asia/Shanghai",
    days: [0, 1, 2, 3, 4, 5, 6],   // 0=周日
    ranges: [["08:00", "23:00"]]   // 支持跨天，如 ["23:00","07:00"]
  },
  // 防轰炸（默认值按 Spug 语音通道自身的流控来定：1 次/分钟、5 次/小时、20 次/天）
  guard: {
    dedupeSeconds: 60,       // 同一条消息指纹在此秒数内只打一次
    minIntervalSeconds: 60,  // 两通电话之间最小间隔
    maxPerHour: 5,           // 每小时上限
    maxPerDay: 20            // 每天上限（Spug 语音每天最多 20 通，超了会被平台静默流控）
  },
  // 电话接口异常时的备用通道（可选，默认关）
  fallback: {
    enabled: false,
    webhookUrl: ""
  },
  // 电话接口（Spug 推送助手）连接参数；appKey 也可以走环境变量 / wrangler secret
  spug: {
    baseUrl: "https://push.spug.cc",
    appKey: "",
    // 开发者 Token：只有它能查余额/发送状态（App Key 不行），用于健康监控
    devToken: ""
  }
};

const RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return clone(base);
  if (Array.isArray(base) || typeof base !== "object") return clone(patch);
  const out = clone(base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : clone(v);
  }
  return out;
}

function normRanges(ranges) {
  if (!Array.isArray(ranges)) return clone(DEFAULT_CONFIG.window.ranges);
  const out = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const from = String(r[0]).trim();
    const to = String(r[1]).trim();
    if (!RANGE_RE.test(from) || !RANGE_RE.test(to)) continue;
    out.push([from, to]);
  }
  return out.length ? out : clone(DEFAULT_CONFIG.window.ranges);
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 把任意输入归一化成一份完整、合法的配置 */
export function normalizeConfig(input = {}) {
  const c = deepMerge(DEFAULT_CONFIG, input || {});
  c.version = 1;
  c.enabled = Boolean(c.enabled);

  c.phone.channel = String(c.phone.channel || "voice").trim() || "voice";
  c.phone.targets = String(c.phone.targets || "").trim();
  c.phone.retry = clampInt(c.phone.retry, 0, 5, 2);
  c.phone.timeoutMs = clampInt(c.phone.timeoutMs, 1000, 60000, 15000);
  c.phone.titlePrefix = String(c.phone.titlePrefix ?? "").slice(0, 32);
  c.phone.contentLimit = clampInt(c.phone.contentLimit, 20, 500, 120);

  c.window.mode = c.window.mode === "outside" ? "outside" : "inside";
  c.window.tz = String(c.window.tz || "Asia/Shanghai").trim() || "Asia/Shanghai";
  const days = Array.isArray(c.window.days)
    ? [...new Set(c.window.days.map((d) => Number.parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))]
    : [];
  c.window.days = days.length ? days.sort((a, b) => a - b) : clone(DEFAULT_CONFIG.window.days);
  c.window.ranges = normRanges(c.window.ranges);

  c.guard.dedupeSeconds = clampInt(c.guard.dedupeSeconds, 0, 86400, 60);
  c.guard.minIntervalSeconds = clampInt(c.guard.minIntervalSeconds, 0, 3600, 60);
  c.guard.maxPerHour = clampInt(c.guard.maxPerHour, 1, 500, 5);
  c.guard.maxPerDay = clampInt(c.guard.maxPerDay, 1, 2000, 20);

  c.fallback.enabled = Boolean(c.fallback.enabled);
  c.fallback.webhookUrl = String(c.fallback.webhookUrl || "").trim();

  c.spug.baseUrl = String(c.spug.baseUrl || DEFAULT_CONFIG.spug.baseUrl).replace(/\/+$/, "");
  c.spug.appKey = String(c.spug.appKey || "").trim();
  c.spug.devToken = String(c.spug.devToken || "").trim();

  return c;
}

/** 只把允许前端改的字段合并进来（防止前端塞乱七八糟的东西进库） */
export function mergeClientPatch(current, patch = {}) {
  const allow = ["enabled", "phone", "window", "guard", "fallback", "spug"];
  const picked = {};
  for (const k of allow) {
    if (patch[k] !== undefined) picked[k] = patch[k];
  }
  // baseUrl / appKey 允许为空，但不能被非字符串覆盖
  return normalizeConfig(deepMerge(current, picked));
}

export async function loadConfig(store, env = {}) {
  const cfg = await loadStoredConfig(store);
  // 环境变量优先（wrangler secret / .dev.vars 里配的凭据不落地到 KV）
  if (env.SPUG_BASE_URL) cfg.spug.baseUrl = String(env.SPUG_BASE_URL).replace(/\/+$/, "");
  if (env.SPUG_APP_KEY) cfg.spug.appKey = String(env.SPUG_APP_KEY).trim();
  if (env.SPUG_DEV_TOKEN) cfg.spug.devToken = String(env.SPUG_DEV_TOKEN).trim();
  if (env.SPUG_CHANNEL) cfg.phone.channel = String(env.SPUG_CHANNEL).trim();
  return cfg;
}

/** 只读库里的配置（不含环境变量覆盖），用于保存时做合并基线，避免把 env 里的密钥写进 KV */
export async function loadStoredConfig(store) {
  const saved = await store.get(CONFIG_KEY, null);
  return normalizeConfig(saved || {});
}

export async function saveConfig(store, cfg) {
  await store.set(CONFIG_KEY, cfg);
  return cfg;
}
