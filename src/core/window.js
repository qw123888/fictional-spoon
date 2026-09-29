/**
 * 时间段模块
 * ------------------------------------------------------------
 * 只做一件事：给定时区 + 配置，回答"现在能不能打电话"。
 * 所有时间判断都集中在这里，其他模块不许自己 new Date() 比较时间。
 */
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "08:05" -> 485（分钟）；非法返回 null */
export function parseHHMM(text) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** 取指定时区的"人看的时间" */
export function zonedParts(date = new Date(), tz = "Asia/Shanghai") {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const hour = Number(p.hour) % 24; // 某些 ICU 版本 24:00 表示午夜
  const minute = Number(p.minute);
  return {
    weekday: WEEKDAY_INDEX[p.weekday] ?? 0,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute,
    second: Number(p.second),
    minutes: hour * 60 + minute,
    hhmm: `${pad(hour)}:${pad(minute)}`,
    dateKey: `${p.year}-${p.month}-${p.day}`,
    hourKey: `${p.year}-${p.month}-${p.day} ${pad(hour)}`
  };
}

/** 单个区间命中判断，支持跨天（from > to） */
export function hitRange(minutes, [from, to]) {
  const a = parseHHMM(from);
  const b = parseHHMM(to);
  if (a === null || b === null) return false;
  if (a === b) return true;          // 00:00-00:00 视为全天
  if (a < b) return minutes >= a && minutes < b;
  return minutes >= a || minutes < b; // 跨天
}

export function hitRanges(minutes, ranges) {
  return (ranges || []).some((r) => hitRange(minutes, r));
}

/**
 * 判断现在是否允许拨打
 * @returns {{active:boolean, allowed:boolean, reason:string, detail:string, now:object}}
 *   active  = 当前是否落在"可拨打的时间段"内（不含总开关）
 *   allowed = 结合 mode 后的最终结论
 */
export function evaluateWindow(cfg, date = new Date()) {
  const w = cfg.window;
  const now = zonedParts(date, w.tz);
  const dayOk = w.days.includes(now.weekday);
  const timeOk = hitRanges(now.minutes, w.ranges);
  const inside = dayOk && timeOk;
  const active = w.mode === "inside" ? inside : !inside;
  const span = w.ranges.map(([a, b]) => `${a}-${b}`).join("、");
  const dayText = w.days.length === 7 ? "每天" : w.days.map((d) => WEEKDAY_CN[d]).join("/");
  const detail = `${dayText} ${span}（${w.tz} 现在 ${now.hhmm} ${WEEKDAY_CN[now.weekday]}）`;
  return {
    active,
    allowed: active,
    reason: active ? "window_active" : "window_inactive",
    detail,
    now
  };
}

/** 给界面用的一句话描述 */
export function describeWindow(cfg) {
  const w = cfg.window;
  const span = w.ranges.map(([a, b]) => `${a}-${b}`).join("、");
  const dayText = w.days.length === 7 ? "每天" : w.days.map((d) => WEEKDAY_CN[d]).join("/");
  const modeText = w.mode === "inside" ? "仅在时间段内拨打" : "仅在时间段外拨打";
  return `${modeText}：${dayText} ${span}（时区 ${w.tz}）`;
}
