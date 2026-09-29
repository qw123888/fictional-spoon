/**
 * 防轰炸模块（去重 / 最小间隔 / 每小时上限）
 * ------------------------------------------------------------
 * check() 只读判断，commit() 才真正占额度 —— 两段式，方便将来插入"发送成功才计数"之类的策略。
 * 额度数据放在 Store 里，跨 isolate 生效（KV 最终一致，秒级延迟可接受）。
 */
const FP_KEY = (fp) => `guard:fp:${fp}`;
const LAST_KEY = "guard:last";
const HOUR_KEY = (hourKey) => `guard:h:${hourKey}`;

export async function checkGuard({ store, guard }, { fingerprint, nowMs, hourKey }) {
  const dedupeMs = (guard.dedupeSeconds || 0) * 1000;
  if (dedupeMs > 0 && fingerprint) {
    const rec = await store.get(FP_KEY(fingerprint), null);
    if (rec && nowMs - Number(rec.t || 0) < dedupeMs) {
      const left = Math.ceil((dedupeMs - (nowMs - Number(rec.t))) / 1000);
      return { allow: false, reason: "duplicate", detail: `同一条消息 ${left}s 内已通知过，已跳过` };
    }
  }

  const minMs = (guard.minIntervalSeconds || 0) * 1000;
  if (minMs > 0) {
    const last = await store.get(LAST_KEY, null);
    if (last && nowMs - Number(last || 0) < minMs) {
      const left = Math.ceil((minMs - (nowMs - Number(last))) / 1000);
      return { allow: false, reason: "rate_limited", detail: `距上一通电话不足 ${guard.minIntervalSeconds}s，还需等 ${left}s` };
    }
  }

  const hour = await store.get(HOUR_KEY(hourKey), null);
  const used = Number(hour?.count || 0);
  if (used >= guard.maxPerHour) {
    return { allow: false, reason: "hourly_quota", detail: `本小时已打 ${used} 通，达到上限 ${guard.maxPerHour}` };
  }

  return { allow: true, reason: "ok", detail: "", used };
}

export async function commitGuard({ store, guard }, { fingerprint, nowMs, hourKey }) {
  if (fingerprint && guard.dedupeSeconds > 0) await store.set(FP_KEY(fingerprint), { t: nowMs });
  if (guard.minIntervalSeconds > 0) await store.set(LAST_KEY, nowMs);
  const hour = await store.get(HOUR_KEY(hourKey), null);
  const used = Number(hour?.count || 0) + 1;
  await store.set(HOUR_KEY(hourKey), { count: used, t: nowMs });
  return used;
}

export async function guardStatus({ store, guard }, { hourKey }) {
  const hour = await store.get(HOUR_KEY(hourKey), null);
  const last = await store.get(LAST_KEY, null);
  return {
    usedThisHour: Number(hour?.count || 0),
    maxPerHour: guard.maxPerHour,
    lastSendAt: last ? new Date(Number(last)).toISOString() : null
  };
}

/** 从一条信号里抽出"内容指纹"，用于去重 */
export function fingerprintOf(signal) {
  const raw = `${signal.source || ""}|${signal.channel || ""}|${signal.title || ""}|${signal.content || ""}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
