import type { DailyStatsSnapshot } from '../shared/snapshot';
import type { DiagnosticLogger } from './diagnostic-logger';
import { ForemanIpcClient, resolveForemanIpcPath } from './foreman-ipc-client';
import type { ForemanIpcRequestOptions } from './foreman-ipc-client';

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 60000;

export const SUMMARY_REQUEST_TIMEOUT_MS = 30000;

export type ForemanStatsRequest = (method: string, params?: unknown, options?: ForemanIpcRequestOptions) => Promise<unknown>;

export interface SummaryStatsDailyEntry {
  dayKey: string;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'sqlite';
  outcomes?: { done: number; failed: number; cancelled: number };
}

export interface SummaryStatsRankRow {
  profile: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SummaryStatsTaskRow {
  taskName: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SummaryStatsTaskDurationRow {
  taskName: string;
  durationMs: number;
}

export interface SummaryStatsWindowProfileRow {
  profile: string;
  runCount: number;
  totalTokens: number;
  /** Optional finite average tokens-per-second; null/absent means unavailable. */
  averageTps?: number;
}

export interface SummaryStatsWindowTaskRow {
  taskId: string;
  source: 'builtin' | 'project' | 'unknown';
  runCount: number;
  durationMs: number;
}

export interface SummaryStatsWindowTaskStats {
  totalDurationMs: number;
  byTask: SummaryStatsWindowTaskRow[];
  builtinTotalDurationMs: number;
  byBuiltinTask: Array<{ taskId: string; runCount: number; durationMs: number }>;
}

export interface SummaryStatsWindow {
  period: '24h' | '7d' | '1mo';
  startAt: string;
  endAt: string;
  dispatchCount: number;
  totalTokens: number;
  byProfile: SummaryStatsWindowProfileRow[];
  taskStats: SummaryStatsWindowTaskStats;
}

export interface SummaryStatsTodayEntry {
  dayKey: string;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'sqlite';
  outcomes?: { done: number; failed: number; cancelled: number };
}

export interface SummaryStatsPayload {
  daily: SummaryStatsDailyEntry[];
  source?: string;
  today?: SummaryStatsTodayEntry;
  byProfile?: SummaryStatsRankRow[];
  byTask?: SummaryStatsTaskRow[];
  /** Optional atomic timing capability — both fields normalize together. */
  totalTaskDurationMs?: number;
  byTaskDuration?: SummaryStatsTaskDurationRow[];
  /** Optional exact 24h/7d/1mo window capability, validated atomically. */
  windows?: SummaryStatsWindow[];
}

export interface ForemanStatsPollerOptions {
  ipcPath?: string;
  intervalMs?: number;
  request?: ForemanStatsRequest;
  logger?: DiagnosticLogger;
  onStats: (stats: DailyStatsSnapshot) => void;
  onSummaryStats?: (summary: SummaryStatsPayload) => void;
  onUnavailable?: () => void;
}

export class ForemanStatsPoller {
  private readonly ipcPath: string;
  private readonly intervalMs: number;
  private readonly request: ForemanStatsRequest;
  private readonly logger: DiagnosticLogger | undefined;
  private readonly onStats: ForemanStatsPollerOptions['onStats'];
  private readonly onSummaryStats: ForemanStatsPollerOptions['onSummaryStats'];
  private readonly onUnavailable: ForemanStatsPollerOptions['onUnavailable'];
  private readonly client: ForemanIpcClient | undefined;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private running = false;
  private generation = 0;
  private lastErrorSignature: string | null = null;
  private consecutiveSummaryFailures = 0;

  constructor(opts: ForemanStatsPollerOptions) {
    this.ipcPath = opts.ipcPath ?? resolveForemanIpcPath();
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (opts.request) {
      this.request = opts.request;
    } else {
      this.client = new ForemanIpcClient({ path: this.ipcPath });
      this.request = (method, params, options?) => this.client!.request(method, params, options);
    }
    this.logger = opts.logger;
    this.onStats = opts.onStats;
    this.onSummaryStats = opts.onSummaryStats;
    this.onUnavailable = opts.onUnavailable;
  }

  getIpcPath(): string {
    return this.ipcPath;
  }

  start(): void {
    if (this.intervalId !== null || this.running) return;

    this.running = true;
    this.generation++;
    this.consecutiveSummaryFailures = 0;
    const generation = this.generation;
    void this.pollOnce(generation).then(() => this.scheduleNext(generation));
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearTimeout(this.intervalId);
    }
    this.intervalId = null;
    if (this.running) {
      this.running = false;
      this.generation++;
    }
  }

  async pollOnce(expectedGeneration?: number): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      await this.pollStats(expectedGeneration);
    } finally {
      this.inFlight = false;
    }
  }

  private scheduleNext(generation: number): void {
    if (this.isStoppedGeneration(generation)) {
      this.intervalId = null;
      return;
    }
    const delay = this.computeNextInterval();
    this.intervalId = setTimeout(() => {
      this.intervalId = null;
      void this.pollOnce(generation).then(() => this.scheduleNext(generation));
    }, delay);
  }

  private computeNextInterval(): number {
    if (this.consecutiveSummaryFailures === 0) {
      return this.intervalMs;
    }
    const multiplier = Math.pow(2, this.consecutiveSummaryFailures);
    return Math.min(this.intervalMs * multiplier, MAX_BACKOFF_MS);
  }

  private async pollStats(expectedGeneration?: number): Promise<void> {
    // Always try stats.summary first — retries every tick (no one-shot gate)
    try {
      const summaryPayload = await this.request('stats.summary', { days: 31, limit: 20 }, { timeoutMs: SUMMARY_REQUEST_TIMEOUT_MS });
      if (this.isStoppedGeneration(expectedGeneration)) return;
      const summary = normalizeStatsSummaryPayload(summaryPayload);
      // Valid summary response — reset failure count
      this.consecutiveSummaryFailures = 0;
      const latest = summary.today ?? summary.daily.at(-1);
      if (latest) {
        this.onStats(latest);
        this.onSummaryStats?.(summary);
        if (this.lastErrorSignature !== null) {
          this.logger?.info('foreman_stats_poll_recovered', { previousError: this.lastErrorSignature });
          this.lastErrorSignature = null;
        }
        return;
      }
      // Summary valid but has no today or daily entries — fall through to stats.today
      // (consecutiveSummaryFailures already reset above)
    } catch (err) {
      // Stale generation: return before logging, mutating failure state, or issuing fallback
      if (this.isStoppedGeneration(expectedGeneration)) return;
      const signature = err instanceof Error ? `${err.name}:${err.message}` : String(err);
      if (signature !== this.lastErrorSignature) {
        this.logger?.warn('foreman_stats_summary_fallback', {
          error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        this.lastErrorSignature = signature;
      }
      this.consecutiveSummaryFailures++;
    }

    // Fallback: stats.today
    try {
      const todayPayload = await this.request('stats.today', {});
      if (this.isStoppedGeneration(expectedGeneration)) return;
      const stats = normalizeStatsPayload(todayPayload);

      if (this.lastErrorSignature !== null) {
        this.logger?.info('foreman_stats_poll_recovered', { previousError: this.lastErrorSignature });
        this.lastErrorSignature = null;
      }
      this.onStats(stats);
    } catch (err) {
      // Stale generation: return before logging, mutating failure state, or issuing fallback
      if (this.isStoppedGeneration(expectedGeneration)) return;
      const signature = err instanceof Error ? `${err.name}:${err.message}` : String(err);
      if (signature !== this.lastErrorSignature) {
        this.logger?.warn('foreman_stats_poll_error', {
          error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        this.lastErrorSignature = signature;
      }
      this.onUnavailable?.();
    }
  }

  private isStoppedGeneration(expectedGeneration: number | undefined): boolean {
    return expectedGeneration !== undefined && (!this.running || this.generation !== expectedGeneration);
  }
}

export function normalizeStatsPayload(payload: unknown): DailyStatsSnapshot {
  if (!isRecord(payload)) {
    throw new TypeError('normalizeStatsPayload: payload must be a non-null object');
  }
  if (payload.source !== 'sqlite') {
    throw new TypeError(`normalizeStatsPayload: source must be "sqlite", got "${payload.source}"`);
  }
  if (typeof payload.dayKey !== 'string') {
    throw new TypeError('normalizeStatsPayload: dayKey must be a string');
  }
  if (typeof payload.startAt !== 'string') {
    throw new TypeError('normalizeStatsPayload: startAt must be a string');
  }
  if (typeof payload.endAt !== 'string') {
    throw new TypeError('normalizeStatsPayload: endAt must be a string');
  }

  const dispatchCount = nonNegativeFiniteStrict(payload.dispatchCount, 'dispatchCount');
  const inputTokens = nonNegativeFiniteStrict(payload.inputTokens, 'inputTokens');
  const outputTokens = nonNegativeFiniteStrict(payload.outputTokens, 'outputTokens');
  const totalTokens = nonNegativeFiniteStrict(payload.totalTokens, 'totalTokens');

  return {
    dayKey: payload.dayKey,
    startAt: payload.startAt,
    endAt: payload.endAt,
    dispatchCount,
    inputTokens,
    outputTokens,
    totalTokens,
    source: 'sqlite',
  };
}

export function normalizeStatsSummaryPayload(payload: unknown): SummaryStatsPayload {
  if (!isRecord(payload)) {
    throw new TypeError('normalizeStatsSummaryPayload: payload must be a non-null object');
  }

  const rawDaily = payload.daily;
  if (!Array.isArray(rawDaily)) {
    throw new TypeError('normalizeStatsSummaryPayload: payload.daily must be an array');
  }

  // Source can be at top level; inherit for each entry that omits it
  const topLevelSource = payload.source;

  const daily: SummaryStatsDailyEntry[] = [];
  for (let i = 0; i < rawDaily.length; i++) {
    const entry = rawDaily[i];
    if (!isRecord(entry)) {
      throw new TypeError(`normalizeStatsSummaryPayload: daily[${i}] must be a non-null object`);
    }

    if (typeof entry.dayKey !== 'string') {
      throw new TypeError(`normalizeStatsSummaryPayload: daily[${i}].dayKey must be a string`);
    }

    // Source: prefer per-entry, fall back to top-level
    const source = entry.source ?? topLevelSource;
    if (typeof source !== 'string') {
      throw new TypeError(`normalizeStatsSummaryPayload: daily[${i}].source must be a string`);
    }
    if (source !== 'sqlite') {
      throw new TypeError(`normalizeStatsSummaryPayload: daily[${i}].source must be "sqlite"`);
    }

    // Support both simplified format (count/token/outcomes) and legacy (dispatchCount/etc)
    let dispatchCount: number;
    let inputTokens: number;
    let outputTokens: number;
    let totalTokens: number;

    if (typeof entry.count === 'number' && typeof entry.token === 'number' && isRecord(entry.outcomes)) {
      dispatchCount = nonNegativeFiniteStrict(entry.count, `daily[${i}].count`);
      totalTokens = nonNegativeFiniteStrict(entry.token, `daily[${i}].token`);
      inputTokens = nonNegativeFiniteStrict(entry.outcomes.inputTokens ?? 0, `daily[${i}].outcomes.inputTokens`);
      outputTokens = nonNegativeFiniteStrict(entry.outcomes.outputTokens ?? 0, `daily[${i}].outcomes.outputTokens`);
    } else {
      dispatchCount = nonNegativeFiniteStrict(entry.dispatchCount, `daily[${i}].dispatchCount`);
      inputTokens = nonNegativeFiniteStrict(entry.inputTokens, `daily[${i}].inputTokens`);
      outputTokens = nonNegativeFiniteStrict(entry.outputTokens, `daily[${i}].outputTokens`);
      totalTokens = nonNegativeFiniteStrict(entry.totalTokens, `daily[${i}].totalTokens`);
    }

    // Preserve optional outcomes (done/failed/cancelled) from the RPC
    let outcomes: { done: number; failed: number; cancelled: number } | undefined;
    if (isRecord(entry.outcomes)) {
      const o = entry.outcomes;
      if (typeof o.done === 'number' && typeof o.failed === 'number' && typeof o.cancelled === 'number') {
        outcomes = {
          done: nonNegativeFiniteStrict(o.done, `daily[${i}].outcomes.done`),
          failed: nonNegativeFiniteStrict(o.failed, `daily[${i}].outcomes.failed`),
          cancelled: nonNegativeFiniteStrict(o.cancelled, `daily[${i}].outcomes.cancelled`),
        };
      }
    }

    // Derive startAt/endAt from dayKey when bounds are absent
    let startAt: string;
    let endAt: string;
    if (typeof entry.startAt === 'string' && typeof entry.endAt === 'string') {
      startAt = entry.startAt;
      endAt = entry.endAt;
    } else {
      const interval = deriveDayInterval(entry.dayKey);
      startAt = interval.startAt;
      endAt = interval.endAt;
    }

    daily.push({
      dayKey: entry.dayKey,
      startAt,
      endAt,
      dispatchCount,
      inputTokens,
      outputTokens,
      totalTokens,
      source: 'sqlite',
      outcomes,
    });
  }

  // Source at top level
  const source = typeof payload.source === 'string' ? payload.source : undefined;

  // Normalize optional today
  let today: SummaryStatsTodayEntry | undefined;
  if (isRecord(payload.today)) {
    const t = payload.today;
    if (typeof t.dayKey !== 'string') throw new TypeError('normalizeStatsSummaryPayload: today.dayKey must be a string');
    if (typeof t.startAt !== 'string') throw new TypeError('normalizeStatsSummaryPayload: today.startAt must be a string');
    if (typeof t.endAt !== 'string') throw new TypeError('normalizeStatsSummaryPayload: today.endAt must be a string');
    today = {
      dayKey: t.dayKey,
      startAt: t.startAt,
      endAt: t.endAt,
      dispatchCount: nonNegativeFiniteStrict(t.dispatchCount, 'today.dispatchCount'),
      inputTokens: nonNegativeFiniteStrict(t.inputTokens, 'today.inputTokens'),
      outputTokens: nonNegativeFiniteStrict(t.outputTokens, 'today.outputTokens'),
      totalTokens: nonNegativeFiniteStrict(t.totalTokens, 'today.totalTokens'),
      source: 'sqlite',
      outcomes: isRecord(t.outcomes)
        ? {
            done: nonNegativeFiniteStrict(t.outcomes.done, 'today.outcomes.done'),
            failed: nonNegativeFiniteStrict(t.outcomes.failed, 'today.outcomes.failed'),
            cancelled: nonNegativeFiniteStrict(t.outcomes.cancelled, 'today.outcomes.cancelled'),
          }
        : undefined,
    };
  }

  // Normalize optional byProfile
  let byProfile: SummaryStatsRankRow[] | undefined;
  if (Array.isArray(payload.byProfile)) {
    byProfile = [];
    for (let i = 0; i < payload.byProfile.length; i++) {
      const row = payload.byProfile[i];
      if (!isRecord(row)) throw new TypeError(`normalizeStatsSummaryPayload: byProfile[${i}] must be a non-null object`);
      if (typeof row.profile !== 'string' || row.profile.length === 0) throw new TypeError(`normalizeStatsSummaryPayload: byProfile[${i}].profile must be a nonempty string`);
      byProfile.push({
        profile: row.profile,
        dispatchCount: nonNegativeFiniteStrict(row.dispatchCount, `byProfile[${i}].dispatchCount`),
        inputTokens: nonNegativeFiniteStrict(row.inputTokens, `byProfile[${i}].inputTokens`),
        outputTokens: nonNegativeFiniteStrict(row.outputTokens, `byProfile[${i}].outputTokens`),
        totalTokens: nonNegativeFiniteStrict(row.totalTokens, `byProfile[${i}].totalTokens`),
      });
    }
  }

  // Normalize optional byTask
  let byTask: SummaryStatsTaskRow[] | undefined;
  if (Array.isArray(payload.byTask)) {
    byTask = [];
    for (let i = 0; i < payload.byTask.length; i++) {
      const row = payload.byTask[i];
      if (!isRecord(row)) throw new TypeError(`normalizeStatsSummaryPayload: byTask[${i}] must be a non-null object`);
      if (typeof row.taskName !== 'string' || row.taskName.length === 0) throw new TypeError(`normalizeStatsSummaryPayload: byTask[${i}].taskName must be a nonempty string`);
      byTask.push({
        taskName: row.taskName,
        dispatchCount: nonNegativeFiniteStrict(row.dispatchCount, `byTask[${i}].dispatchCount`),
        inputTokens: nonNegativeFiniteStrict(row.inputTokens, `byTask[${i}].inputTokens`),
        outputTokens: nonNegativeFiniteStrict(row.outputTokens, `byTask[${i}].outputTokens`),
        totalTokens: nonNegativeFiniteStrict(row.totalTokens, `byTask[${i}].totalTokens`),
      });
    }
  }

  // Normalize optional atomic timing capability. Both totalTaskDurationMs and
  // byTaskDuration must be present, individually valid, and mutually coherent:
  // a zero total is valid only with an empty row list, a positive total requires
  // at least one positive row, every row must be <= total, and the safe sum of
  // row durations must be <= total (truncated rankings with a sum below total
  // are kept). A partial, malformed, or incoherent capability is omitted as a
  // unit rather than partially applied; legacy payloads with neither field stay
  // unchanged.
  let totalTaskDurationMs: number | undefined;
  let byTaskDuration: SummaryStatsTaskDurationRow[] | undefined;
  if (isNonNegativeSafeInt(payload.totalTaskDurationMs) && Array.isArray(payload.byTaskDuration)) {
    const total = payload.totalTaskDurationMs;
    const rows: SummaryStatsTaskDurationRow[] = [];
    let valid = true;
    for (let i = 0; i < payload.byTaskDuration.length; i++) {
      const row = payload.byTaskDuration[i];
      if (!isRecord(row) || typeof row.taskName !== 'string' || row.taskName.length === 0 || !isNonNegativeSafeInt(row.durationMs)) {
        valid = false;
        break;
      }
      rows.push({ taskName: row.taskName, durationMs: row.durationMs });
    }
    if (valid && isCoherentTimingCapability(total, rows)) {
      totalTaskDurationMs = total;
      byTaskDuration = rows;
    }
  }

  const summary: SummaryStatsPayload = { daily, source, today, byProfile, byTask };
  if (totalTaskDurationMs !== undefined && byTaskDuration !== undefined) {
    summary.totalTaskDurationMs = totalTaskDurationMs;
    summary.byTaskDuration = byTaskDuration;
  }
  if (payload.windows !== undefined) {
    summary.windows = normalizeStatsSummaryWindows(payload.windows);
  }
  return summary;
}

const WINDOW_PERIODS = ['24h', '7d', '1mo'] as const;

/**
 * Validates the optional stats.summary.windows capability atomically in the
 * main process. When present it must be exactly the three coherent periods in
 * order (24h, 7d, 1mo) with non-negative finite metrics, optional finite
 * averageTps, and task rows whose source is builtin|project|unknown. Any
 * partial, malformed, or incoherent windows capability is rejected with a
 * thrown TypeError so the poller falls back to stats.today rather than
 * partially applying a broken capability.
 */
export function normalizeStatsSummaryWindows(raw: unknown): SummaryStatsWindow[] {
  if (!Array.isArray(raw)) {
    throw new TypeError('normalizeStatsSummaryPayload: windows must be an array');
  }
  if (raw.length !== WINDOW_PERIODS.length) {
    throw new TypeError(`normalizeStatsSummaryPayload: windows must have exactly ${WINDOW_PERIODS.length} entries, got ${raw.length}`);
  }

  const windows: SummaryStatsWindow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const expectedPeriod = WINDOW_PERIODS[i];
    const entry = raw[i];
    if (!isRecord(entry)) {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}] must be a non-null object`);
    }
    if (entry.period !== expectedPeriod) {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].period must be "${expectedPeriod}", got "${String(entry.period)}"`);
    }
    if (typeof entry.startAt !== 'string') {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].startAt must be a string`);
    }
    if (typeof entry.endAt !== 'string') {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].endAt must be a string`);
    }
    const dispatchCount = nonNegativeFiniteStrict(entry.dispatchCount, `windows[${i}].dispatchCount`);
    const totalTokens = nonNegativeFiniteStrict(entry.totalTokens, `windows[${i}].totalTokens`);

    if (!Array.isArray(entry.byProfile)) {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].byProfile must be an array`);
    }
    const byProfile: SummaryStatsWindowProfileRow[] = [];
    for (let j = 0; j < entry.byProfile.length; j++) {
      const row = entry.byProfile[j];
      if (!isRecord(row)) throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].byProfile[${j}] must be a non-null object`);
      if (typeof row.profile !== 'string' || row.profile.length === 0) {
        throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].byProfile[${j}].profile must be a nonempty string`);
      }
      const runCount = nonNegativeFiniteStrict(row.runCount, `windows[${i}].byProfile[${j}].runCount`);
      const rowTokens = nonNegativeFiniteStrict(row.totalTokens, `windows[${i}].byProfile[${j}].totalTokens`);
      let averageTps: number | undefined;
      if (row.averageTps !== undefined && row.averageTps !== null) {
        if (typeof row.averageTps !== 'number' || !Number.isFinite(row.averageTps)) {
          throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].byProfile[${j}].averageTps must be a finite number when present`);
        }
        averageTps = row.averageTps;
      }
      byProfile.push(averageTps === undefined
        ? { profile: row.profile, runCount, totalTokens: rowTokens }
        : { profile: row.profile, runCount, totalTokens: rowTokens, averageTps });
    }

    if (!isRecord(entry.taskStats)) {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats must be a non-null object`);
    }
    const ts = entry.taskStats;
    const totalDurationMs = nonNegativeFiniteStrict(ts.totalDurationMs, `windows[${i}].taskStats.totalDurationMs`);
    const builtinTotalDurationMs = nonNegativeFiniteStrict(ts.builtinTotalDurationMs, `windows[${i}].taskStats.builtinTotalDurationMs`);

    if (!Array.isArray(ts.byTask)) {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats.byTask must be an array`);
    }
    const byTask: SummaryStatsWindowTaskRow[] = [];
    for (let j = 0; j < ts.byTask.length; j++) {
      const row = ts.byTask[j];
      if (!isRecord(row)) throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats.byTask[${j}] must be a non-null object`);
      if (typeof row.taskId !== 'string' || row.taskId.length === 0) {
        throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats.byTask[${j}].taskId must be a nonempty string`);
      }
      if (row.source !== 'builtin' && row.source !== 'project' && row.source !== 'unknown') {
        throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats.byTask[${j}].source must be "builtin", "project", or "unknown", got "${String(row.source)}"`);
      }
      byTask.push({
        taskId: row.taskId,
        source: row.source,
        runCount: nonNegativeFiniteStrict(row.runCount, `windows[${i}].taskStats.byTask[${j}].runCount`),
        durationMs: nonNegativeFiniteStrict(row.durationMs, `windows[${i}].taskStats.byTask[${j}].durationMs`),
      });
    }

    if (!Array.isArray(ts.byBuiltinTask)) {
      throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats.byBuiltinTask must be an array`);
    }
    const byBuiltinTask: Array<{ taskId: string; runCount: number; durationMs: number }> = [];
    for (let j = 0; j < ts.byBuiltinTask.length; j++) {
      const row = ts.byBuiltinTask[j];
      if (!isRecord(row)) throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats.byBuiltinTask[${j}] must be a non-null object`);
      if (typeof row.taskId !== 'string' || row.taskId.length === 0) {
        throw new TypeError(`normalizeStatsSummaryPayload: windows[${i}].taskStats.byBuiltinTask[${j}].taskId must be a nonempty string`);
      }
      byBuiltinTask.push({
        taskId: row.taskId,
        runCount: nonNegativeFiniteStrict(row.runCount, `windows[${i}].taskStats.byBuiltinTask[${j}].runCount`),
        durationMs: nonNegativeFiniteStrict(row.durationMs, `windows[${i}].taskStats.byBuiltinTask[${j}].durationMs`),
      });
    }

    windows.push({
      period: expectedPeriod,
      startAt: entry.startAt,
      endAt: entry.endAt,
      dispatchCount,
      totalTokens,
      byProfile,
      taskStats: { totalDurationMs, byTask, builtinTotalDurationMs, byBuiltinTask },
    });
  }
  return windows;
}

function deriveDayInterval(dayKey: string): { startAt: string; endAt: string } {
  // Foreman stores daily intervals ending at 16:00 UTC
  const endDate = new Date(dayKey + 'T16:00:00.000Z');
  const endAt = endDate.toISOString();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const startAt = startDate.toISOString();
  return { startAt, endAt };
}

function nonNegativeFiniteStrict(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`normalizeStatsPayload: ${field} must be a non-negative finite number, got ${typeof value} ${JSON.stringify(value)}`);
  }
  return value;
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCoherentTimingCapability(total: number, rows: SummaryStatsTaskDurationRow[]): boolean {
  if (total === 0) {
    return rows.length === 0;
  }
  // A positive total must be backed by at least one row with positive duration
  if (rows.length === 0 || rows.every((row) => row.durationMs === 0)) {
    return false;
  }
  // Every row must be <= total; the running sum short-circuits once it exceeds
  // total, so it never accumulates beyond a safe, bounded magnitude.
  let sum = 0;
  for (const row of rows) {
    if (row.durationMs > total) return false;
    sum += row.durationMs;
    if (sum > total) return false;
  }
  return sum <= total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
