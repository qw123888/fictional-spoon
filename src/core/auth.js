/**
 * 访问控制模块
 * ------------------------------------------------------------
 * 电脑端发信号 / 网页改配置 共用同一个令牌。
 * 未配置令牌时站点是开放的（本地调试方便），health 会给出告警提示。
 */
const AUTH_KEY = "auth:token";

function safeEqual(a, b) {
  const s1 = String(a);
  const s2 = String(b);
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i++) diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  return diff === 0;
}

export async function loadToken(store, env = {}) {
  if (env.SIGNAL_TOKEN) return String(env.SIGNAL_TOKEN).trim();
  return String((await store.get(AUTH_KEY, "")) || "").trim();
}

export async function saveToken(store, token) {
  await store.set(AUTH_KEY, String(token || "").trim());
}

export function extractToken(request) {
  const h = request.headers;
  const bearer = (h.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const direct = (h.get("x-auth-token") || "").trim();
  let query = "";
  try {
    query = new URL(request.url).searchParams.get("token") || "";
  } catch {
    query = "";
  }
  return direct || bearer || query;
}

/** @returns {Promise<{ok:boolean, open:boolean}>} */
export async function checkAuth(request, { store, env = {} }) {
  const token = await loadToken(store, env);
  if (!token) return { ok: true, open: true };
  return { ok: safeEqual(extractToken(request), token), open: false };
}
