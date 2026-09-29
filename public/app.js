/* ============================================================
   电话通知控制台 · 前端逻辑
   所有请求都打 /api/*（唯一后端入口），页面本身不做业务判断。
   ============================================================ */
const $ = (id) => document.getElementById(id);
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const state = {
  config: null,
  health: null,
  balance: null,
  token: localStorage.getItem("pn_token") || "",
  timerHealth: null,
  timerLogs: null,
  timerBalance: null
};

/* ---------------- 基础工具 ---------------- */
function toast(message, kind = "") {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.className = `toast ${kind}`;
  }, 4200);
}

async function api(path, { method = "GET", body, quiet = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token) headers["X-Auth-Token"] = state.token;
  let resp;
  try {
    resp = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    if (!quiet) toast(`网络错误：${err.message}`, "bad");
    return { status: 0, data: { ok: false, detail: String(err.message || err) } };
  }
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = { ok: false, detail: `HTTP ${resp.status}` };
  }
  if (resp.status === 401 && !quiet) toast("令牌无效：请在上方「访问令牌」里填写正确令牌", "bad");
  return { status: resp.status, data };
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------------- 状态渲染 ---------------- */
function card(key, value, detail = "", cls = "", valueCls = "") {
  return `<div class="card ${cls}">
    <div class="k">${key}</div>
    <div class="v ${valueCls}">${value}</div>
    ${detail ? `<div class="d">${detail}</div>` : ""}
  </div>`;
}

function renderHealth(h) {
  state.health = h;
  const win = h.window || {};
  const guard = h.guard || {};
  const phone = h.phone || {};
  const last = phone.last;

  const winCls = win.active ? "ok" : "warn";
  const winValue = win.active ? "允许拨打" : "暂停中";
  const phoneValue = phone.configured ? "已配置" : "未配置";
  const lastDetail = last
    ? `最近一次：${last.ok ? "成功" : "失败"} ${fmtTime(new Date(last.ts).toISOString())}${last.detail ? ` · ${last.detail.slice(0, 40)}` : ""}`
    : "尚无发送记录";

  const bal = state.balance;
  const balValue = bal && bal.ok ? `${bal.voiceMinutes} 分钟` : bal ? "查询失败" : "未查询";
  const balDetail = bal
    ? bal.ok
      ? `余额 ${bal.money} 元 · 短信 ${bal.sms} · 邮件 ${bal.mail}`
      : bal.detail || bal.reason || ""
    : "点左侧「查询剩余语音分钟」";
  const balCls = bal && bal.ok ? (bal.voiceMinutes > 0 ? "ok" : "bad") : "";

  $("status-cards").innerHTML = [
    card("当前时间", `${h.now.iso} <span style="color:var(--fg-dim)">${WEEKDAYS[h.now.weekday] || ""}</span>`, `时区 ${h.now.tz}`, "", "big"),
    card("自动通知时间段", winValue, win.detail || "", winCls, win.active ? "big" : "big"),
    card("本小时通话", `${guard.usedThisHour ?? 0} / ${guard.maxPerHour ?? "-"}`, guard.lastSendAt ? `上次：${fmtTime(guard.lastSendAt)}` : "本小时尚未拨打", "", "count"),
    card("剩余语音", balValue, balDetail, balCls, "count"),
    card("电话接口", phoneValue, lastDetail, phone.configured ? "" : "warn"),
    card("通知总开关", h.enabled ? "已开启" : "已关闭", h.enabled ? "收到信号会按时间段拨打" : "仅 force 信号可穿透", h.enabled ? "ok" : "warn"),
    card("存储 / 令牌", h.storage.backend === "cloudflare-kv" ? "KV 持久化" : "内存（临时）", `${h.auth.configured ? "令牌已设置" : "⚠ 未设置令牌，站点开放"}`, h.auth.configured ? "" : "warn")
  ].join("");

  $("win-pill").textContent = `时间段：${win.active ? "可拨打" : "暂停"}`;
  $("win-pill").className = `pill ${win.active ? "on" : "off"}`;
  $("quota-pill").textContent = `本小时 ${guard.usedThisHour ?? 0}/${guard.maxPerHour ?? "-"}`;
  $("storage-pill").textContent = `存储：${h.storage.backend === "cloudflare-kv" ? "KV" : "内存"}`;
  $("storage-pill").className = `pill ${h.storage.persistent ? "on" : "off"}`;
  $("live-dot").className = `dot ${phone.configured ? "live" : "bad"}`;
}

/* ---------------- 配置表单 ---------------- */
function buildDays(days) {
  $("cfg-days").innerHTML = WEEKDAYS.map(
    (name, idx) =>
      `<label><input type="checkbox" value="${idx}" ${days.includes(idx) ? "checked" : ""}><span>${name}</span></label>`
  ).join("");
}

function addRangeRow(from = "08:00", to = "23:00") {
  const row = document.createElement("div");
  row.className = "range-row";
  row.innerHTML = `
    <input type="time" class="r-from" value="${from}">
    <span class="sep">→</span>
    <input type="time" class="r-to" value="${to}">
    <button class="btn tiny ghost r-del" title="删除">✕</button>`;
  row.querySelector(".r-del").addEventListener("click", () => row.remove());
  $("cfg-ranges").appendChild(row);
}

function fillConfig(cfg) {
  state.config = cfg;
  $("cfg-enabled").checked = Boolean(cfg.enabled);
  $("cfg-mode").value = cfg.window.mode;
  const tzSel = $("cfg-tz");
  if (![...tzSel.options].some((o) => o.value === cfg.window.tz)) {
    tzSel.insertAdjacentHTML("beforeend", `<option value="${cfg.window.tz}">${cfg.window.tz}</option>`);
  }
  tzSel.value = cfg.window.tz;
  buildDays(cfg.window.days || []);
  $("cfg-ranges").innerHTML = "";
  (cfg.window.ranges || []).forEach(([a, b]) => addRangeRow(a, b));

  $("cfg-dedupe").value = cfg.guard.dedupeSeconds;
  $("cfg-mininterval").value = cfg.guard.minIntervalSeconds;
  $("cfg-maxhour").value = cfg.guard.maxPerHour;

  $("cfg-channel").value = cfg.phone.channel;
  $("cfg-targets").value = cfg.phone.targets;
  $("cfg-prefix").value = cfg.phone.titlePrefix;
  $("cfg-contentlimit").value = cfg.phone.contentLimit;
  $("cfg-retry").value = cfg.phone.retry;
  $("cfg-timeout").value = cfg.phone.timeoutMs;
  $("cfg-appkey").value = cfg.spug.appKey || "";
  $("cfg-devtoken").value = cfg.spug.devToken || "";

  $("cfg-fallback-enabled").checked = Boolean(cfg.fallback.enabled);
  $("cfg-fallback-url").value = cfg.fallback.webhookUrl || "";
}

function collectConfig() {
  const ranges = [...document.querySelectorAll("#cfg-ranges .range-row")]
    .map((row) => [row.querySelector(".r-from").value, row.querySelector(".r-to").value])
    .filter(([a, b]) => a && b);
  const days = [...document.querySelectorAll("#cfg-days input:checked")].map((i) => Number(i.value));
  return {
    enabled: $("cfg-enabled").checked,
    window: { mode: $("cfg-mode").value, tz: $("cfg-tz").value, days, ranges },
    guard: {
      dedupeSeconds: Number($("cfg-dedupe").value),
      minIntervalSeconds: Number($("cfg-mininterval").value),
      maxPerHour: Number($("cfg-maxhour").value)
    },
    phone: {
      channel: $("cfg-channel").value,
      targets: $("cfg-targets").value.trim(),
      titlePrefix: $("cfg-prefix").value,
      contentLimit: Number($("cfg-contentlimit").value),
      retry: Number($("cfg-retry").value),
      timeoutMs: Number($("cfg-timeout").value)
    },
    fallback: { enabled: $("cfg-fallback-enabled").checked, webhookUrl: $("cfg-fallback-url").value.trim() },
    spug: { appKey: $("cfg-appkey").value.trim(), devToken: $("cfg-devtoken").value.trim() }
  };
}

/* ---------------- 日志渲染 ---------------- */
const LEVEL_TEXT = { ok: "成功", error: "失败", skip: "跳过", info: "信息", warn: "告警" };

function renderLogs(items, stats) {
  const body = $("log-body");
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">暂无记录</td></tr>`;
  } else {
    body.innerHTML = items
      .map((it) => {
        const lv = LEVEL_TEXT[it.level] ? it.level : "info";
        const res = it.ok === true ? "成功" : it.ok === false ? "失败" : "—";
        const reason = it.reason ? `<span class="reason">${it.reason}</span>` : "";
        const detail = it.detail ? `<span class="ct">${escapeHtml(it.detail)}</span>` : "";
        const req = it.requestId ? `<span class="ct">req ${it.requestId}</span>` : "";
        return `<tr>
          <td class="t">${fmtTime(it.iso)}</td>
          <td><span class="tag-lv ${lv}">${LEVEL_TEXT[lv]}</span></td>
          <td class="src">${escapeHtml(it.source || "-")}</td>
          <td class="route">${escapeHtml(it.route || "-")}${it.force ? " ⚡" : ""}</td>
          <td class="title-cell">${escapeHtml(it.title || "-")}${it.content ? `<span class="ct">${escapeHtml(it.content.slice(0, 90))}</span>` : ""}${detail}${req}</td>
          <td>${res} ${reason}</td>
          <td class="ms">${it.ms ? `${it.ms}ms` : "-"}</td>
        </tr>`;
      })
      .join("");
  }
  const s = stats || {};
  $("log-stats").textContent = `总计 ${s.total || 0} · 成功 ${s.ok || 0} · 失败 ${s.fail || 0} · 跳过 ${s.skipped || 0}${s.lastAt ? ` · 最近 ${fmtTime(new Date(s.lastAt).toISOString())}` : ""}`;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 刷新 ---------------- */
async function refreshHealth() {
  const { data } = await api("/api/health", { quiet: true });
  if (data && data.ok) renderHealth(data);
}

async function refreshLogs() {
  const { data } = await api("/api/logs?limit=60", { quiet: true });
  if (data && data.ok) renderLogs(data.items || [], data.stats);
}

async function refreshConfig() {
  const { data } = await api("/api/config");
  if (data && data.ok) {
    fillConfig(data.config);
  }
}

/* ---------------- 操作 ---------------- */
async function doTestCall() {
  const btn = $("btn-test");
  btn.disabled = true;
  $("op-result").textContent = "正在拨号…";
  $("op-result").className = "hint";
  const { data } = await api("/api/test-call", { method: "POST", body: { title: "监听器测试电话" } });
  btn.disabled = false;
  if (data && data.ok) {
    $("op-result").textContent = `✅ 已发出（${data.ms}ms，req ${data.requestId || "-"}），留意手机来电`;
    $("op-result").className = "hint ok";
    toast("测试电话已发出，请留意来电", "ok");
  } else {
    $("op-result").textContent = `❌ ${(data && (data.detail || data.reason)) || "失败"}`;
    $("op-result").className = "hint bad";
    toast(`测试电话失败：${(data && (data.detail || data.reason)) || ""}`, "bad");
  }
  refreshLogs();
}

async function doProbe() {
  const btn = $("btn-probe");
  btn.disabled = true;
  $("op-result").textContent = "自检中…";
  $("op-result").className = "hint";
  const { data } = await api("/api/probe", { method: "POST", body: { kind: "phone" } });
  btn.disabled = false;
  const ok = data && data.ok;
  $("op-result").textContent = `${ok ? "✅" : "❌"} ${(data && data.detail) || "无结果"}${data && data.ms ? `（${data.ms}ms）` : ""}`;
  $("op-result").className = `hint ${ok ? "ok" : "bad"}`;
}

/** 查剩余语音分钟 / 余额（走开发者 Token；App Key 查不了） */
async function doBalance(quiet = false) {
  const btn = $("btn-balance");
  if (btn) btn.disabled = true;
  if (!quiet) {
    $("op-result").textContent = "查询中…";
    $("op-result").className = "hint";
  }
  const { data } = await api("/api/balance");
  if (btn) btn.disabled = false;
  state.balance = data || null;
  if (state.health) renderHealth(state.health);
  if (!quiet && data) {
    const ok = data.ok;
    $("op-result").textContent = `${ok ? "✅" : "❌"} ${data.detail || data.reason || "无结果"}`;
    $("op-result").className = `hint ${ok ? "ok" : "bad"}`;
    if (ok && data.voiceMinutes <= 3) toast(`⚠ 剩余语音仅 ${data.voiceMinutes} 分钟，快去充值`, "bad");
  }
  return data;
}

async function doSendSignal() {  const body = {
    kind: "phone",
    title: $("sig-title").value,
    content: $("sig-content").value,
    source: "manual",
    force: $("sig-force").checked
  };
  const { data } = await api("/api/signal", { method: "POST", body });
  if (data && data.ok) toast(`信号已处理：成功（${data.ms}ms）`, "ok");
  else if (data && data.skipped) toast(`信号被跳过：${data.detail || data.reason}`);
  else toast(`信号失败：${(data && (data.detail || data.reason)) || "未知错误"}`, "bad");
  refreshLogs();
}

async function doSave() {
  const btn = $("btn-save");
  btn.disabled = true;
  const { data } = await api("/api/config", { method: "POST", body: collectConfig() });
  btn.disabled = false;
  if (data && data.ok) {
    toast("配置已保存", "ok");
    await refreshConfig();
    await refreshHealth();
  } else {
    toast(`保存失败：${(data && (data.detail || data.error)) || "未知错误"}`, "bad");
  }
}

/* ---------------- 时钟 ---------------- */
function tickClock() {
  const now = new Date();
  const beijing = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const p = (n) => String(n).padStart(2, "0");
  $("clock").textContent = `${p(beijing.getHours())}:${p(beijing.getMinutes())}:${p(beijing.getSeconds())} 北京`;
}

/* ---------------- 启动 ---------------- */
function bind() {
  $("btn-test").addEventListener("click", doTestCall);
  $("btn-probe").addEventListener("click", doProbe);
  $("btn-balance").addEventListener("click", () => doBalance(false));
  $("btn-send-signal").addEventListener("click", doSendSignal);
  $("btn-save").addEventListener("click", doSave);
  $("btn-refresh").addEventListener("click", () => {
    refreshHealth();
    refreshLogs();
  });
  $("btn-clear").addEventListener("click", async () => {
    if (!confirm("清空全部通知日志？")) return;
    await api("/api/logs/clear", { method: "POST" });
    refreshLogs();
  });
  $("cfg-add-range").addEventListener("click", () => addRangeRow());

  $("btn-token-apply").addEventListener("click", () => {
    state.token = $("token-input").value.trim();
    localStorage.setItem("pn_token", state.token);
    toast("本浏览器已使用该令牌", "ok");
    refreshConfig();
    refreshHealth();
  });
  $("btn-token-save").addEventListener("click", async () => {
    const token = $("token-input").value.trim();
    const headers = token ? { "X-Auth-Token": token } : {};
    fetch("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ token })
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          state.token = token;
          localStorage.setItem("pn_token", token);
          if (d.envLocked) toast("浏览器已使用该令牌；站点侧由环境变量 SIGNAL_TOKEN 决定", "ok");
          else toast("令牌已保存到站点", "ok");
        } else toast("保存令牌失败：需要先通过当前令牌验证", "bad");
      })
      .catch((e) => toast(`保存令牌失败：${e.message}`, "bad"));
  });

  $("auto-refresh").addEventListener("change", (e) => {
    clearInterval(state.timerHealth);
    clearInterval(state.timerLogs);
    clearInterval(state.timerBalance);
    if (e.target.checked) {
      state.timerHealth = setInterval(refreshHealth, 8000);
      state.timerLogs = setInterval(refreshLogs, 8000);
      state.timerBalance = setInterval(() => doBalance(true), 5 * 60 * 1000);
    }
  });

  $("token-input").value = state.token;
}

async function main() {
  bind();
  tickClock();
  setInterval(tickClock, 1000);

  const check = await api("/api/auth/check", { quiet: true });
  if (check.data && check.data.open === false && !state.token) {
    toast("站点已设置令牌，请先在右侧「访问令牌」里填入", "bad");
  }

  await refreshConfig();
  await refreshHealth();
  await refreshLogs();

  state.timerHealth = setInterval(refreshHealth, 8000);
  state.timerLogs = setInterval(refreshLogs, 8000);
  // 语音分钟数变化很慢，5 分钟查一次就够（也能避免频繁调用接口）
  doBalance(true);
  state.timerBalance = setInterval(() => doBalance(true), 5 * 60 * 1000);
}

main();
