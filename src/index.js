import { createStore } from "./core/store.js";
import { loadConfig, saveConfig, mergeClientPatch } from "./core/config.js";
import { EventLog } from "./core/logger.js";
import { CommModule } from "./comm/index.js";
import { handleSignal } from "./signal.js";
import { checkAuth, saveToken, loadToken, extractToken } from "./core/auth.js";
import { describeWindow } from "./core/window.js";

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

export function createApp(env = {}) {
  const store = createStore(env);
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

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function handleApi(request, env = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = request.method.toUpperCase();
  const { store, log, comm } = createApp(env);

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
  if (path === "/api/signal" && method === "POST") {
    return needAuth(async () => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: "bad_json", detail: "请求体不是合法 JSON" }, 400);
      const result = await handleSignal(comm, body);
      return json(result, result.ok ? 200 : result.skipped ? 200 : 502);
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
      return json(result, result.ok ? 200 : 502);
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

  // ---------- 配置读写 ----------
  if (path === "/api/config" && method === "GET") {
    return needAuth(async () => {
      const cfg = await comm.config();
      return json({
        ok: true,
        config: {
          ...cfg,
          spug: { ...cfg.spug, appKey: maskKey(cfg.spug.appKey) }
        },
        hasAppKey: Boolean(cfg.spug.appKey),
        windowText: describeWindow(cfg)
      });
    })();
  }

  if (path === "/api/config" && method === "POST") {
    return needAuth(async () => {
      const patch = await readJson(request);
      if (patch === null) return json({ ok: false, error: "bad_json" }, 400);
      const current = await comm.config();
      const next = mergeClientPatch(current, patch);
      // 前端传回掩码值时保留原 Key
      if (String(patch?.spug?.appKey || "").includes("***")) next.spug.appKey = current.spug.appKey;
      if (patch?.auth?.token !== undefined) await saveToken(store, patch.auth.token);
      await saveConfig(store, next);
      return json({ ok: true, windowText: describeWindow(next), hasAppKey: Boolean(next.spug.appKey) });
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
