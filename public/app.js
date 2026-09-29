/* ============================================================
   电话通知控制台 · 前端逻辑
   所有请求都打 /api/*（唯一后端入口），页面本身不做业务判断。
   ============================================================ */
const $ = (id) => document.getElementById(id);
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 配置在本浏览器的草稿箱：服务器存不住时，至少刷新页面不用重新填 */
const LS_CFG = "pn_cfg";

const state = {
  config: null,
  health: null,
  balance: null,
  token: localStorage.getItem("pn_token") || "",
  timerHealth: null,
  timerLogs: null,
  timerBalance: null,
  // 已保存配置的指纹：用来判断"有没有未保存的改动"
  savedFp: "",
  // 本浏览器没带令牌（后端返回 401）：界面上要一直挂着红条，别只弹一下就没了
  needToken: false,
  // 总开关正在提交：这期间不接受健康轮询回填，避免界面"跳回去"
  masterPending: false,
  tab: localStorage.getItem("pn_tab") || "ops"
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
  if (resp.status === 401) {
    state.needToken = true;
    renderAuthBanner();
  } else if (data && data.ok && path !== "/api/health" && path !== "/api/ping") {
    // 需要鉴权的接口成功了 → 说明浏览器里的令牌是对的
    if (state.needToken) {
      state.needToken = false;
      renderAuthBanner();
    }
  }
  return { status: resp.status, data };
}

/* ---------------- 访问令牌 ---------------- */
/**
 * 支持用带令牌的链接一次性授权本浏览器：
 *   https://xxx.workers.dev/?token=<SIGNAL_TOKEN>
 * 用完会把地址栏里的 token 擦掉，避免留在历史记录/截图里。
 */
function applyTokenFromUrl() {
  try {
    // __pnTestHref 只是无浏览器测试的钩子，浏览器里永远是 undefined
    const href = globalThis.__pnTestHref || window.location.href;
    const u = new URL(href);
    const t = (u.searchParams.get("token") || "").trim();
    if (!t) return false;
    state.token = t;
    localStorage.setItem("pn_token", t);
    state.needToken = false;
    u.searchParams.delete("token");
    const q = u.searchParams.toString();
    if (window.history && history.replaceState) {
      history.replaceState({}, "", u.pathname + (q ? `?${q}` : "") + (u.hash || ""));
    }
    return true;
  } catch {
    return false;
  }
}

/** 站点设了 SIGNAL_TOKEN、而本浏览器没带令牌时，顶部挂一条常驻红条 */
function renderAuthBanner() {
  const el = $("auth-banner");
  if (!el) return;
  el.className = state.needToken ? "banner bad" : "banner bad hidden";
}

function applyBrowserToken(token) {
  const t = String(token || "").trim();
  if (!t) {
    toast("令牌是空的，先把 SIGNAL_TOKEN 粘进来", "bad");
    return;
  }
  state.token = t;
  localStorage.setItem("pn_token", t);
  state.needToken = false;
  renderAuthBanner();
  const inp = $("token-input");
  if (inp) inp.value = t;
  toast("令牌已存在本浏览器，正在重新读取配置…", "ok");
  refreshConfig();
  refreshHealth();
  refreshLogs();
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------------- 本浏览器草稿（localStorage） ---------------- */
function rememberDraft(cfg) {
  try {
    localStorage.setItem(LS_CFG, JSON.stringify({ t: Date.now(), cfg }));
  } catch {
    /* 隐私模式之类写不进去就算了 */
  }
}

function readDraft() {
  try {
    const raw = localStorage.getItem(LS_CFG);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && obj.cfg ? obj : null;
  } catch {
    return null;
  }
}

/** 键顺序无关的序列化，用来比较"草稿 vs 服务器配置" */
function sortedJson(v) {
  return JSON.stringify(v, (k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val)
          .sort()
          .reduce((o, kk) => ((o[kk] = val[kk]), o), {})
      : val
  );
}

/** 服务器能存住、但本浏览器留着旧草稿时，给一个「用草稿回填」的按钮（不自动覆盖，避免误伤） */
function renderDraftButton(serverCfg, { autoApplied = false } = {}) {
  const btn = $("btn-draft");
  if (!btn) return;
  const draft = readDraft();
  const differs = draft && sortedJson(draft.cfg) !== sortedJson(serverCfg);
  if (!draft || !differs || autoApplied) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const t = fmtTime(new Date(draft.t).toISOString());
  btn.title = `本浏览器草稿（${t}）和服务器里的配置不一样，点一下把草稿填进表单`;
  btn.textContent = `用草稿回填（${t}）`;
}

/* ---------------- 状态渲染 ---------------- */
function card(key, value, detail = "", cls = "", valueCls = "") {
  return `<div class="card ${cls}">
    <div class="k">${key}</div>
    <div class="v ${valueCls}">${value}</div>
    ${detail ? `<div class="d">${detail}</div>` : ""}
  </div>`;
}

/** 存储后端提示条：不是 KV 就把话说清楚，别让人以为"保存成功了" */
function renderStorageBanner(storage) {
  const el = $("storage-banner");
  if (!el) return;
  const s = storage || {};
  if (!s.backend || s.backend === "cloudflare-kv") {
    el.className = "banner hidden";
    el.textContent = "";
    return;
  }
  const draft = readDraft();
  const draftNote = draft
    ? `<br>本浏览器存了草稿（${fmtTime(new Date(draft.t).toISOString())}），刷新不会丢；但它只是"待同步"，服务器没存住就不算生效。`
    : "";
  el.className = `banner ${s.backend === "memory" ? "bad" : "warn"}`;
  el.innerHTML =
    `<b>配置存不住：</b>${s.hint || "当前存储后端是临时的。"}` +
    `<br>绑 KV 三步：① 控制台 <b>Storage &amp; Databases → KV → Create namespace</b>（名字随意）；` +
    `② 本 Worker 的 <b>Settings → Bindings → Add → KV namespace</b>，变量名填 <code>NOTIFY_KV</code>；` +
    `③ 回来再点一次「保存配置」。不用改代码、不用重新部署。` +
    draftNote;
}

function renderHealth(h) {
  state.health = h;
  const win = h.window || {};
  const guard = h.guard || {};
  const phone = h.phone || {};
  const last = phone.last;
  const winOff = win.enabled === false;

  const winCls = winOff ? "warn" : win.active ? "ok" : "warn";
  const winValue = winOff ? "限制已关闭" : win.active ? "允许拨打" : "暂停中";
  const phoneValue = phone.configured ? "已配置" : "未配置";
  const viaText = phone.dialVia === "pc" ? "电脑端拨号" : "网站直拨";
  const phoneLabel = phone.configured ? `${phoneValue} · ${viaText}` : phoneValue;
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
    card("自动通知时间段", winValue, win.detail || "", winCls, winOff ? "big" : win.active ? "big" : "big"),
    card("已拨打通话", `${guard.usedToday ?? 0} / ${guard.maxPerDay ?? "-"} <span style="color:var(--fg-dim)">(今天)</span>`, `本小时 ${guard.usedThisHour ?? 0}/${guard.maxPerHour ?? "-"}${guard.lastSendAt ? ` · 上次：${fmtTime(guard.lastSendAt)}` : " · 本小时尚未拨打"}`, "", "count"),
    card("剩余语音", balValue, balDetail, balCls, "count"),
    card("电话接口", phoneLabel, lastDetail, phone.configured ? "" : "warn"),
    card("通知总开关", h.enabled ? "已开启" : "已关闭", h.enabled ? "收到信号会按时间段拨打" : "仅 force 信号可穿透", h.enabled ? "ok" : "warn"),
    card("存储 / 令牌", h.storage.label || (h.storage.backend === "cloudflare-kv" ? "KV 持久化" : "内存（临时）"), `${h.auth.configured ? "令牌已设置" : "⚠ 未设置令牌，站点开放"}`, h.auth.configured ? (h.storage.durable ? "" : "warn") : "warn")
  ].join("");

  $("win-pill").textContent = winOff ? "时间段：已关闭限制" : `时间段：${win.active ? "可拨打" : "暂停"}`;
  $("win-pill").className = `pill ${winOff ? "off" : win.active ? "on" : "off"}`;
  $("quota-pill").textContent = `今天 ${guard.usedToday ?? 0}/${guard.maxPerDay ?? "-"} · 本小时 ${guard.usedThisHour ?? 0}/${guard.maxPerHour ?? "-"}`;
  $("storage-pill").textContent = `存储：${h.storage.backend === "cloudflare-kv" ? "KV" : h.storage.backend === "edge-cache" ? "缓存" : "内存"}`;
  $("storage-pill").className = `pill ${h.storage.durable ? "on" : h.storage.backend === "edge-cache" ? "" : "bad"}`;
  $("live-dot").className = `dot ${phone.configured ? "live" : "bad"}`;

  const tag = $("window-tag");
  if (tag) {
    tag.textContent = winOff ? "限制已关闭" : win.active ? "当前：可拨打" : "当前：暂停";
    tag.className = `tag ${winOff || !win.active ? "" : "ok"}`;
  }
  // 顶栏总开关跟随服务器真实状态（正在切换时不回填，免得开关自己跳回去）
  if (!state.masterPending) renderMaster(Boolean(h.enabled));
  renderStorageBanner(h.storage);
  renderExecutor(phone);
}

/**
 * 拨打方式提示 + 电脑端执行器在线状态
 * 网站 phone.dialVia = "pc" 时，最后那次拨号请求由电脑发出（Spug IP 白名单只认电脑的 IP）
 */
function applyDialViaUI() {
  const via = $("cfg-dialvia").value === "pc" ? "pc" : "site";
  const hint = $("dialvia-hint");
  if (!hint) return;
  hint.innerHTML = via === "pc"
    ? "✅ 电脑端拨号：网站只负责<b>要不要打</b>（总开关 / 时间段 / 防轰炸 / 日志），最后那次拨号请求由监听器所在电脑直连 Spug 发出，出口 IP 就是你电脑的 IP —— Spug 的 App Key 绑了 IP 白名单时必须用这个。要求：监听器正在运行（它每 3 秒问一次网站有没有活）。"
    : "网站直拨：由 Cloudflare 直接请求 Spug，出口 IP 是 Cloudflare 的共享 IP（例如 162.159.98.122）。<b>App Key 一旦绑了 IP 白名单，这里必然被拒（spug_403）</b>，要改用「电脑端拨号」。";
  hint.className = `hint${via === "pc" ? " ok" : ""}`;
}

function renderExecutor(phone) {
  const tag = $("executor-tag");
  const hint = $("executor-hint");
  if (!tag) return;
  const ex = (phone && phone.executor) || {};
  const via = phone && phone.dialVia === "pc" ? "pc" : "site";
  const age = ex.ageSeconds === null || ex.ageSeconds === undefined ? "" : ex.ageSeconds < 90 ? `${ex.ageSeconds} 秒前` : `${Math.round(ex.ageSeconds / 60)} 分钟前`;
  if (ex.online) {
    tag.textContent = `执行器：在线${ex.ip ? ` · 出口 IP ${ex.ip}` : ""}`;
    tag.className = "pill on";
  } else if (ex.seen) {
    tag.textContent = `执行器：离线（${age}在线过）`;
    tag.className = "pill bad";
  } else {
    tag.textContent = "执行器：未连接";
    tag.className = "pill";
  }
  if (!hint) return;
  if (via !== "pc") {
    hint.textContent = ex.online
      ? `电脑端执行器在线（${ex.host || "本机"}${ex.ip ? `，出口 IP ${ex.ip}` : ""}），但当前拨打方式是「网站直拨」——白名单场景要在这里切过去并保存。`
      : "当前拨打方式是「网站直拨」，电脑端执行器没有连接（Spug 绑了 IP 白名单时需要切到「电脑端拨号」并启动监听器）。";
    return;
  }
  hint.textContent = ex.online
    ? `正在由电脑端拨号（${ex.host || "本机"}${ex.ip ? `，出口 IP ${ex.ip}` : ""}）。这个 IP 必须出现在 Spug 的 IP 白名单里。`
    : "电脑端执行器没在线：电话会排在队列里等着，等监听器（start.bat）启动后 3 秒内就会拨出去。";
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

function applyWindowEnabledUI() {
  const on = $("cfg-window-enabled").checked;
  const box = $("window-fields");
  if (box) box.classList.toggle("dim", !on);
  [...(box ? box.querySelectorAll("input, select, button") : [])].forEach((el) => {
    el.disabled = !on;
  });
  const hint = $("window-hint");
  if (hint) {
    hint.innerHTML = on
      ? "当前：只在勾选的星期与时间段内拨打（「仅在时间段外」= 反选）。"
      : "当前：<b>限制已关闭，任何时间都会拨打</b>（通知总开关与「防轰炸」仍然生效）。";
  }
}

function fillConfig(cfg) {
  state.config = cfg;
  $("cfg-enabled").checked = Boolean(cfg.enabled);
  $("cfg-window-enabled").checked = cfg.window.enabled !== false;
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
  $("cfg-maxday").value = cfg.guard.maxPerDay;

  $("cfg-channel").value = cfg.phone.channel;
  $("cfg-targets").value = cfg.phone.targets;
  $("cfg-prefix").value = cfg.phone.titlePrefix;
  $("cfg-contentlimit").value = cfg.phone.contentLimit;
  $("cfg-retry").value = cfg.phone.retry;
  $("cfg-timeout").value = cfg.phone.timeoutMs;
  $("cfg-appkey").value = cfg.spug.appKey || "";
  $("cfg-devtoken").value = cfg.spug.devToken || "";
  $("cfg-dialvia").value = cfg.phone.dialVia === "pc" ? "pc" : "site";
  applyDialViaUI();

  $("cfg-fallback-enabled").checked = Boolean(cfg.fallback.enabled);
  $("cfg-fallback-url").value = cfg.fallback.webhookUrl || "";

  applyWindowEnabledUI();
  if (!state.masterPending) renderMaster(Boolean(cfg.enabled));
  // 以服务器回填后的表单为准记录指纹：此刻表单 = 已保存状态
  state.savedFp = JSON.stringify(collectConfig());
  setSaveState("saved");
}

function collectConfig() {
  const ranges = [...document.querySelectorAll("#cfg-ranges .range-row")]
    .map((row) => [row.querySelector(".r-from").value, row.querySelector(".r-to").value])
    .filter(([a, b]) => a && b);
  const days = [...document.querySelectorAll("#cfg-days input:checked")].map((i) => Number(i.value));
  return {
    enabled: $("cfg-enabled").checked,
    window: { enabled: $("cfg-window-enabled").checked, mode: $("cfg-mode").value, tz: $("cfg-tz").value, days, ranges },
    guard: {
      dedupeSeconds: Number($("cfg-dedupe").value),
      minIntervalSeconds: Number($("cfg-mininterval").value),
      maxPerHour: Number($("cfg-maxhour").value),
      maxPerDay: Number($("cfg-maxday").value)
    },
    phone: {
      channel: $("cfg-channel").value,
      targets: $("cfg-targets").value.trim(),
      titlePrefix: $("cfg-prefix").value,
      contentLimit: Number($("cfg-contentlimit").value),
      retry: Number($("cfg-retry").value),
      timeoutMs: Number($("cfg-timeout").value),
      dialVia: $("cfg-dialvia").value === "pc" ? "pc" : "site"
    },
    fallback: { enabled: $("cfg-fallback-enabled").checked, webhookUrl: $("cfg-fallback-url").value.trim() },
    spug: { appKey: $("cfg-appkey").value.trim(), devToken: $("cfg-devtoken").value.trim() }
  };
}

/* ---------------- 面板切换 / 保存状态 ---------------- */
function switchTab(name, { save = true } = {}) {
  const tabs = [...document.querySelectorAll("#cfg-tabs .tab")];
  if (!tabs.some((t) => t.dataset.tab === name)) name = "ops";
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
  state.tab = name;
  if (save) localStorage.setItem("pn_tab", name);
}

function setSaveState(kind, text) {
  const el = $("save-state");
  const btn = $("btn-save");
  if (!el || !btn) return;
  el.className = `save-state ${kind}`;
  if (kind === "dirty") {
    el.textContent = text || "有未保存的改动";
    btn.textContent = "保存配置";
    btn.classList.add("pulse");
  } else if (kind === "saving") {
    el.textContent = "保存中…";
    btn.textContent = "保存中…";
  } else if (kind === "saved") {
    el.textContent = text || "已同步";
    btn.textContent = "保存配置";
    btn.classList.remove("pulse");
  } else if (kind === "failed") {
    el.textContent = text || "保存失败";
    btn.textContent = "重试保存";
    btn.classList.add("pulse");
  }
}

/** 表单和"已保存的配置"不一致时点亮提示 */
function markDirty() {
  if (!state.config) return false;
  let fp = "";
  try {
    fp = JSON.stringify(collectConfig());
  } catch (e) {
    return false;
  }
  state.dirtyFp = fp;
  if (state.savedFp && fp === state.savedFp) {
    setSaveState("saved");
    return false;
  }
  setSaveState("dirty");
  return true;
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
  if (!data || !data.ok) return;
  fillConfig(data.config);

  // 服务器存不住（没绑 KV）时，用本浏览器草稿顶上：
  // 界面不至于一刷新就回到默认值，并把草稿自动重发一次（当前实例先按草稿跑）。
  const storage = data.storage || {};
  if (storage.durable) {
    renderDraftButton(data.config);
    return;
  }
  const draft = readDraft();
  if (!draft) return;
  fillConfig(draft.cfg);
  setSaveState("dirty", `已用本浏览器草稿回填（${fmtTime(new Date(draft.t).toISOString())}）`);
  renderDraftButton(data.config, { autoApplied: true });
  await doSave({ silent: true });
}

/* ---------------- 操作 ---------------- */
async function doTestCall() {
  const btn = $("btn-test");
  const pcMode = $("cfg-dialvia") && $("cfg-dialvia").value === "pc";
  btn.disabled = true;
  $("op-result").textContent = pcMode ? "已排队，等电脑端拨号…" : "正在拨号…";
  $("op-result").className = "hint";
  const { data } = await api("/api/test-call", { method: "POST", body: { title: "监听器测试电话" } });
  btn.disabled = false;
  if (data && data.queued) {
    // 电脑端拨号模式：这里只代表"排上队了"，真正拨出去与否由电脑端执行器决定
    const ok = data.ok;
    $("op-result").textContent = `${ok ? "📮" : "⚠️"} ${data.detail || "已排队"}`;
    $("op-result").className = `hint ${ok ? "" : "bad"}`;
    toast(ok ? "已排队，电脑端几秒内会拨出" : data.detail || "已排队，但执行器不在线", ok ? "ok" : "warn");
    refreshHealth();
  } else if (data && data.ok) {
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

async function doSave({ silent = false } = {}) {
  const btn = $("btn-save");
  const body = collectConfig();
  rememberDraft(body); // 先存本浏览器草稿：服务器存不住时也不至于白填
  btn.disabled = true;
  setSaveState("saving");
  const { data, status } = await api("/api/config", { method: "POST", body, quiet: silent });
  btn.disabled = false;

  if (!data) {
    setSaveState("failed", `保存失败（HTTP ${status || "?"}）`);
    if (!silent) toast(`保存失败：站点没返回数据（HTTP ${status || "?"}）`, "bad");
    return;
  }
  if (data.ok && data.persisted) {
    // 用服务器真实存下来的配置回填，避免"界面显示的值"和"实际生效的值"不一致
    if (data.config) fillConfig(data.config);
    else state.savedFp = JSON.stringify(collectConfig());
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    if (data.durable === false) {
      setSaveState("dirty", `已生效，但只是临时存储（${t}）`);
      renderStorageBanner(data.storage || state.health?.storage);
      if (!silent) toast("已保存；但没绑 KV，配置随时可能退回默认值", "bad");
    } else {
      setSaveState("saved", `已保存 ${t}`);
      renderDraftButton(data.config);
      if (!silent) toast("配置已保存（已写入存储）", "ok");
    }
    refreshHealth();
    return;
  }
  if (data.error === "not_persisted") {
    // 明确保持"未保存"：界面不能显示一个骗人的"已保存"
    state.savedFp = "";
    state.dirtyFp = JSON.stringify(collectConfig());
    setSaveState("failed", "没存住：服务器没有可持久化的存储");
    renderStorageBanner(data.storage || state.health?.storage);
    if (!silent) toast(data.detail || "配置没能写进存储，请先给 Worker 绑定 KV", "bad");
    return;
  }
  setSaveState("failed", `保存失败：${data.detail || data.error || "未知错误"}`);
  if (!silent) toast(`保存失败：${data.detail || data.error || "未知错误"}`, "bad");
}

/* ---------------- 总开关（顶栏一键开关）---------------- */
/**
 * 只负责画：把服务器/本地的状态画到顶栏那个开关上
 * @param {boolean} enabled
 * @param {{pending?:boolean}} [opts]
 */
function renderMaster(enabled, { pending = false } = {}) {
  const box = $("master-wrap");
  const cb = $("master-enabled");
  const txt = $("master-state");
  if (!box || !cb || !txt) return;
  cb.checked = Boolean(enabled);
  cb.disabled = Boolean(pending);
  box.className = `master ${pending ? "pending" : enabled ? "on" : "off"}`;
  txt.textContent = pending ? "切换中…" : enabled ? "已开启 · 按时间段拨打" : "已关闭 · 只放行测试电话";
  // 操作面板里那个同名开关保持同步（它属于"整份配置"，要随保存一起提交）
  const legacy = $("cfg-enabled");
  if (legacy) legacy.checked = Boolean(enabled);
}

/**
 * 总开关的动作：一次请求只改 enabled，立刻生效，不需要点「保存配置」
 * @param {boolean} on
 */
async function setMaster(on) {
  if (state.masterPending) return;
  state.masterPending = true;
  renderMaster(on, { pending: true });
  const { data, status } = await api("/api/switch", { method: "POST", body: { on }, quiet: true });
  state.masterPending = false;

  if (data && data.ok) {
    renderMaster(data.enabled);
    if (state.health) state.health.enabled = data.enabled;
    markDirty(); // 表单里的 enabled 也是新值，别让它显示成"未保存"
    if (data.durable === false) {
      renderStorageBanner(data.storage || state.health?.storage);
      toast(`电话通知已${data.enabled ? "开启" : "关闭"}；但只是临时存储（没绑 KV）`, "bad");
    } else {
      toast(data.changed ? `电话通知已${data.enabled ? "开启" : "关闭"}` : "状态没变", data.enabled ? "ok" : "warn");
    }
    refreshHealth();
    refreshLogs();
    return;
  }
  // 失败：界面必须回到服务器的真实状态，不能让开关骗人
  const real = state.health && typeof state.health.enabled === "boolean" ? state.health.enabled : !on;
  renderMaster(real);
  if (data && data.error === "not_persisted") {
    renderStorageBanner(data.storage || state.health?.storage);
    toast(data.detail || "总开关没能写进存储，请先给 Worker 绑定 KV", "bad");
  } else if (status === 401) {
    toast("令牌无效：切换开关需要令牌（把 SIGNAL_TOKEN 粘进顶部红条）", "bad");
  } else {
    toast(`切换失败：${(data && (data.detail || data.error)) || `HTTP ${status || "?"}`}`, "bad");
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
  $("btn-draft").addEventListener("click", () => {
    const draft = readDraft();
    if (!draft) return;
    fillConfig(draft.cfg);
    setSaveState("dirty", `已用草稿回填表单（${fmtTime(new Date(draft.t).toISOString())}），点「保存配置」写进服务器`);
    toast("已用本浏览器草稿回填，别忘了点「保存配置」", "warn");
  });
  $("btn-refresh").addEventListener("click", () => {
    refreshHealth();
    refreshLogs();
  });
  $("btn-clear").addEventListener("click", async () => {
    if (!confirm("清空全部通知日志？")) return;
    await api("/api/logs/clear", { method: "POST" });
    refreshLogs();
  });
  $("btn-auth-apply").addEventListener("click", () => applyBrowserToken($("auth-token-input").value));
  $("auth-token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyBrowserToken($("auth-token-input").value);
  });
  $("btn-auth-goto").addEventListener("click", () => {
    switchTab("auth");
    $("token-input").focus();
  });
  $("cfg-add-range").addEventListener("click", () => addRangeRow());

  // 顶栏总开关：点一下立刻生效（不用点「保存配置」）
  $("master-enabled").addEventListener("change", () => setMaster($("master-enabled").checked));

  // 面板切换：点标签页只换显示，不再把所有配置挤在一个长条里
  document.querySelectorAll("#cfg-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // 时间段总开关：关掉后把下面的星期/区间置灰，避免误以为还在生效
  $("cfg-window-enabled").addEventListener("change", () => {
    applyWindowEnabledUI();
    markDirty();
  });

  // 拨打方式：切换时立刻更新说明文案（真正生效要保存配置）
  $("cfg-dialvia").addEventListener("change", () => {
    applyDialViaUI();
    markDirty();
  });

  // 任何输入变化都刷新"未保存"提示（事件委托，新增的时间段行也能覆盖）
  // 手动发信号/令牌那几个框不属于配置，别把它们算成"未保存的改动"
  const onConfigInput = (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#sig-title, #sig-content, #sig-force, #token-input, .save-bar")) return;
    markDirty();
  };
  document.querySelector(".col-side").addEventListener("input", onConfigInput);
  document.querySelector(".col-side").addEventListener("change", onConfigInput);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      doSave();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.savedFp && state.dirtyFp && state.dirtyFp !== state.savedFp) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

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
  applyTokenFromUrl();
  bind();
  switchTab(state.tab, { save: false });
  tickClock();
  setInterval(tickClock, 1000);

  const check = await api("/api/auth/check", { quiet: true });
  if (check.data && check.data.open === false && !state.token) {
    state.needToken = true;
    renderAuthBanner();
    toast("站点已设置令牌：把 SIGNAL_TOKEN 粘进顶部红条，或直接用带 ?token= 的链接打开", "bad");
  }
  renderAuthBanner();

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
