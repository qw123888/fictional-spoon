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
  reset() {
    this.phoneQueue = [];
    this.phoneCalls = [];
    this.webhookCalls = [];
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
    if (u.includes("hook.local")) {
      mock.webhookCalls.push({ url: u, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`测试未预期的请求：${u}`);
  };
}

function makeRequest(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-auth-token"] = token;
  return new Request(`https://site.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const TOKEN = "test-token-123";
const ENV = {
  NOTIFY_KV: memoryKV(),
  SPUG_APP_KEY: "ak_test_key",
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

  await setConfig({ guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50 }, spug: { appKey: "ak_test_key" } });
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
  await setConfig({ enabled: true, window: { mode: "inside", tz, days: [tomorrow], ranges: [["00:00", "23:59"]] }, guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50 }, fallback: { enabled: false } });
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
  await setConfig({ guard: { dedupeSeconds: 120, minIntervalSeconds: 0, maxPerHour: 50 } });
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
  await setConfig({ guard: { dedupeSeconds: 0, minIntervalSeconds: 300, maxPerHour: 50 } });
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

  // 3.8 参数校验
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
    guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50 },
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
  eq(mock.phoneCalls.length, 1, "业务错误不重试（仅 1 次）");
  ok(badCode.data.detail.includes("指定渠道未开启"), "错误信息透传（detail 带服务端 msg）");

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
}

async function testHealthAndLogs() {
  console.log("\n[5] 健康状态与日志");
  await setConfig({ fallback: { enabled: false }, guard: { dedupeSeconds: 0, minIntervalSeconds: 0, maxPerHour: 50 } });
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

async function main() {
  installFetchMock();
  console.log("=== phone-notify 端到端测试（无网络、不真实拨号）===");
  await testWindowModule();
  await testAuthAndConfig();
  await testSignalPipeline();
  await testFailureAndFallback();
  await testHealthAndLogs();
  await testModuleBoundary();

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
