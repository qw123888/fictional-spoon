/**
 * ============================================================
 *  拨号任务队列（电脑端拨号模式）
 * ============================================================
 * 为什么有这个东西：
 *   Spug 的 App Key 可以绑 IP 白名单，只放行"电脑所在网络的出口 IP"。
 *   Cloudflare Worker 的出口 IP 是共享的、不可指定，必然被 spug_403 拒掉
 *   （报错形如：请求IP: 162.159.98.122 不在IP白名单内）。
 *   所以把"最后一步 HTTP 拨号"挪到电脑上执行，网站仍然负责"要不要打"。
 *
 * 闭环（电脑端拨号模式）：
 *   comm.notify() → enqueue()              ← 网站已经过完 总开关/时间段/防轰炸
 *   电脑端 GET /api/outbox 领取（claim）    ← lease 90s，避免两个执行器重复拨
 *   电脑端本地直连 Spug 拨号（不走代理）    ← 出口 IP 才是白名单里的那个
 *   电脑端 POST /api/outbox/result 回报     ← 网站写日志/健康/备用通道
 *
 * 存储：一个 KV 键存整个数组。单执行器 + 低频（≤20 通/天）场景够用；
 *      KV 没有原子读改写，这里用"lease 窗口"而不是锁来避免重复拨号。
 * 写入预算：KV 免费额度 1000 写/天，所以心跳要节流（见 HEARTBEAT_MIN_MS）。
 */
export const OUTBOX_KEY = "outbox:v1";
export const EXECUTOR_KEY = "executor:v1";

export const MAX_TASKS = 100;
export const DEFAULT_LEASE_MS = 90 * 1000;
/** 超过这个时间没心跳就算执行器离线 */
export const EXECUTOR_ONLINE_MS = 90 * 1000;
/** 心跳节流：执行器 3 秒轮询一次，不能每次都写 KV */
export const HEARTBEAT_MIN_MS = 5 * 60 * 1000;

function rid(prefix = "d") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function readTasks(store) {
  const list = await store.get(OUTBOX_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t && typeof t === "object" && t.id);
}

export async function writeTasks(store, list) {
  const next = (Array.isArray(list) ? list : []).slice(-MAX_TASKS);
  await store.set(OUTBOX_KEY, next);
  return next;
}

export async function depth(store) {
  return (await readTasks(store)).length;
}

/**
 * 入队一条拨号任务
 * @returns {Promise<{task:object, depth:number, persisted:boolean}>}
 */
export async function enqueue(store, task = {}) {
  const now = Date.now();
  const item = {
    id: rid("d"),
    ts: now,
    enqueuedAt: new Date(now).toISOString(),
    title: String(task.title ?? "").slice(0, 32),
    content: String(task.content ?? "").slice(0, 500),
    source: String(task.source || "unknown").slice(0, 40),
    kind: String(task.kind || "phone"),
    force: Boolean(task.force),
    fingerprint: String(task.fingerprint || "").slice(0, 80),
    signalId: String(task.signalId || ""),
    tries: 0,
    leaseUntil: 0
  };

  const list = await readTasks(store);
  list.push(item);
  const written = await writeTasks(store, list);

  let persisted = false;
  try {
    persisted = await store.verify(OUTBOX_KEY, written);
  } catch {
    persisted = false;
  }
  return { task: item, depth: written.length, persisted };
}

/**
 * 领取任务：给待执行的任务续 lease（不是删除——等回报结果才出队）
 * @returns {Promise<{tasks:object[], depth:number}>}
 */
export async function claim(store, { limit = 5, leaseMs = DEFAULT_LEASE_MS, now = Date.now() } = {}) {
  const list = await readTasks(store);
  const free = list
    .filter((t) => !t.leaseUntil || t.leaseUntil <= now)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (!free.length) return { tasks: [], depth: list.length };

  const picked = free.slice(0, Math.max(1, Math.min(20, limit)));
  const ids = new Set(picked.map((t) => t.id));
  const next = list.map((t) =>
    ids.has(t.id)
      ? { ...t, leaseUntil: now + leaseMs, tries: (t.tries || 0) + 1, claimedAt: new Date(now).toISOString() }
      : t
  );
  await writeTasks(store, next);
  return { tasks: next.filter((t) => ids.has(t.id)), depth: next.length };
}

/** 出队（电脑端回报结果后调用） */
export async function settle(store, id) {
  const list = await readTasks(store);
  const found = list.find((t) => t.id === id);
  if (!found) return { task: null, depth: list.length };
  const next = list.filter((t) => t.id !== id);
  await writeTasks(store, next);
  return { task: found, depth: next.length };
}

/**
 * 执行器心跳（节流：默认 5 分钟内只写一次；有任务领走或 force 时立即写）
 */
export async function heartbeat(store, info = {}, { now = Date.now() } = {}) {
  const prev = await store.get(EXECUTOR_KEY, null);
  const prevTs = Number((prev && prev.ts) || 0);
  const fresh = prevTs > 0 && now - prevTs < HEARTBEAT_MIN_MS;
  if (fresh && !info.force && !info.hasTasks) return prev;

  const next = {
    ts: now,
    iso: new Date(now).toISOString(),
    host: String(info.host || (prev && prev.host) || "").slice(0, 60),
    version: String(info.version || (prev && prev.version) || "").slice(0, 20),
    ip: String(info.ip || (prev && prev.ip) || "").slice(0, 60),
    ua: String(info.ua || "").slice(0, 90),
    poll: Number(info.poll || (prev && prev.poll) || 0)
  };
  await store.set(EXECUTOR_KEY, next);
  return next;
}

/** 执行器在线状态（给 /api/health 和界面用） */
export async function executorStatus(store, { now = Date.now() } = {}) {
  const info = await store.get(EXECUTOR_KEY, null);
  const ts = Number((info && info.ts) || 0);
  const ageMs = ts ? Math.max(0, now - ts) : null;
  const online = ts > 0 && ageMs !== null && ageMs < EXECUTOR_ONLINE_MS;
  return {
    online,
    seen: ts > 0,
    host: (info && info.host) || "",
    version: (info && info.version) || "",
    ip: (info && info.ip) || "",
    lastSeen: ts ? new Date(ts).toISOString() : "",
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    onlineWindowSeconds: Math.round(EXECUTOR_ONLINE_MS / 1000)
  };
}

/** 只把执行器需要的字段发出去 */
export function publicTask(t) {
  return {
    id: t.id,
    title: t.title,
    content: t.content,
    source: t.source,
    kind: t.kind,
    force: Boolean(t.force),
    ts: t.ts,
    tries: t.tries || 0
  };
}
