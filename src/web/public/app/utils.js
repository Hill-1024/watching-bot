export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function fmtNum(n, digits = 0) {
  if (!Number.isFinite(n)) return "-";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(n);
}

/** 坐标轴与紧凑数字:1.2 万 / 3.4 亿 */
export function compactNum(n) {
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${trimZero(n / 1e8)} 亿`;
  if (abs >= 1e4) return `${trimZero(n / 1e4)} 万`;
  if (abs >= 1000) return fmtNum(n, 0);
  return trimZero(n);
}

function trimZero(n) {
  const s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.0+$/, "").replace(/(\.\d)0+$/, "$1");
}

export function fmtPct(rate, digits = 1) {
  if (!Number.isFinite(rate)) return "-";
  return `${(rate * 100).toFixed(digits)}%`;
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtFullDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDay(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtMonthDay(ts) {
  return fmtDay(ts);
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return "-";
  const diff = Math.max(0, now - ts);
  if (diff < 3000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < HOUR_MS) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  return `${Math.floor(diff / DAY_MS)} 天前`;
}

export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms % DAY_MS) / HOUR_MS);
  const m = Math.floor((ms % HOUR_MS) / 60_000);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function dateToIso(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function isoToDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function isoToTs(iso) {
  return isoToDate(iso).getTime();
}

export const RANGE_PRESETS = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "最近 7 天" },
  { value: "14d", label: "最近 14 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "90d", label: "最近 90 天" },
  { value: "custom", label: "自定义始末" },
];

/** 预设范围:按本地时区取自然日边界,直到当前时刻 */
export function presetRange(preset, now = Date.now()) {
  const today = startOfDay(now);
  switch (preset) {
    case "today":
      return { since: today, until: now };
    case "yesterday":
      return { since: addDays(today, -1), until: today };
    case "7d":
      return { since: addDays(today, -6), until: now };
    case "14d":
      return { since: addDays(today, -13), until: now };
    case "30d":
      return { since: addDays(today, -29), until: now };
    case "90d":
      return { since: addDays(today, -89), until: now };
    default:
      return { since: today, until: now };
  }
}

export function customRange(startIso, endIso, now = Date.now()) {
  if (!startIso || !endIso) return null;
  const since = isoToTs(startIso);
  const endStart = isoToTs(endIso);
  if (!(endStart >= since)) return null;
  return { since, until: Math.min(now, addDays(endStart, 1)) };
}

export function rangeLabel(since, until) {
  return `${fmtFullDate(since)} - ${fmtFullDate(until)}`;
}

export function bucketLabel(ts, unit) {
  if (unit === "hour") return `${fmtDay(ts)} ${pad2(new Date(ts).getHours())}:00`;
  if (unit === "week") return `${fmtDay(ts)} 周`;
  return fmtDay(ts);
}

export function bucketUnitLabel(unit) {
  return unit === "hour" ? "按小时" : unit === "week" ? "按周" : "按天";
}

export function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  return raw.split("?")[0] || "overview";
}

export function navigate(route) {
  if (routeFromHash() === route) return;
  location.hash = `#/${route}`;
}

export function debounce(fn, ms = 250) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

export function pctDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
}

export function formatDelta(delta) {
  if (delta == null) return "-";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${(delta * 100).toFixed(1)}%`;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 极简 markdown 渲染:先转义再处理标题/列表/粗体/行内代码,避免 XSS */
export function renderMarkdown(src) {
  const lines = escapeHtml(src ?? "").split(/\r?\n/);
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(6, h[1].length + 1);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") out.push("<div class=\"md-gap\"></div>");
    else out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}
