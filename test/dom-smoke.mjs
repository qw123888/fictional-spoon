/**
 * 前端烟雾测试（不需要浏览器）
 * ------------------------------------------------------------
 * 用 linkedom 把 public/index.html + public/app.js 真的跑起来，
 * 验证：面板切换、时间段开关置灰、脏状态提示、保存成功/失败反馈。
 * 运行：node test/dom-smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let parseHTML;
try {
  ({ parseHTML } = await import("linkedom"));
} catch {
  console.log("跳过前端烟雾测试：没装 linkedom（可选依赖）。要跑就先执行：npm i -D linkedom");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
void appJs; // 只为确认文件存在；实际由 import 加载

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
function eq(a, b, label) {
  ok(a === b, label, `（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}

const { window } = parseHTML(html);
const { document } = window;

// ---------- 浏览器环境替身 ----------
const ls = new Map();
const localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k)
};

const DEFAULT_CONFIG = {
  enabled: true,
  window: { enabled: true, mode: "inside", tz: "Asia/Shanghai", days: [0, 1, 2, 3, 4, 5, 6], ranges: [["00:00", "23:59"]] },
  guard: { dedupeSeconds: 60, minIntervalSeconds: 60, maxPerHour: 5, maxPerDay: 20 },
  phone: { channel: "voice", targets: "", titlePrefix: "", contentLimit: 200, retry: 1, timeoutMs: 10000 },
  fallback: { enabled: false, webhookUrl: "" },
  spug: { appKey: "ak_x***y", devToken: "dev***token" }
};

let saveMode = "kv"; // kv | not_persisted
let authMode = "open"; // open | token（token = 站点设了 SIGNAL_TOKEN，必须带 X-Auth-Token）
let masterEnabled = true; // 服务器上的总开关状态（/api/switch 会改它）
const posts = [];
const switchCalls = [];
const sentTokens = [];

function storageInfo() {
  return saveMode === "kv"
    ? { persistent: true, backend: "cloudflare-kv", label: "KV 持久化", durable: true }
    : { persistent: false, backend: "memory", label: "内存（临时，重启/换机房会丢）", durable: false };
}

async function fakeFetch(url, init = {}) {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const json = (obj) =>
    new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });

  // 站点设了令牌时的鉴权替身：公开接口放行，其余必须带对令牌
  const pub = u.includes("/api/health") || u.includes("/api/ping") || u.includes("/api/auth/check");
  const sent = (init.headers && (init.headers["X-Auth-Token"] || init.headers["x-auth-token"])) || "";
  if (authMode === "token") {
    sentTokens.push(sent);
    if (!pub && sent !== "good-token") {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized", detail: "令牌无效或缺失" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  if (u.endsWith("/api/config") && (!init.method || init.method === "GET")) {
    return json({ ok: true, config: DEFAULT_CONFIG, hasAppKey: true, hasDevToken: true, windowText: "每天 00:00-23:59（时区 Asia/Shanghai）", storage: storageInfo() });
  }
  if (u.endsWith("/api/config") && init.method === "POST") {
    posts.push(body);
    if (saveMode === "kv") {
      return json({ ok: true, persisted: true, config: { ...DEFAULT_CONFIG, ...body }, windowText: "已保存", hasAppKey: true, hasDevToken: true, storage: storageInfo() });
    }
    return json({ ok: false, error: "not_persisted", detail: "配置没能写进存储（当前后端：内存）。请给 Worker 绑定一个 KV 命名空间。", storage: storageInfo(), config: DEFAULT_CONFIG });
  }
  if (u.endsWith("/api/switch") && init.method === "POST") {
    switchCalls.push(body);
    if (saveMode === "not_persisted") {
      return json({ ok: false, error: "not_persisted", detail: "总开关没能写进存储（当前后端：内存）。请给 Worker 绑定一个 KV 命名空间。", enabled: masterEnabled, changed: false, storage: storageInfo() });
    }
    const want = body.toggle ? !masterEnabled : Boolean(body.on ?? body.enabled);
    const changed = want !== masterEnabled;
    masterEnabled = want;
    return json({ ok: true, enabled: masterEnabled, changed, persisted: true, durable: true, warning: "", storage: storageInfo() });
  }
  if (u.endsWith("/api/switch")) return json({ ok: true, enabled: masterEnabled, storage: storageInfo() });
  if (u.endsWith("/api/health")) {
    return json({
      ok: true,
      now: { iso: "2026-09-30 06:00", tz: "Asia/Shanghai", weekday: 3 },
      enabled: masterEnabled,
      window: { active: true, allowed: true, reason: "window_active", detail: "每天 00:00-23:59", enabled: true, disabled: false },
      guard: { usedThisHour: 0, maxPerHour: 5, usedToday: 0, maxPerDay: 20, minIntervalSeconds: 60, lastSendAt: null },
      phone: { configured: true, last: null },
      auth: { configured: true, open: false },
      storage: storageInfo()
    });
  }
  if (u.endsWith("/api/logs")) return json({ ok: true, items: [], stats: { total: 0, ok: 0, fail: 0, skipped: 0 } });
  if (u.endsWith("/api/auth/check")) return json({ ok: true, open: authMode !== "token", provided: false });
  if (u.endsWith("/api/balance")) return json({ ok: true, voiceMinutes: 14, money: 0, sms: 2, mail: 10, wxMp: 100 });
  return json({ ok: false, error: "not_found", detail: u });
}

// 让 app.js 里的 window/document/localStorage/fetch 指向替身
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = localStorage;
globalThis.fetch = fakeFetch;
window.localStorage = localStorage;
window.fetch = fakeFetch;
const timers = [];
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
globalThis.clearInterval = () => {};
window.setInterval = globalThis.setInterval;
window.clearInterval = globalThis.clearInterval;

// linkedom 的 <select>.value 只有 getter，补一个 setter（浏览器里本来就有）
for (const sel of document.querySelectorAll("select")) {
  Object.defineProperty(sel, "value", {
    configurable: true,
    get() {
      const hit = [...sel.querySelectorAll("option")].find((o) => o.selected);
      return hit ? hit.value : "";
    },
    set(v) {
      [...sel.querySelectorAll("option")].forEach((o) => {
        o.selected = o.value === String(v);
      });
    }
  });
}

// app.js 是 ES module 且结尾会 main()，这里直接 import 求值
await import(new URL("../public/app.js", import.meta.url).href);
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));

const $ = (id) => document.getElementById(id);
const visiblePane = () => [...document.querySelectorAll(".tabpane")].find((p) => p.classList.contains("active"))?.dataset.pane;

console.log("\n[1] 面板拆分与切换");
eq(document.querySelectorAll("#cfg-tabs .tab").length, 6, "标签栏有 6 个面板");
eq(visiblePane(), "ops", "默认显示「操作」面板");
eq(document.querySelectorAll(".tabpane.active").length, 1, "同时只显示一个面板");
$("cfg-tabs").querySelector('[data-tab="guard"]').dispatchEvent(new window.Event("click", { bubbles: true }));
eq(visiblePane(), "guard", "点「防轰炸」切到对应面板");
eq(localStorage.getItem("pn_tab"), "guard", "当前面板记到 localStorage（刷新后还在）");
$("cfg-tabs").querySelector('[data-tab="window"]').dispatchEvent(new window.Event("click", { bubbles: true }));
eq(visiblePane(), "window", "点「时间段」切回来");

console.log("\n[2] 时间段总开关联动");
eq($("cfg-window-enabled").checked, true, "开关按服务器配置回填为开");
eq($("window-fields").classList.contains("dim"), false, "开启时星期/区间正常显示");
$("cfg-window-enabled").checked = false;
$("cfg-window-enabled").dispatchEvent(new window.Event("change", { bubbles: true }));
eq($("window-fields").classList.contains("dim"), true, "关闭后置灰");
ok([...$("window-fields").querySelectorAll("input, select")].every((el) => el.disabled), "关闭后子控件被禁用");
ok($("window-hint").textContent.includes("任何时间"), "提示文字改为「任何时间都会拨打」");
eq($("save-state").className.includes("dirty"), true, "拨开关立刻标记为「有未保存的改动」");

console.log("\n[3] 保存成功（绑了 KV）");
saveMode = "kv";
posts.length = 0;
$("btn-save").dispatchEvent(new window.Event("click", { bubbles: true }));
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
eq(posts.length, 1, "保存确实发出了 POST /api/config");
eq(posts[0].window.enabled, false, "请求体带上了 window.enabled=false（开关没白点）");
eq(posts[0].guard.maxPerDay, 20, "请求体带上了每天上限");
ok($("save-state").textContent.includes("已保存"), `保存栏显示已保存：${$("save-state").textContent}`);
eq($("save-state").className.includes("saved"), true, "保存栏状态为 saved");
eq($("btn-save").disabled, false, "保存按钮恢复可点");

console.log("\n[4] 保存失败（存储不可用）不许假装成功");
saveMode = "not_persisted";
$("cfg-maxday").value = "35";
$("cfg-maxday").dispatchEvent(new window.Event("input", { bubbles: true }));
eq($("save-state").className.includes("dirty"), true, "改数字 → 标记未保存");
$("btn-save").dispatchEvent(new window.Event("click", { bubbles: true }));
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
ok($("save-state").textContent.includes("没存住"), `保存栏如实报错：${$("save-state").textContent}`);
eq($("save-state").className.includes("failed"), true, "状态为 failed");
eq($("storage-banner").classList.contains("bad"), true, "顶部弹出红色存储告警条");
ok($("storage-banner").textContent.includes("NOTIFY_KV"), "告警条里写了绑 KV 的办法");
ok(document.body.textContent.includes("没存住") || document.body.textContent.includes("存储"), "页面上能看到失败原因");

console.log("\n[5] 服务器存不住时，用本浏览器草稿顶上（刷新不用重填）");
saveMode = "memory";
ls.set(
  "pn_cfg",
  JSON.stringify({ t: Date.now(), cfg: { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, maxPerDay: 9 } } })
);
posts.length = 0;
$("btn-token-apply").dispatchEvent(new window.Event("click", { bubbles: true })); // 会触发一次 refreshConfig()
for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5));
eq($("cfg-maxday").value, "9", "表单显示的是本浏览器草稿里的 9，而不是服务器默认的 20");
ok($("storage-banner").textContent.includes("草稿"), "告警条说明当前是本浏览器草稿（未生效到服务器）");
ok(posts.length >= 1, "草稿会自动重发一次给服务器（当前实例先按草稿跑）");

console.log("\n[6] 服务器能存住但有旧草稿：给按钮回填，不偷偷覆盖");
saveMode = "kv";
ls.set(
  "pn_cfg",
  JSON.stringify({ t: Date.now(), cfg: { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, maxPerDay: 11 } } })
);
$("btn-token-apply").dispatchEvent(new window.Event("click", { bubbles: true }));
for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5));
eq($("save-state").className.includes("dirty"), false, "服务器能存住时不假装未保存（不自动覆盖服务器配置）");
eq($("btn-draft").hidden, false, "出现「用草稿回填」按钮（草稿和服务器不一致）");
$("btn-draft").dispatchEvent(new window.Event("click", { bubbles: true }));
eq($("cfg-maxday").value, "11", "点一下把草稿里的 11 填进表单");
eq($("save-state").className.includes("dirty"), true, "回填后标记为「有未保存的改动」，等用户确认再写服务器");

console.log("\n[7] 站点设了令牌、浏览器没带：顶部常驻红条 + 就地粘贴");
authMode = "token";
ls.delete("pn_token");
sentTokens.length = 0;
$("btn-token-apply").dispatchEvent(new window.Event("click", { bubbles: true })); // 触发 refreshConfig → 401
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
eq($("auth-banner").classList.contains("hidden"), false, "顶部出现「本浏览器还没带访问令牌」红条");
ok($("auth-banner").textContent.includes("令牌无效或缺失"), "红条说清楚被拒的原因，不会被误认为电话接口没配");
$("auth-token-input").value = "good-token";
$("btn-auth-apply").dispatchEvent(new window.Event("click", { bubbles: true }));
for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5));
eq(ls.get("pn_token"), "good-token", "令牌存进本浏览器");
eq($("auth-banner").classList.contains("hidden"), true, "带上令牌后红条自动消失");
eq($("cfg-maxday").value, "20", "重新拉到的配置填进了表单（不再是空壳）");
ok(sentTokens.includes("good-token"), "后续请求确实带上了 X-Auth-Token");

console.log("\n[8] 顶栏总开关：点一下就生效，不用点「保存配置」");
masterEnabled = true;
switchCalls.length = 0;
posts.length = 0;
$("btn-refresh").dispatchEvent(new window.Event("click", { bubbles: true }));
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
eq($("master-enabled").checked, true, "顶栏开关按服务器状态回填为开");
ok($("master-state").textContent.includes("已开启"), `状态文字写明已开启：${$("master-state").textContent}`);
eq($("master-wrap").classList.contains("on"), true, "开关容器进入 on 样式");

$("master-enabled").checked = false;
$("master-enabled").dispatchEvent(new window.Event("change", { bubbles: true }));
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
eq(switchCalls.length, 1, "点一下只发一个请求");
eq(switchCalls[0].on, false, "请求体是 {on:false}（只切开关，不带整份配置）");
eq(posts.length, 0, "没有顺手发一份 /api/config 保存（不会覆盖你还改了一半的表单）");
eq(masterEnabled, false, "服务器上的开关真的关了");
ok($("master-state").textContent.includes("已关闭"), `状态文字改为已关闭：${$("master-state").textContent}`);
eq($("cfg-enabled").checked, false, "「操作」面板里那个同名开关也同步了");

console.log("\n[9] 总开关切不动时不许骗人：开关弹回去 + 红条说明");
saveMode = "not_persisted";
masterEnabled = false;
$("master-enabled").checked = true;
$("master-enabled").dispatchEvent(new window.Event("change", { bubbles: true }));
for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
eq($("master-enabled").checked, false, "服务器没存住 → 开关弹回真实状态（false）");
ok($("master-state").textContent.includes("已关闭"), "状态文字也跟着回到已关闭");
ok($("storage-banner").textContent.includes("KV") || $("storage-banner").textContent.includes("存储"), "顶部红条给出「绑 KV」的提示");
saveMode = "kv";

console.log("\n[10] 用带 ?token= 的链接打开：自动授权，不弹提示");
ls.delete("pn_token");
sentTokens.length = 0;
globalThis.__pnTestHref = "https://site.example/?token=good-token";
await import("../public/app.js?tok=1"); // 二次导入 = 再跑一遍 main()
for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5));
eq(ls.get("pn_token"), "good-token", "URL 里的令牌被自动收下");
eq($("auth-banner").classList.contains("hidden"), true, "自动授权后不显示红条");
ok(sentTokens.includes("good-token"), "自动授权后立刻带着令牌拉配置");
delete globalThis.__pnTestHref;

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log("失败项：" + failures.join(" / "));
  process.exitCode = 1;
}
