/** Formatting helpers shared across the renderer. All output is product UI copy. */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `12s`, `3m 12s`, `1h 03m`. */
export function formatElapsedMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${pad2(minutes % 60)}m`;
}

export function elapsedBetween(start: string, end: string | undefined, now: number): number {
  const from = Date.parse(start);
  const to = end === undefined ? now : Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, to - from);
}

/** `HH:mm` in local time. */
export function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `HH:mm:ss` in local time. */
export function formatClockSeconds(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Full local date-time, for tooltips. */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** `09-30 22:31`, the compact snapshot stamp shown in the session title card. */
export function formatSnapshotStamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Build-time stamp in the local timezone with second precision; `undefined`
 * (or empty) renders as an em dash. An optional IANA timezone converts the
 * displayed instant, and unparseable input stays inspectable verbatim.
 */
export function formatBuildTime(value: string | undefined, timeZone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

function trimOneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** `42`, `45.1k`, `1.2M`; `undefined` renders as an em dash. */
export function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trimOneDecimal(value / 1000)}k`;
  return `${trimOneDecimal(value / 1_000_000)}M`;
}

/** Grouped integer, e.g. `1,234`; used for the small counts in the title card. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

export type DateGroup = '今天' | '昨天' | '7 天内' | '更早';

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Session-list bucket for an `updatedAt` stamp. */
export function dateGroupOf(value: string, now: number): DateGroup {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '更早';
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return '7 天内';
  return '更早';
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/**
 * Chat divider stamp: `今天 18:32`, `昨天 09:05`, `周二 14:20`, `9月30日 08:00`.
 * The weekday form covers the last seven calendar days; older stamps fall back
 * to the absolute month-day.
 */
export function formatDivider(value: string, now: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const days = Math.round((startOfDay(now) - startOfDay(date.getTime())) / 86_400_000);
  if (days <= 0) return `今天 ${clock}`;
  if (days === 1) return `昨天 ${clock}`;
  if (days < 7) return `${WEEKDAY[date.getDay()]} ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}
