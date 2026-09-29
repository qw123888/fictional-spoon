import { createStore } from "./core/store.js";
import { loadConfig, loadStoredConfig, saveConfig, setMasterEnabled, mergeClientPatch, CONFIG_KEY } from "./core/config.js";
import { EventLog } from "./core/logger.js";
import { CommModule } from "./comm/index.js";
import { handleSignal } from "./signal.js";
import { checkAuth, saveToken, loadToken, extractToken } from "./core/auth.js";
import { describeWindow } from "./core/window.js";
import { claim as claimTasks, depth as outboxDepth, executorStatus, heartbeat as executorHeartbeat, publicTask } from "./core/outbox.js";

/**
 * HTTP 路由层（唯一把 URL 映射到模块的地方）
 * ------------------------------------------------------------
 * 所有业务都在模块里，这里只做：鉴权、解析入参、调用接口、拼响应。
 * 同一份 handleApi() 同时服务于 Cloudflare Workers 与 Pages Functions。
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, Authorization",
  "Access-Control-Max-Age": "86400"
};

export function createApp(env = {}, runtime = {}) {
  const store = createStore(env, runtime);
  const log = new EventLog(store);
  const comm = new CommModule({ store, log, env });
  return { store, log, comm };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });
}

function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 10) return s.slice(0, 2) + "***";
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

/** 出给前端的配置：密钥一律掩码 */
function maskConfig(cfg) {
  return {
    ...cfg,
    spug: { ...cfg.spug, appKey: maskKey(cfg.spug.appKey), devToken: maskKey(cfg.spug.devToken) }
  };
}

/** 存储后端信息，前端据此提示"配置存不存得住" */
function storageInfo(store) {
  const backend = store.backend;
  return {
    persistent: store.persistent,
    backend,
    label: store.backendLabel,
    durable: backend === "cloudflare-kv",
    cacheUnusable: Boolean(store.cacheUnusable),
    hint: store.backendHint
  };
}

/** 绑 KV 的三步走，出给界面直接照抄 */
const KV_STEPS =
  "在 Cloudflare 控制台绑一个 KV 就能存住（30 秒，不用改代码、不用重新部署）：" +
  "① Storage & Databases → KV → Create namespace（名字随意，例如 notify-kv）；" +
  "② 回到这个 Worker → Settings → Bindings → Add → KV namespace，Variable name 填 NOTIFY_KV，选刚建的命名空间；" +
  "③ 保存后再点一次「保存配置」。";

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 网站看到的调用方 IP。
 * 电脑端执行器用它来证明"拨号就是从这台电脑出去的"（Spug 白名单认的就是这个 IP）。
 */
function clientIp(request) {
  const h = request.headers;
  const raw = h.get("cf-connecting-ip") || h.get("x-real-ip") || (h.get("x-forwarded-for") || "").split(",")[0] || "";
  return String(raw).trim().slice(0, 60);
}

export async function handleApi(request, env = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = request.method.toUpperCase();
  const { store, log, comm } = createApp(env, { hostname: url.hostname });

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const auth = await checkAuth(request, { store, env });
  const needAuth = (fn) => async () => {
    if (!auth.ok) return json({ ok: false, error: "unauthorized", detail: "令牌无效或缺失" }, 401);
    return await fn();
  };

  // ---------- 公共：存活/健康 ----------
  if (path === "/api/ping" && method === "GET") {
    return json({ ok: true, pong: new Date().toISOString() });
  }

  if (path === "/api/health" && method === "GET") {
    return json(await comm.health());
  }

  // ---------- 信号接收接口（电脑端主入口）----------
  // 注意：业务失败（未配 App Key / 通道报错 / 超时）一律返回 HTTP 200 + ok:false + reason，
  // 只有鉴权/请求体/路由问题才用 4xx。"发送失败"不是 HTTP 层错误 —— 用 502 会被 Cloudflare
  // 边缘吞掉响应体，调用方只能看到光秃秃的 502，拿不到 reason。
  if (path === "/api/signal" && method === "POST") {
    return needAuth(async () => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: "bad_json", detail: "请求体不是合法 JSON" }, 400);
      const result = await handleSignal(comm, body);
      return json(result);
    })();
  }

  // ---------- 总开关（一键开 / 关，只动 enabled 一个字段）----------
  // 独立接口而不是复用 /api/config：总开关是"操作"，不该顺带覆盖整份配置，
  // 也方便任何客户端（电脑端、手机快捷指令）一行请求切掉电话通知。
  if (path === "/api/switch" && method === "GET") {
    return needAuth(async () => {
      const cfg = await comm.config();
      return json({ ok: true, enabled: Boolean(cfg.enabled), storage: storageInfo(store) });
    })();
  }

  if (path === "/api/switch" && method === "POST") {
    return needAuth(async () => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: "bad_json", detail: "请求体不是合法 JSON" }, 400);
      const stored = await loadStoredConfig(store);
      const hasOn = body.on !== undefined || body.enabled !== undefined || body.value !== undefined;
      if (!hasOn && !body.toggle) {
        return json({ ok: false, error: "bad_param", detail: "给 on:true/false 直接设定，或给 toggle:true 取反" }, 400);
      }
      const want = body.toggle ? !stored.enabled : Boolean(body.on ?? body.enabled ?? body.value);
      const r = await setMasterEnabled(store, want);
      const info = storageInfo(store);
      if (!r.persisted || info.backend === "memory") {
        return json({
          ok: false,
          error: "not_persisted",
          detail: `总开关没能写进存储（当前后端：${info.label}）。${KV_STEPS}`,
          enabled: stored.enabled,
          changed: false,
          storage: info
        });
      }
      await log.push({
        level: r.cfg.enabled ? "ok" : "warn",
        title: `电话通知总开关：${r.cfg.enabled ? "开启" : "关闭"}`,
        content: r.changed ? `操作前为${r.before.enabled ? "开启" : "关闭"}` : "状态未变化",
        source: "master-switch",
        route: "local",
        ok: r.cfg.enabled,
        detail: r.cfg.enabled ? "收到信号会按时间段拨打" : "仅 force 信号与测试电话可穿透"
      });
      return json({
        ok: true,
        enabled: r.cfg.enabled,
        changed: r.changed,
        persisted: true,
        durable: info.durable,
        warning: info.durable ? "" : info.hint,
        storage: info
      });
    })();
  }

  // ---------- 测试电话 ----------
  if (path === "/api/test-call" && method === "POST") {
    return needAuth(async () => {
      const body = (await readJson(request)) || {};
      const result = await comm.testCall({
        title: body.title || "监听器测试电话",
        content: body.content || `这是一通测试电话，时间 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
        source: "test-call"
      });
      return json(result);
    })();
  }

  // ---------- 通道自检（不拨号）----------
  if (path === "/api/probe" && method === "POST") {
    return needAuth(async () => {
      const body = (await readJson(request)) || {};
      const result = await comm.probe(body.kind || "phone");
      return json({ ok: Boolean(result.ok), ...result });
    })();
  }

  // ---------- 通道资源查询（电话通道 = 剩余语音分钟数 / 余额）----------
  if (path === "/api/balance" && method === "GET") {
    return needAuth(async () => {
      const result = await comm.balance(url.searchParams.get("kind") || "phone");
      return json(result);
    })();
  }

  // ---------- 按 request_id 查实际发送结果 ----------
  if (path === "/api/status" && method === "GET") {
    return needAuth(async () => {
      const requestId = url.searchParams.get("requestId") || "";
      const result = await comm.queryStatus(requestId, url.searchParams.get("kind") || "phone");
      return json(result);
    })();
  }

  // ---------- 电脑端拨号：任务队列（执行器轮询领取）----------
  // phone.dialVia = "pc" 时的闭环：
  //   comm.notify() → 队列 → 电脑端在这里领任务 → 本地直连 Spug 拨号（用电脑的出口 IP）
  //   → POST /api/outbox/result 回报 → 网站写日志/健康/备用通道
  if (path === "/api/outbox" && method === "GET") {
    return needAuth(async () => {
      const cfg = await comm.config();
      const mode = String(cfg.phone.dialVia || "site");
      const ip = clientIp(request);
      // 网站自己拨（site）时队列该是空的；万一还留着上一个模式的任务，也不要领：
      // 领走 = 上 90 秒租约，白白搅动队列。留着等切回 pc 模式再拨。
      const doClaim = url.searchParams.get("claim") !== "0" && mode === "pc";
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") || 5) || 5));
      const got = doClaim ? await claimTasks(store, { limit }) : { tasks: [], depth: await outboxDepth(store) };
      // 执行器自己探测的"拨号出口 IP"（它直连外网时的 IP，也就是要填进 Spug 白名单的那个），
      // 和 ip（它连网站时的 IP，可能被代理换成另一条线路）不是一回事。
      const dialIp = String(url.searchParams.get("dial_ip") || "").slice(0, 60);
      // 心跳带节流：执行器几秒一次轮询，不能每次都写 KV（免费额度 1000 写/天）
      await executorHeartbeat(store, {
        host: url.searchParams.get("host") || "",
        version: url.searchParams.get("version") || "",
        poll: limit,
        ip,
        dialIp,
        hasTasks: got.tasks.length > 0
      });
      return json({
        ok: true,
        mode,
        claim: doClaim,
        tasks: got.tasks.map(publicTask),
        depth: got.depth,
        executor: await executorStatus(store),
        seenIp: ip,
        seenDialIp: dialIp,
        // 执行器要的东西：拨号参数 + 只能查余额/查状态的开发者 Token
        spug: {
          baseUrl: cfg.spug.baseUrl,
          appKey: cfg.spug.appKey,
          devToken: cfg.spug.devToken,
          channel: cfg.phone.channel,
          targets: cfg.phone.targets,
          contentLimit: cfg.phone.contentLimit,
          timeoutMs: cfg.phone.timeoutMs
        },
        serverTime: new Date().toISOString()
      });
    })();
  }

  if (path === "/api/outbox/result" && method === "POST") {
    return needAuth(async () => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: "bad_json" }, 400);
      const result = await comm.settleDialResult(body, { ip: clientIp(request) });
      return json(result, result.error === "bad_param" ? 400 : 200);
    })();
  }

  // ---------- 配置读写 ----------
  if (path === "/api/config" && method === "GET") {
    return needAuth(async () => {
      const cfg = await comm.config();
      return json({
        ok: true,
        config: maskConfig(cfg),
        hasAppKey: Boolean(cfg.spug.appKey),
        hasDevToken: Boolean(cfg.spug.devToken),
        windowText: describeWindow(cfg),
        storage: storageInfo(store)
      });
    })();
  }

  if (path === "/api/config" && method === "POST") {
    return needAuth(async () => {
      const patch = await readJson(request);
      if (patch === null) return json({ ok: false, error: "bad_json" }, 400);
      const current = await comm.config();
      // 合并基线用"库里的配置"（不含 env 覆盖），否则 env 里的密钥会被写进 KV
      const stored = await loadStoredConfig(store);
      const next = mergeClientPatch(stored, patch);
      // 前端传回掩码值时保留原 Key
      if (String(patch?.spug?.appKey || "").includes("***")) next.spug.appKey = stored.spug.appKey || current.spug.appKey;
      if (String(patch?.spug?.devToken || "").includes("***")) next.spug.devToken = stored.spug.devToken || current.spug.devToken;
      if (patch?.auth?.token !== undefined) await saveToken(store, patch.auth.token);
      await saveConfig(store, next);

      // 写后校验：读回来比对。存不住就如实说"没保存成功"，别让界面显示一个骗人的"已保存"
      const persisted = await store.verify(CONFIG_KEY, next);
      const info = storageInfo(store);
      if (!persisted || info.backend === "memory") {
        return json({
          ok: false,
          error: "not_persisted",
          detail: `配置没能写进存储（当前后端：${info.label}）。${KV_STEPS}`,
          storage: info,
          config: maskConfig(stored)
        });
      }
      return json({
        ok: true,
        persisted: true,
        durable: info.durable,
        warning: info.durable ? "" : info.hint,
        config: maskConfig(next),
        windowText: describeWindow(next),
        hasAppKey: Boolean(next.spug.appKey),
        hasDevToken: Boolean(next.spug.devToken),
        storage: info
      });
    })();
  }

  // ---------- 令牌管理 ----------
  if (path === "/api/auth/token" && method === "POST") {
    const current = await loadToken(store, env);
    if (current && !auth.ok) return json({ ok: false, error: "unauthorized" }, 401);
    const body = (await readJson(request)) || {};
    await saveToken(store, body.token || "");
    // 部署时若用 SIGNAL_TOKEN 环境变量下发令牌，它的优先级高于这里保存的值
    const envLocked = Boolean(env.SIGNAL_TOKEN);
    return json({
      ok: true,
      configured: Boolean(String(body.token || "").trim()),
      envLocked,
      detail: envLocked ? "已设置环境变量 SIGNAL_TOKEN，站点一律以它为准" : ""
    });
  }

  if (path === "/api/auth/check" && method === "GET") {
    return json({ ok: auth.ok, open: auth.open, provided: Boolean(extractToken(request)) });
  }

  // ---------- 日志 ----------
  if (path === "/api/logs" && method === "GET") {
    return needAuth(async () => {
      const limit = Number(url.searchParams.get("limit") || 50);
      return json({ ok: true, items: await log.list(limit), stats: await log.stats() });
    })();
  }

  if (path === "/api/logs/clear" && method === "POST") {
    return needAuth(async () => {
      await log.clear();
      return json({ ok: true });
    })();
  }

  // ---------- 通道列表 ----------
  if (path === "/api/adapters" && method === "GET") {
    return needAuth(async () => json({ ok: true, adapters: comm.adapters() }));
  }

  return json({ ok: false, error: "not_found", detail: `未知接口：${method} ${path}` }, 404);
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return await handleApi(request, env);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("静态资源未绑定（ASSETS）", { status: 404 });
  }
};
