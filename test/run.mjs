/**
 * 端到端测试（不需要网络、不会真实拨号）
 * ------------------------------------------------------------
 * 直接调用 src/index.js 的 handleApi()，把全局 fetch 换成 Mock，
 * 覆盖：鉴权、配置读写、信号流水线、时间段、去重/限流/配额、重试、备用通道。
 * 运行：npm test
 */
import { handleApi, createApp } from "../src/index.js";
import { evaluateWindow, zonedParts, hitRange } from "../src/core/window.js";
import { normalizeConfig } from "../src/core/config.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label} ${extra}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

/* ---------------- 测试替身 ---------------- */
function memoryKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    }
  };
}

const mock = {
  phoneQueue: [],
  phoneCalls: [],
  webhookCalls: [],
  balanceCalls: [],
  queryCalls: [],
  reset() {
    this.phoneQueue = [];
    this.phoneCalls = [];
    this.webhookCalls = [];
    this.balanceCalls = [];
    this.queryCalls = [];
  }
};

function installFetchMock() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.includes("mock-spug.local/xsend/")) {
      mock.phoneCalls.push({ url: u, body });
      const next = mock.phoneQueue.shift() || { status: 200, json: { code: 200, msg: "请求成功", request_id: "REQ_TEST" } };
      return new Response(JSON.stringify(next.json), { status: next.status, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("mock-spug.local/request/balance")) {
      mock.balanceCalls.push({ url: u, body });
      return new Response(
        JSON.stringify({
          code: 200,
          msg: "查询成功",
          data: { money_balance: 0.0, sms_resource_balance: 2, voice_resource_balance: 16, mail_resource_balance: 10, wx_mp_resource_balance: 100 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (u.includes("mock-spug.local/request/query")) {
      mock.queryCalls.push({ url: u, body });
      return new Response(
        JSON.stringify({ code: 200, msg: "请求成功", data: [{ channel: "voice", status: "发送成功" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (u.includes("hook.local")) {
      mock.webhookCalls.push({ url: u, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`测试未预期的请求：${u}`);
  };
}

function makeRequest(path, { method = "GET", body, token, hostname = "site.local", headers: extra } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-auth-token"] = token;
  Object.assign(headers, extra || {});
  return new Request(`https://${hostname}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const TOKEN = "test-token-123";
const ENV = {
  NOTIFY_KV: memoryKV(),
  SPUG_APP_KEY: "ak_test_key",
  SPUG_DEV_TOKEN: "dev_token_test",
  SPUG_BASE_URL: "https://mock-spug.local",
  SIGNAL_TOKEN: TOKEN
};

async function call(path, opts = {}) {
  const resp = await handleApi(makeRequest(path, { ...opts, token: opts.token === undefined ? TOKEN : opts.token }), ENV);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { status: resp.status, data };
}

async function setConfig(patch) {
  const r = await call("/api/config", { method: "POST", body: patch });
  if (!r.data || !r.data.ok) throw new Error(`设置配置失败：${JSON.stringify(r.data)}`);
  return r.data;
}

/** 清掉限流/去重额度，让每组用例从零开始（小时内计数是全局共享的） */
async function resetQuota() {
  for (const key of [...ENV.NOTIFY_KV.map.keys()]) {
    if (key.startsWith("guard:")) ENV.NOTIFY_KV.map.delete(key);
  }
}

function todayInTz(tz) {
  return zonedParts(new Date(), tz).weekday;
}

/* ---------------- 测试用例 ---------------- */
async function testWindowModule() {
  console.log("\n[1] 时间段模块");
  const cfg = normalizeConfig({ window: { mode: "inside", tz: "Asia/Shanghai", days: [0, 1, 2, 3, 4, 5, 6], ranges: [["08:00", "23:00"]] } });

  const d = new Date("2026-09-30T02:00:00Z"); // 北京时间 10:00 周三
  const r1 = evaluateWindow(cfg, d);
  ok(r1.active, "10:00 在 08:00-23:00 内 → 允许拨打", JSON.stringify(r1));
  eq(r1.now.hhmm, "10:00", "时区换算正确（UTC 02:00 → 北京 10:00）");

  const r2 = evaluateWindow(cfg, new Date("2026-09-30T16:30:00Z")); // 北京 00:30
  ok(!r2.active, "北京时间 00:30 → 不在时间段，跳过", JSON.stringify(r2));

  const overnight = normalizeConfig({ window: { mode: "inside", tz: "Asia/Shanghai", days: [0, 1, 2, 3, 4, 5, 6], ranges: [["23:00", "07:00"]] } });
  ok(evaluateWindow(overnight, new Date("2026-09-30T16:30:00Z")).active, "跨天区间 23:00→07:00 命中 00:30");
  ok(evaluateWindow(overnight, new Date("2026-09-30T02:00:00Z")).active === false, "跨天区间不命中 10:00");

  const outside = normalizeConfig({ window: { mode: "outside", tz: "Asia/Shanghai", days: [0, 1, 2, 3, 4, 5, 6], ranges: [["08:00", "23:00"]] } });
  ok(evaluateWindow(outside, new Date("2026-09-30T02:00:00Z")).active === false, "outside 模式：时间段内 → 不拨打");
  ok(evaluateWindow(outside, new Date("2026-09-30T16:30:00Z")).active, "outside 模式：时间段外 → 拨打");

  ok(hitRange(0, ["23:00", "07:00"]), "hitRange 跨天边界：00:00 命中");
  ok(!hitRange(420, ["23:00", "07:00"]), "hitRange 跨天边界：07:00 不命中（右开）");

  const onlyWed = normalizeConfig({ window: { mode: "inside", tz: "Asia/Shanghai", days: [3], ranges: [["00:00", "23:59"]] } });
  ok(evaluateWindow(onlyWed, new Date("2026-09-30T02:00:00Z")).active, "周三 10:00 → 命中（只勾周三）");
  ok(evaluateWindow(onlyWed, new Date("2026-10-01T02:00:00Z")).active === false, "周四 10:00 → 不命中（只勾周三）");
}

async function testAuthAndConfig() {
  console.log("\n[2] 鉴权与配置接口");
  const ping = await call("/api/ping");
  eq(ping.data.ok, true, "GET /api/ping 无需令牌");

  const noToken = await handleApi(makeRequest("/api/config"), ENV);
  eq(noToken.status, 401, "无令牌访问 /api/config → 401");

  const badToken = await handleApi(makeRequest("/api/config", { token: "wrong" }), ENV);
  eq(badToken.status, 401, "错误令牌 → 401");

  const good = await call("/api/config");
  eq(good.data.ok, true, "正确令牌 → 200");
  eq(good.data.config.spug.appKey.includes("***"), true, "响应里 App Key 被掩码");
  eq(good.data.hasAppKey, true, "hasAppKey = true");
  eq(good.data.config.spug.devToken.includes("***"), true, "响应里开发者 Token 也被掩码");
  eq(good.data.hasDevToken, true, "hasDevToken = true");

  await setConfig({ guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 }, spug: { appKey: "ak_test_key" } });
  const after = await call("/api/config");
  eq(after.data.config.guard.maxPerHour, 50, "配置保存生效（maxPerHour=50）");

  const maskedKept = await setConfig({ spug: { appKey: after.data.config.spug.appKey } });
  const check = await call("/api/config");
  eq(check.data.hasAppKey, true, "提交掩码值不会清空真实 App Key");
  ok(maskedKept.ok, "掩码回传保存成功");
}

async function testSignalPipeline() {
  console.log("\n[3] 信号流水线（收到信号 → 处理 → 调电话接口）");
  const tz = "Asia/Shanghai";
  const today = todayInTz(tz);
  const tomorrow = (today + 1) % 7;

  // 3.1 时间段外 → 跳过，不打接口
  mock.reset();
  await setConfig({ enabled: true, window: { mode: "inside", tz, days: [tomorrow], ranges: [["00:00", "23:59"]] }, guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 }, fallback: { enabled: false } });
  const skipped = await call("/api/signal", { method: "POST", body: { title: "时间段外", content: "不应拨号", source: "test" } });
  eq(skipped.data.skipped, true, "时间段外 → skipped=true");
  eq(skipped.data.reason, "outside_window", "原因 = outside_window");
  eq(mock.phoneCalls.length, 0, "时间段外未调用电话接口");

  // 3.2 时间段内 → 真正调用
  mock.reset();
  await setConfig({ window: { mode: "inside", tz, days: [today], ranges: [["00:00", "23:59"]] } });
  const sent = await call("/api/signal", { method: "POST", body: { title: "Discord 新消息", content: "有人 @all", source: "discord", id: "msg-1" } });
  eq(sent.data.ok, true, "时间段内 → 发送成功");
  eq(sent.data.requestId, "REQ_TEST", "返回 request_id");
  eq(mock.phoneCalls.length, 1, "电话接口被调用 1 次");
  eq(mock.phoneCalls[0].body.channel, "voice", "请求体 channel=voice");
  eq(mock.phoneCalls[0].body.title.length <= 32, true, "标题 ≤32 字符");
  ok(mock.phoneCalls[0].url.endsWith("ak_test_key"), "App Key 走路径段");

  // 3.3 总开关关闭
  mock.reset();
  await setConfig({ enabled: false });
  const disabled = await call("/api/signal", { method: "POST", body: { title: "关掉开关", content: "x", source: "test" } });
  eq(disabled.data.reason, "disabled", "总开关关闭 → disabled");
  eq(mock.phoneCalls.length, 0, "总开关关闭未调用接口");
  await setConfig({ enabled: true });

  // 3.4 force 穿透
  mock.reset();
  const forced = await call("/api/signal", { method: "POST", body: { title: "强制", content: "force", source: "test", force: true } });
  eq(forced.data.ok, true, "force=true 穿透时间段限制");

  // 3.5 去重
  mock.reset();
  await resetQuota();
  await setConfig({ guard: { dedupeSeconds: 120, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 } });
  const a = await call("/api/signal", { method: "POST", body: { title: "重复消息", content: "同一条", source: "discord", id: "dup-1" } });
  const b = await call("/api/signal", { method: "POST", body: { title: "重复消息", content: "同一条", source: "discord", id: "dup-1" } });
  eq(a.data.ok, true, "第一条去重信号发送成功");
  eq(b.data.reason, "duplicate", "第二条同 id 信号 → duplicate");
  eq(mock.phoneCalls.length, 1, "去重后只调用接口 1 次");

  const c = await call("/api/signal", { method: "POST", body: { title: "重复消息", content: "同一条", source: "discord", id: "dup-1", force: true } });
  eq(c.data.ok, true, "force 可穿透去重");

  // 3.6 最小间隔
  mock.reset();
  await resetQuota();
  await setConfig({ guard: { dedupeSeconds: 0, minIntervalSeconds: 300, maxPerHour: 50, maxPerDay: 500 } });
  const first = await call("/api/signal", { method: "POST", body: { title: "间隔1", content: "a", source: "test" } });
  const second = await call("/api/signal", { method: "POST", body: { title: "间隔2", content: "b", source: "test" } });
  eq(first.data.ok, true, "第一通电话成功");
  eq(second.data.reason, "rate_limited", "紧接的第二通 → rate_limited");
  eq(mock.phoneCalls.length, 1, "最小间隔生效，只调用 1 次");

  // 3.7 每小时配额
  mock.reset();
  await resetQuota();
  await setConfig({ guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 2 } });
  await call("/api/signal", { method: "POST", body: { title: "配额1", content: "1", source: "test" } });
  await call("/api/signal", { method: "POST", body: { title: "配额2", content: "2", source: "test" } });
  const third = await call("/api/signal", { method: "POST", body: { title: "配额3", content: "3", source: "test" } });
  eq(third.data.reason, "hourly_quota", "第三通 → hourly_quota");
  eq(mock.phoneCalls.length, 2, "配额上限 2 生效");

  // 3.8 每天配额（对齐 Spug 语音 20 通/天）
  mock.reset();
  await resetQuota();
  await setConfig({ guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 500, maxPerDay: 2 } });
  await call("/api/signal", { method: "POST", body: { title: "日配额1", content: "1", source: "test" } });
  await call("/api/signal", { method: "POST", body: { title: "日配额2", content: "2", source: "test" } });
  const overDay = await call("/api/signal", { method: "POST", body: { title: "日配额3", content: "3", source: "test" } });
  eq(overDay.data.reason, "daily_quota", "超出每天上限 → daily_quota");
  eq(mock.phoneCalls.length, 2, "每天上限 2 生效");
  const h = await call("/api/health");
  eq(h.data.guard.usedToday, 2, "health 反映今日已拨 2 通");
  eq(h.data.guard.maxPerDay, 2, "health 反映每天上限");

  // 3.9 默认值对齐 Spug 流控
  const defaults = normalizeConfig({});
  eq(defaults.guard.minIntervalSeconds, 60, "默认最小间隔 60s（Spug 1 通/分钟）");
  eq(defaults.guard.maxPerHour, 5, "默认每小时 5 通（Spug 5 通/小时）");
  eq(defaults.guard.maxPerDay, 20, "默认每天 20 通（Spug 20 通/天）");

  // 3.10 参数校验
  await setConfig({ guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 } });
  const invalid = await call("/api/signal", { method: "POST", body: {} });
  eq(invalid.data.reason, "invalid_signal", "空信号 → invalid_signal");
}

async function testFailureAndFallback() {
  console.log("\n[4] 失败处理：重试 / 不可重试 / 备用通道");
  const tz = "Asia/Shanghai";
  const today = todayInTz(tz);
  await setConfig({
    enabled: true,
    window: { mode: "inside", tz, days: [today], ranges: [["00:00", "23:59"]] },
    guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 },
    phone: { retry: 2, timeoutMs: 5000 },
    fallback: { enabled: false }
  });

  // 4.1 5xx 可重试：500 → 500 → 200
  mock.reset();
  mock.phoneQueue = [
    { status: 500, json: { code: 500, msg: "服务端错误" } },
    { status: 500, json: { code: 500, msg: "服务端错误" } },
    { status: 200, json: { code: 200, msg: "请求成功", request_id: "REQ_RETRY" } }
  ];
  const retried = await call("/api/signal", { method: "POST", body: { title: "重试", content: "retry", source: "test" } });
  eq(retried.data.ok, true, "两次 500 后重试成功");
  eq(retried.data.attempts, 3, "共尝试 3 次");
  eq(mock.phoneCalls.length, 3, "电话接口被调用 3 次");

  // 4.2 业务错误不重试：code=400
  mock.reset();
  mock.phoneQueue = [{ status: 200, json: { code: 400, msg: "指定渠道未开启" } }];
  const badCode = await call("/api/signal", { method: "POST", body: { title: "业务错误", content: "x", source: "test" } });
  eq(badCode.data.ok, false, "code=400 → ok=false");
  eq(badCode.data.reason, "spug_400", "原因 = spug_400");
  eq(badCode.status, 200, "发送失败仍返回 HTTP 200（用 502 会被 Cloudflare 边缘吞掉响应体）");
  eq(mock.phoneCalls.length, 1, "业务错误不重试（仅 1 次）");
  ok(badCode.data.detail.includes("指定渠道未开启"), "错误信息透传（detail 带服务端 msg）");

  // 4.2b 未配置 App Key 也是干净的 200 + reason（注意：env 里的 SPUG_APP_KEY 优先级高于库里的配置）
  const savedAppKey = ENV.SPUG_APP_KEY;
  delete ENV.SPUG_APP_KEY;
  await setConfig({ spug: { appKey: "" } });
  mock.reset();
  const noKey = await call("/api/test-call", { method: "POST", body: {} });
  eq(noKey.status, 200, "未配 App Key 的测试电话 → HTTP 200");
  eq(noKey.data.reason, "missing_app_key", "原因 = missing_app_key");
  eq(mock.phoneCalls.length, 0, "没有 App Key 时不会真的发请求");
  ENV.SPUG_APP_KEY = savedAppKey;
  await setConfig({ spug: { appKey: "ak_test_key" } });

  // 4.3 失败后走备用通道
  mock.reset();
  mock.phoneQueue = [{ status: 200, json: { code: 400, msg: "无符合条件个人渠道" } }];
  await setConfig({ fallback: { enabled: true, webhookUrl: "https://hook.local/notify" } });
  const withFallback = await call("/api/signal", { method: "POST", body: { title: "兜底", content: "fallback", source: "test" } });
  eq(withFallback.data.ok, false, "电话失败 ok=false");
  eq(withFallback.data.fallback && withFallback.data.fallback.ok, true, "备用 Webhook 成功");
  eq(mock.webhookCalls.length, 1, "Webhook 被调用 1 次");

  // 4.4 网络异常
  mock.reset();
  globalThis.fetch = async (url) => {
    if (String(url).includes("mock-spug.local")) throw new Error("connection reset");
    return new Response("{}", { status: 200 });
  };
  const netErr = await call("/api/signal", { method: "POST", body: { title: "网络异常", content: "reset", source: "test" } });
  eq(netErr.data.ok, false, "网络异常 → ok=false");
  eq(netErr.data.reason, "network", "原因 = network");
  installFetchMock();

  // 4.5 自检（不会拨号）
  mock.reset();
  mock.phoneQueue = [{ status: 200, json: { code: 400, msg: "请求参数缺失：title" } }];
  const probe = await call("/api/probe", { method: "POST", body: { kind: "phone" } });
  eq(probe.data.ok, true, "自检：拿到 400 参数缺失 → 接口可达");
  eq(mock.phoneCalls[0].body.title, undefined, "自检请求体不含 title（不会真拨号）");

  // 4.6 资源查询 / 发送状态（只能靠开发者 Token）
  mock.reset();
  const bal = await call("/api/balance");
  eq(bal.status, 200, "GET /api/balance → 200");
  eq(bal.data.ok, true, "余额查询成功");
  eq(bal.data.voiceMinutes, 16, "解析出剩余语音 16 分钟");
  eq(bal.data.money, 0, "解析出余额 0 元");
  eq(mock.balanceCalls.length, 1, "确实调了一次 /request/balance");
  eq(mock.balanceCalls[0].body.token, "dev_token_test", "查询用的是开发者 Token（环境变量）");
  eq(mock.phoneCalls.length, 0, "查余额不会触发任何拨号请求");

  const st = await call("/api/status?requestId=REQ_TEST");
  eq(st.data.ok, true, "按 request_id 查发送状态成功");
  eq(st.data.items.length, 1, "返回 1 条通道结果");
  eq(mock.queryCalls[0].body.request_id, "REQ_TEST", "request_id 正确透传");
  eq(mock.queryCalls[0].body.token, "dev_token_test", "查询用的是开发者 Token");

  const stNoId = await call("/api/status");
  eq(stNoId.data.ok, false, "缺 request_id → 失败");
  eq(stNoId.data.reason, "missing_request_id", "原因 = missing_request_id");

  const balNoAuth = await call("/api/balance", { token: "" });
  eq(balNoAuth.status, 401, "无令牌查余额 → 401");

  // 没配开发者 Token 时给出可读提示而不是崩
  const savedDev = ENV.SPUG_DEV_TOKEN;
  ENV.SPUG_DEV_TOKEN = "";
  const balMissing = await call("/api/balance");
  eq(balMissing.data.ok, false, "无开发者 Token → ok=false");
  eq(balMissing.data.reason, "missing_dev_token", "原因 = missing_dev_token");
  ENV.SPUG_DEV_TOKEN = savedDev;
  installFetchMock();
}

async function testHealthAndLogs() {
  console.log("\n[5] 健康状态与日志");
  await setConfig({ fallback: { enabled: false }, guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 } });
  const health = await call("/api/health");
  eq(health.data.ok, true, "GET /api/health 正常");
  eq(health.data.storage.backend, "cloudflare-kv", "识别出 KV 后端");
  ok(typeof health.data.window.detail === "string" && health.data.window.detail.length > 0, "时间段描述非空");
  ok(Array.isArray(health.data.adapters) && health.data.adapters.some((a) => a.kind === "phone"), "通道列表含 phone");

  const logs = await call("/api/logs?limit=10");
  eq(logs.data.ok, true, "GET /api/logs 正常");
  ok(logs.data.items.length > 0, "日志里有记录");
  ok(logs.data.stats.total > 0, "统计计数 > 0");
  const sample = logs.data.items[0];
  ok("iso" in sample && "level" in sample && "source" in sample, "日志字段齐全");

  await call("/api/logs/clear", { method: "POST" });
  const cleared = await call("/api/logs?limit=10");
  eq(cleared.data.items.length, 0, "清空日志生效");

  const notFound = await call("/api/nope");
  eq(notFound.status, 404, "未知接口 → 404");
}

async function testModuleBoundary() {
  console.log("\n[6] 模块边界（扩展方式）");
  const { comm } = createApp(ENV);
  const adapters = comm.adapters().map((a) => a.kind);
  ok(adapters.includes("phone") && adapters.includes("webhook"), "默认注册 phone + webhook 两个适配器");

  const fake = {
    name: "dummy",
    kind: "dummy",
    label: "假通道",
    description: "测试用",
    describe() {
      return { name: this.name, kind: this.kind, label: this.label, description: this.description };
    },
    async send() {
      return { ok: true, reason: "sent", detail: "dummy ok", requestId: "DUMMY" };
    },
    async probe() {
      return { ok: true, supported: true, detail: "dummy probe" };
    }
  };
  // 注册要求是 ChannelAdapter 实例
  let rejected = false;
  try {
    comm.register(fake);
  } catch {
    rejected = true;
  }
  ok(rejected, "非 ChannelAdapter 实例会被 register() 拒绝");

  const { ChannelAdapter } = await import("../src/comm/channel.js");
  class DummyAdapter extends ChannelAdapter {
    constructor() {
      super("dummy", { label: "假通道" });
    }
    get kind() {
      return "dummy";
    }
    async send() {
      return { ok: true, reason: "sent", detail: "dummy ok", requestId: "DUMMY" };
    }
  }
  comm.register(new DummyAdapter());
  const result = await comm.notify({ kind: "dummy", title: "扩展通道", content: "hello", source: "test", force: true }, { force: true });
  eq(result.ok, true, "注册新适配器后，notify(kind=dummy) 可用（无需改 CommModule）");
  eq(result.kind, "dummy", "结果里带通道类型");

  const unknown = await comm.notify({ kind: "not-exist", title: "x", source: "test" });
  eq(unknown.reason, "unknown_channel", "未知通道 → unknown_channel");
}

/** 假 Cache API：模拟"没绑 KV 时的边缘缓存兜底" */
function fakeCaches() {
  const map = new Map();
  const url = (req) => (typeof req === "string" ? req : req.url);
  return {
    map,
    default: {
      async match(req) {
        const u = url(req);
        if (!map.has(u)) return undefined;
        return new Response(map.get(u), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      },
      async put(req, resp) {
        map.set(url(req), await resp.text());
      },
      async delete(req) {
        map.delete(url(req));
      }
    }
  };
}

async function callWith(env, path, opts = {}) {
  const resp = await handleApi(makeRequest(path, { ...opts, token: opts.token === undefined ? TOKEN : opts.token }), env);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { status: resp.status, data };
}

async function testWindowSwitchAndPersistence() {
  console.log("\n[7] 时间段总开关 + 配置持久化（“保存没反应”回归）");

  // 7.1 默认值：开关默认开
  const def = normalizeConfig({});
  eq(def.window.enabled, true, "时间段开关默认开启");
  eq(normalizeConfig({ window: { enabled: false } }).window.enabled, false, "显式关闭能保留");

  // 7.2 关掉开关 → 任何时间都可拨打
  const tz = "Asia/Shanghai";
  const tomorrow = (todayInTz(tz) + 1) % 7;
  const offCfg = normalizeConfig({ window: { enabled: false, mode: "inside", tz, days: [tomorrow], ranges: [["00:00", "23:59"]] } });
  const w = evaluateWindow(offCfg, new Date());
  ok(w.active, "开关关闭：时间段不命中也允许拨打", JSON.stringify(w));
  eq(w.reason, "window_disabled", "原因 = window_disabled");
  eq(w.disabled, true, "结果里 disabled=true");
  ok(w.detail.includes("任何时间"), `detail 说明了原因：${w.detail}`);

  const onCfg = normalizeConfig({ window: { enabled: true, mode: "inside", tz, days: [tomorrow], ranges: [["00:00", "23:59"]] } });
  eq(evaluateWindow(onCfg, new Date()).active, false, "开关打开时，同一份时间段配置照旧拦截");

  // 7.3 走真实信号接口：开关关闭 → 真的拨号
  mock.reset();
  await resetQuota();
  await setConfig({ enabled: true, window: { enabled: false, mode: "inside", tz, days: [tomorrow], ranges: [["00:00", "23:59"]] }, guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 } });
  const sent = await call("/api/signal", { method: "POST", body: { title: "开关关闭后的信号", content: "应当直接拨打", source: "test", id: "win-off-1" } });
  eq(sent.data.ok, true, "开关关闭 → 信号直接拨打成功");
  eq(mock.phoneCalls.length, 1, "电话接口被调用 1 次");
  const back = await call("/api/config");
  eq(back.data.config.window.enabled, false, "GET /api/config 能读回 window.enabled=false");

  // 7.4 绑了 KV：保存 → 立刻读回（治“刷新要重填”）
  mock.reset();
  await setConfig({ window: { enabled: true }, guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 7, maxPerDay: 37 } });
  const readback = await call("/api/config");
  eq(readback.data.storage.backend, "cloudflare-kv", "有 KV 时 backend=cloudflare-kv");
  eq(readback.data.storage.durable, true, "durable=true");
  eq(readback.data.config.guard.maxPerDay, 37, "保存后重新 GET 仍是新值（maxPerDay=37）");
  eq(readback.data.config.guard.maxPerHour, 7, "maxPerHour=7 也读得回来");
  const health1 = await call("/api/health");
  eq(health1.data.storage.label, "KV 持久化", "health 里给出人话标签");
  eq(health1.data.window.enabled, true, "health.window.enabled 透出开关状态");

  // 7.5 没绑 KV 也没缓存：如实报错，不许骗人
  const savedCaches = globalThis.caches;
  try {
    delete globalThis.caches;
    const envNoStore = { ...ENV };
    delete envNoStore.NOTIFY_KV;
    const bad = await callWith(envNoStore, "/api/config", { method: "POST", body: { guard: { maxPerDay: 99 } } });
    eq(bad.data.ok, false, "存不住时 ok=false（不再假装成功）");
    eq(bad.data.error, "not_persisted", "error = not_persisted");
    eq(bad.data.storage.backend, "memory", "storage.backend = memory");
    ok(String(bad.data.detail).includes("KV"), "给出绑定 KV 的提示");
    const reread = await callWith(envNoStore, "/api/config");
    ok(reread.data.config.guard.maxPerDay !== 99, "内存后端确实读不回新值（复现用户看到的“刷新就重填”）");

    // 7.6 边缘缓存兜底：不绑 KV 也能存住（只在自定义域名 / Pages 上真有效）
    globalThis.caches = fakeCaches();
    const ec = await callWith(envNoStore, "/api/config", { method: "POST", body: { guard: { maxPerDay: 42 } } });
    eq(ec.data.ok, true, "边缘缓存模式下保存成功");
    eq(ec.data.persisted, true, "persisted=true（真的读回来了）");
    eq(ec.data.storage.backend, "edge-cache", "storage.backend = edge-cache");
    eq(ec.data.durable, false, "durable=false：如实说明不是真持久");
    ok(String(ec.data.warning).includes("KV"), "非持久后端给一句“建议绑 KV”的提醒");
    const ecRead = await callWith(envNoStore, "/api/config");
    eq(ecRead.data.config.guard.maxPerDay, 42, "下一次请求（新 isolate/新 store）仍能读到 42");
    ok(String(ec.data.storage.label).includes("缓存"), "标签说明用的是边缘缓存");

    // 7.7 *.workers.dev 上 Cache API 不生效（Cloudflare 文档明确写了），
    //     所以不能假装有缓存兜底，必须判成内存 + 如实提示
    const wd = await callWith(envNoStore, "/api/config", {
      method: "POST",
      body: { guard: { maxPerDay: 55 } },
      hostname: "demo.workers.dev"
    });
    eq(wd.data.ok, false, "workers.dev 上没有 KV 时保存不假装成功");
    eq(wd.data.error, "not_persisted", "error = not_persisted");
    eq(wd.data.storage.backend, "memory", "workers.dev → backend=memory（不吹 edge-cache）");
    eq(wd.data.storage.cacheUnusable, true, "storage.cacheUnusable=true");
    ok(String(wd.data.storage.label).includes("workers.dev"), "标签直说 Cache API 在 workers.dev 不生效");
    ok(String(wd.data.detail).includes("NOTIFY_KV"), "detail 里写了要绑的变量名");
  } finally {
    if (savedCaches === undefined) delete globalThis.caches;
    else globalThis.caches = savedCaches;
    delete globalThis.caches?.__fake;
  }

  // 收尾：恢复一份宽松配置，别影响后面的用例
  mock.reset();
  await resetQuota();
  await setConfig({ enabled: true, window: { enabled: true, mode: "inside", tz, days: [0, 1, 2, 3, 4, 5, 6], ranges: [["00:00", "23:59"]] }, guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 } });
}

/* ---------------- [8] 总开关 ---------------- */
async function testMasterSwitch() {
  console.log("\n[8] 总开关接口（一键开/关，只动 enabled）");
  mock.reset();
  await resetQuota();
  await setConfig({
    enabled: true,
    window: { enabled: true, mode: "inside", tz: "Asia/Shanghai", days: [0, 1, 2, 3, 4, 5, 6], ranges: [["00:00", "23:59"]] },
    guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50, maxPerDay: 500 },
    phone: { channel: "voice", targets: "", retry: 0, timeoutMs: 15000, titlePrefix: "[监听器]", contentLimit: 120 }
  });

  // 8.1 读状态
  const st = await call("/api/switch", { method: "GET" });
  eq(st.data.ok, true, "GET /api/switch 可用");
  eq(st.data.enabled, true, "默认开着");

  // 8.2 关掉：只改 enabled，其它字段一个都不许动
  const off = await call("/api/switch", { method: "POST", body: { on: false } });
  eq(off.data.ok, true, "POST on:false 成功");
  eq(off.data.enabled, false, "返回新状态：已关闭");
  eq(off.data.changed, true, "changed=true");
  eq(off.data.persisted, true, "写进存储并回读校验通过");
  eq(off.data.durable, true, "KV 上是持久化的");

  const afterOff = await call("/api/config");
  eq(afterOff.data.config.enabled, false, "独立 GET 读回来确实是关闭状态");
  eq(afterOff.data.config.phone.contentLimit, 120, "顺手确认没把整份配置冲掉（contentLimit 还在）");
  eq(afterOff.data.config.guard.maxPerDay, 500, "防轰炸设置也没被动过");

  const hOff = await call("/api/health");
  eq(hOff.data.enabled, false, "/api/health 也反映关闭状态（界面顶栏据此回填）");

  // 8.3 关掉时信号被拒（force 才穿透）
  const sig = await call("/api/signal", { method: "POST", body: { title: "总开关关闭时的信号", content: "不该拨号", source: "test" } });
  eq(sig.data.skipped, true, "总开关关闭 → 信号被跳过而不是拨号");
  eq(sig.data.reason, "disabled", "reason = disabled");
  eq(mock.phoneCalls.length, 0, "确实一通都没拨");
  const forced = await call("/api/signal", { method: "POST", body: { title: "强制信号", content: "force 穿透", force: true } });
  ok(forced.data.ok, "force 信号仍然穿透（测试电话走的就是 force）");
  eq(mock.phoneCalls.length, 1, "force 那一通拨出去了");

  // 8.4 toggle 取反 + enabled/value 两种别名
  const t1 = await call("/api/switch", { method: "POST", body: { toggle: true } });
  eq(t1.data.enabled, true, "toggle 从关闭 → 开启");
  eq(t1.data.changed, true, "changed=true");
  const t2 = await call("/api/switch", { method: "POST", body: { enabled: false } });
  eq(t2.data.enabled, false, "别名 enabled:false 也认");
  const t3 = await call("/api/switch", { method: "POST", body: { on: false } });
  eq(t3.data.changed, false, "重复同一个值 → changed=false（界面提示「状态没变」）");

  // 8.5 参数缺失要报清楚，而不是静默当 false
  const bad = await call("/api/switch", { method: "POST", body: {} });
  eq(bad.status, 400, "空 body → 400");
  eq(bad.data.error, "bad_param", "error=bad_param");
  eq((await call("/api/switch", { method: "GET" })).data.enabled, false, "参数错误不会改状态");

  // 8.6 没令牌就切不动
  const noTok = await call("/api/switch", { method: "POST", body: { on: true }, token: "" });
  eq(noTok.status, 401, "不带令牌 → 401");
  eq((await call("/api/switch", { method: "GET" })).data.enabled, false, "401 时状态原封不动");

  // 8.7 总开关也要记录到日志（谁什么时候关的，得查得到）
  const logs = await call("/api/logs?limit=20");
  const hit = (logs.data.items || []).find((x) => String(x.title).includes("总开关"));
  ok(hit, "切换动作进了日志表");
  ok(!hit.ok, "关闭那次的日志记成非成功状态");
  ok(String(hit.detail).includes("force"), "日志里写清楚关闭后只有 force 能穿透");

  // 8.8 没有可持久化存储时不许假装切成功
  const envNoStore = { SPUG_APP_KEY: "ak_test_key", SIGNAL_TOKEN: TOKEN };
  const wd = await handleApi(makeRequest("/api/switch", { method: "POST", body: { on: false }, token: TOKEN, hostname: "demo.workers.dev" }), envNoStore);
  const wdData = await wd.json();
  eq(wdData.ok, false, "workers.dev 无 KV → 不假装成功");
  eq(wdData.error, "not_persisted", "error=not_persisted");
  eq(wdData.changed, false, "changed=false");
  ok(String(wdData.detail).includes("NOTIFY_KV"), "detail 里写了要绑的变量名");

  // 收尾
  await setConfig({ enabled: true });
  mock.reset();
  await resetQuota();
}

/* ---------------- [9] 电脑端拨号模式（Spug IP 白名单）---------------- */
async function testPcDialMode() {
  console.log("\n[9] 电脑端拨号：网站只排队，由电脑直连 Spug");
  await resetQuota();
  mock.reset();
  await setConfig({ phone: { dialVia: "site" }, fallback: { enabled: false } });

  // --- 1) 默认：网站自己拨 ---
  let r = await call("/api/test-call", { method: "POST", body: { title: "网站直拨" } });
  eq(r.data.queued, false, "site 模式：不是排队");
  eq(mock.phoneCalls.length, 1, "site 模式：Spug 侧收到 1 次拨号请求");
  eq(r.data.ok, true, "site 模式：直接成功");

  // --- 2) 切到电脑端拨号 ---
  await setConfig({ phone: { dialVia: "pc" } });
  let cfg = await call("/api/config");
  eq(cfg.data.config.phone.dialVia, "pc", "配置里记下了 dialVia=pc");
  let h = await call("/api/health");
  eq(h.data.phone.dialVia, "pc", "健康接口报出当前拨打方式");
  eq(h.data.phone.executor.online, false, "还没有执行器来领过任务 → 离线");

  // 电脑端带自己的信息问一次（还没有任务）
  let box = await call("/api/outbox", { headers: { "x-forwarded-for": "182.46.51.186" } });
  eq(box.data.mode, "pc", "队列接口报出 pc 模式");
  eq(box.data.tasks.length, 0, "空队列");
  eq(box.data.seenIp, "182.46.51.186", "记录下执行器的来源 IP（心跳 IP）");
  eq(box.data.executor.online, true, "心跳后执行器在线");
  eq(box.data.executor.ip, "182.46.51.186", "执行器的心跳 IP 存下来了");
  eq(box.data.executor.dialIp, "", "没报 dial_ip 时拨号出口 IP 为空（前端回退显示心跳 IP）");
  eq(Boolean(box.data.spug.appKey), true, "把 App Key 下发给执行器（只有带令牌才拿得到）");

  // 执行器自报"直连外网时的出口 IP"（= Spug 白名单要填的那个）：
  // 注意它和心跳 IP 是两条线路（心跳走代理时会是别的地址）
  box = await call("/api/outbox?claim=0&dial_ip=203.0.113.9", { headers: { "x-forwarded-for": "2a03:90c0:2c7:1::11a" } });
  eq(box.data.seenDialIp, "203.0.113.9", "接口把 dial_ip 回显出来");
  eq(box.data.executor.dialIp, "203.0.113.9", "拨号出口 IP 存进执行器状态");
  eq(box.data.executor.ip, "2a03:90c0:2c7:1::11a", "心跳 IP 和拨号出口 IP 分开记，互不覆盖");
  h = await call("/api/health");
  eq(h.data.phone.executor.dialIp, "203.0.113.9", "/api/health 也带拨号出口 IP");

  // --- 3) 电脑端在线时拨号请求只排队，网站绝不自己打 ---
  r = await call("/api/test-call", { method: "POST", body: { title: "电脑端测试电话" } });
  eq(r.data.queued, true, "pc 模式：测试电话变成排队");
  eq(r.data.ok, true, "执行器在线 → 队列受理算成功");
  eq(r.data.reason, "queued", "原因标记为 queued");
  eq(mock.phoneCalls.length, 1, "pc 模式：网站一次都没碰 Spug（还是上次 site 模式那 1 次）");
  eq(Boolean(r.data.taskId), true, "返回任务 id 给界面");

  // --- 4) 执行器领任务 ---
  box = await call("/api/outbox?claim=1&limit=5&host=PC-A&version=1.0");
  eq(box.data.tasks.length, 1, "领到 1 条任务");
  eq(box.data.tasks[0].title.includes("电脑端测试电话"), true, "任务标题正确");
  eq(box.data.tasks[0].force, true, "测试电话带 force（穿透时间段/防轰炸）");
  const taskId = box.data.tasks[0].id;

  // --- 5) lease 生效：同一时间再领一次不会重复拨 ---
  box = await call("/api/outbox?claim=1");
  eq(box.data.tasks.length, 0, "90 秒租约内不会被第二个执行器重复领走");
  eq(box.data.depth, 1, "任务还挂在队列里等结果");

  // --- 6) 回报成功 ---
  let res = await call("/api/outbox/result", {
    method: "POST",
    headers: { "x-forwarded-for": "182.46.51.186" },
    body: { id: taskId, ok: true, reason: "sent", detail: "平台状态：已接通", requestId: "REQ_PC_1", ms: 1234, host: "PC-A", dialIp: "203.0.113.9" }
  });
  eq(res.data.ok, true, "回报被受理");
  eq(res.data.dialed, true, "记为拨号成功");
  eq(res.data.depth, 0, "任务已出队");
  eq(res.data.dialIp, "203.0.113.9", "回报里的拨号出口 IP 原样带回去");

  h = await call("/api/health");
  eq(h.data.phone.last.ok, true, "电话健康快照来自执行器回报");
  eq(h.data.phone.last.via, "pc", "健康快照标明是电脑端拨的");
  eq(h.data.phone.last.ip, "182.46.51.186", "健康快照记下心跳 IP");
  eq(h.data.phone.last.dialIp, "203.0.113.9", "健康快照以执行器自报的拨号出口 IP 为准");
  eq(h.data.phone.last.requestId, "REQ_PC_1", "请求 id 也记下了");

  let logs = await call("/api/logs?limit=3");
  eq(logs.data.items[0].route, "phone-pc", "日志 route 标成 phone-pc（和网站直拨能区分开）");
  eq(logs.data.items[0].ok, true, "日志记成成功");

  // 重复回报同一个 id → 队列里已经没有它
  res = await call("/api/outbox/result", { method: "POST", body: { id: taskId, ok: true } });
  eq(res.data.ok, false, "重复回报被拒");
  eq(res.data.error, "unknown_task", "明确告诉执行器任务不见了");
  eq(res.data.detail.includes("已被另一个执行器"), true, "说明原因");

  // --- 7) 普通信号（非 force）在 pc 模式下也走队列，并且照旧被防轰炸管着 ---
  r = await call("/api/signal", { method: "POST", body: { kind: "phone", title: "频道新消息", content: "#常规 张三: 你好", source: "discord" } });
  eq(r.data.queued, true, "普通信号在 pc 模式下排队");
  eq(mock.phoneCalls.length, 1, "网站依然不碰 Spug");
  await call("/api/outbox?claim=1");
  mock.phoneCalls.length = 0;

  // --- 8) 执行器报"平台已受理但还在拨"（spug_pending）→ 算成功，绝不能触发备用通道 ---
  await setConfig({ fallback: { enabled: true, webhookUrl: "https://hook.local/notify" } });
  mock.webhookCalls.length = 0;
  r = await call("/api/test-call", { method: "POST", body: { title: "还在拨的一通" } });
  box = await call("/api/outbox?claim=1");
  eq(box.data.tasks.length, 1, "领到 pending 用例的任务");
  res = await call("/api/outbox/result", {
    method: "POST",
    body: { id: box.data.tasks[0].id, ok: true, reason: "spug_pending", status: 0, requestId: "REQ_PEND",
            detail: "平台状态：处理中（平台已受理，还没接通）", ms: 900 }
  });
  eq(res.data.dialed, true, "pending 记为成功（平台已受理）");
  eq(res.data.fallback, null, "pending 不触发备用 Webhook（否则会被误报成失败）");
  eq(mock.webhookCalls.length, 0, "Webhook 一条都没收到");
  h = await call("/api/health");
  eq(h.data.phone.last.ok, true, "健康快照不算失败");
  eq(h.data.phone.last.reason, "spug_pending", "原因如实写明还在处理中");

  // --- 9) 执行器报失败 → 走备用通道 + 健康记为失败 ---
  r = await call("/api/test-call", { method: "POST", body: { title: "注定失败的一通" } });
  box = await call("/api/outbox?claim=1");
  eq(box.data.tasks.length, 1, "领到失败用例的任务");
  res = await call("/api/outbox/result", {
    method: "POST",
    body: { id: box.data.tasks[0].id, ok: false, reason: "spug_403", detail: "这台电脑的 IP 不在白名单", ms: 300 }
  });
  eq(res.data.dialed, false, "记为拨号失败");
  eq(res.data.fallback.ok, true, "失败后自动走备用 Webhook");
  eq(mock.webhookCalls.length, 1, "Webhook 确实收到 1 条");
  h = await call("/api/health");
  eq(h.data.phone.last.ok, false, "健康快照记成失败");
  logs = await call("/api/logs?limit=5");
  eq(logs.data.items.some((x) => x.source.endsWith("#fallback")), true, "备用通道那条也进了日志");

  // --- 9.5) 执行器跳过过期任务（expired）→ 不是故障，不触发备用通道 ---
  mock.webhookCalls.length = 0;
  r = await call("/api/test-call", { method: "POST", body: { title: "排太久的一通" } });
  box = await call("/api/outbox?claim=1");
  eq(box.data.tasks.length, 1, "领到过期用例的任务");
  res = await call("/api/outbox/result", {
    method: "POST",
    body: { id: box.data.tasks[0].id, ok: false, reason: "expired", ms: 0,
            detail: "排队 900 秒仍未拨出（上限 600 秒），已跳过" }
  });
  eq(res.data.dialed, false, "过期任务没有拨出去");
  eq(res.data.fallback, null, "主动跳过不触发备用 Webhook");
  eq(mock.webhookCalls.length, 0, "Webhook 一条都没收到");
  logs = await call("/api/logs?limit=5");
  eq(logs.data.items[0].level, "skip", "主动跳过记 skip 级，不该当成 error");

  // --- 10) 执行器不在线时排队会如实说 ---
  ENV.NOTIFY_KV.map.delete("executor:v1");
  r = await call("/api/test-call", { method: "POST", body: { title: "没人接的一通" } });
  eq(r.data.queued, true, "照样入队（等执行器上线）");
  eq(r.data.ok, false, "没有执行器在线 → 不算成功");
  eq(r.data.reason, "no_executor", "原因写明没有执行器");
  logs = await call("/api/logs?limit=5");
  eq(logs.data.items[0].level, "warn", "只是排队等着，不该记成 error");
  await call("/api/outbox?claim=1"); // 清掉这条，别影响后面的用例

  // --- 11) 鉴权 ---
  r = await call("/api/outbox", { token: "" });
  eq(r.status, 401, "队列接口必须带令牌");
  r = await call("/api/outbox/result", { method: "POST", token: "", body: { id: "x", ok: true } });
  eq(r.status, 401, "回报接口必须带令牌");

  // --- 12) 切回网站直拨：队列空着，网站自己打 ---
  await setConfig({ phone: { dialVia: "site" }, fallback: { enabled: false } });
  mock.reset();
  r = await call("/api/test-call", { method: "POST", body: { title: "回到网站直拨" } });
  eq(r.data.queued, false, "切回 site 后不再排队");
  eq(mock.phoneCalls.length, 1, "网站自己打了一次");

  // --- 13) site 模式下执行器就算来问，也不许领走队列里的任务 ---
  await setConfig({ phone: { dialVia: "pc" } });
  await call("/api/signal", { method: "POST", body: { title: "留给 pc 模式的任务", content: "x" } });
  await setConfig({ phone: { dialVia: "site" } });
  let before = (await call("/api/outbox?claim=0")).data.depth;
  ok(before >= 1, "队列里确实压着任务（前面用例的残留 + 这条）");
  r = await call("/api/outbox?claim=1");
  eq(r.data.mode, "site", "网站当前是 site 模式");
  eq(r.data.claim, false, "site 模式下不领任务");
  eq(r.data.tasks.length, 0, "site 模式下不下发任务");
  eq((await call("/api/outbox?claim=0")).data.depth, before, "任务没被吞，还留在队列里");
  await setConfig({ phone: { dialVia: "pc" } });
  r = await call("/api/outbox?claim=1");
  ok(r.data.tasks.length >= 1, "切回 pc 模式后照常领到任务");
  await call("/api/outbox/result", {
    method: "POST",
    body: { id: r.data.tasks[0].id, ok: true, reason: "sent", detail: "清场" }
  });
  await setConfig({ phone: { dialVia: "site" } });
  await resetQuota();
  ENV.NOTIFY_KV.map.delete("executor:v1");
}

async function main() {
  installFetchMock();
  console.log("=== phone-notify 端到端测试（无网络、不真实拨号）===");
  await testWindowModule();
  await testAuthAndConfig();
  await testSignalPipeline();
  await testFailureAndFallback();
  await testHealthAndLogs();
  await testModuleBoundary();
  await testWindowSwitchAndPersistence();
  await testMasterSwitch();
  await testPcDialMode();

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log("失败项：" + failures.join(" / "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("测试脚本异常：", err);
  process.exitCode = 1;
});
