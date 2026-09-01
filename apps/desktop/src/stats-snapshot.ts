import { WrenyardIpcClient } from '@wrenyard/control-client';
import type {
  StatsDailySnapshot,
  StatsOutcomesSnapshot,
  StatsPeriod,
  StatsRankingSnapshot,
  StatsSnapshot,
  StatsTodaySnapshot,
  StatsWindowSnapshot,
} from './shell-contract.js';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_DAILY_ROWS = 365;
const MAX_RANKING_ROWS = 20;
const MAX_WINDOW_ROWS = 20;

export type StatsRequest = (method: 'stats.summary' | 'stats.today', params: Record<string, unknown>) => Promise<unknown>;

export async function readStatsSnapshot(ipcPath: string): Promise<StatsSnapshot> {
  const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  try {
    return await buildStatsSnapshot((method, params) => client.request(method, params));
  } finally {
    await client.close();
  }
}

export async function buildStatsSnapshot(request: StatsRequest): Promise<StatsSnapshot> {
  try {
    const summary = parseSummary(await request('stats.summary', { days: MAX_DAILY_ROWS, limit: MAX_RANKING_ROWS }));
    if (summary) return summary;
  } catch {
    // Older control planes may not expose the summary projection yet.
  }

  try {
    const today = parseToday(await request('stats.today', {}), false, true);
    if (today) {
      return {
        status: 'available',
        source: 'today',
        today,
        daily: [toDaily(today)],
        byProfile: [],
        byTask: [],
        windows: [],
      };
    }
  } catch {
    // The renderer gets a stable unavailable projection, never raw IPC errors.
  }

  return unavailableStatsSnapshot();
}

export function unavailableStatsSnapshot(): StatsSnapshot {
  return {
    status: 'unavailable',
    source: 'unavailable',
    today: null,
    daily: [],
    byProfile: [],
    byTask: [],
    windows: [],
  };
}

function parseSummary(value: unknown): StatsSnapshot | null {
  const record = asRecord(value);
  if (!record || record.source !== 'sqlite') return null;
  const today = parseToday(record.today, true);
  if (!today) return null;
  return {
    status: 'available',
    source: 'summary',
    today,
    daily: parseArray(record.daily, parseDaily, MAX_DAILY_ROWS),
    byProfile: parseArray(record.byProfile, parseProfileRanking, MAX_RANKING_ROWS),
    byTask: parseArray(record.byTask, parseTaskRanking, MAX_RANKING_ROWS),
    windows: parseArray(record.windows, parseWindow, 3),
  };
}

function parseToday(value: unknown, requireOutcomes: boolean, requireSqliteSource = false): StatsTodaySnapshot | null {
  const record = asRecord(value);
  if (!record || (requireSqliteSource && record.source !== 'sqlite')) return null;
  const base = parseTokenBucket(record);
  const startAt = readString(record.startAt);
  const endAt = readString(record.endAt);
  if (!base || startAt === null || endAt === null) return null;
  const outcomes = parseOutcomes(record.outcomes, true);
  if (requireOutcomes && !outcomes) return null;
  return { ...base, startAt, endAt, ...(outcomes ? { outcomes } : {}) };
}

function parseDaily(value: unknown): StatsDailySnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const base = parseTokenBucket(record);
  if (!base) return null;
  const outcomes = parseOutcomes(record.outcomes, false);
  return { ...base, ...(outcomes ? { outcomes } : {}) };
}

function parseTokenBucket(record: Record<string, unknown>): Omit<StatsTodaySnapshot, 'startAt' | 'endAt' | 'outcomes'> | null {
  const dayKey = readString(record.dayKey);
  const dispatchCount = readCount(record.dispatchCount);
  const inputTokens = readCount(record.inputTokens);
  const outputTokens = readCount(record.outputTokens);
  const totalTokens = readCount(record.totalTokens);
  if (dayKey === null || dispatchCount === null || inputTokens === null || outputTokens === null || totalTokens === null) return null;
  return { dayKey, dispatchCount, inputTokens, outputTokens, totalTokens };
}

function parseOutcomes(value: unknown, allowRunning: boolean): StatsOutcomesSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const done = readCount(record.done);
  const failed = readCount(record.failed);
  const cancelled = readCount(record.cancelled);
  if (done === null || failed === null || cancelled === null) return null;
  const running = allowRunning ? readCount(record.running) : null;
  return { done, failed, cancelled, ...(running !== null ? { running } : {}) };
}

function parseProfileRanking(value: unknown): StatsRankingSnapshot | null {
  const record = asRecord(value);
  return record ? parseRanking(record, 'profile') : null;
}

function parseTaskRanking(value: unknown): StatsRankingSnapshot | null {
  const record = asRecord(value);
  return record ? parseRanking(record, 'taskName') : null;
}

function parseRanking(record: Record<string, unknown>, nameKey: 'profile' | 'taskName'): StatsRankingSnapshot | null {
  const name = readString(record[nameKey]);
  const dispatchCount = readCount(record.dispatchCount);
  const totalTokens = readCount(record.totalTokens);
  if (name === null || dispatchCount === null || totalTokens === null) return null;
  return { name, dispatchCount, totalTokens };
}

function parseWindow(value: unknown): StatsWindowSnapshot | null {
  const record = asRecord(value);
  if (!record || !isPeriod(record.period)) return null;
  const startAt = readString(record.startAt);
  const endAt = readString(record.endAt);
  const dispatchCount = readCount(record.dispatchCount);
  const totalTokens = readCount(record.totalTokens);
  const taskStats = asRecord(record.taskStats);
  if (!taskStats) return null;
  const totalDurationMs = readCount(taskStats.totalDurationMs);
  const builtinTotalDurationMs = readCount(taskStats.builtinTotalDurationMs) ?? 0;
  if (startAt === null || endAt === null || dispatchCount === null || totalTokens === null || totalDurationMs === null) return null;
  return {
    period: record.period,
    startAt,
    endAt,
    dispatchCount,
    totalTokens,
    totalDurationMs,
    builtinTotalDurationMs,
    byProfile: parseArray(record.byProfile, parseWindowProfile, MAX_WINDOW_ROWS),
    byTask: parseArray(taskStats.byTask, parseWindowTask, MAX_WINDOW_ROWS),
    byBuiltinTask: parseArray(taskStats.byBuiltinTask, parseWindowTask, MAX_WINDOW_ROWS),
  };
}

function parseWindowProfile(value: unknown): StatsWindowSnapshot['byProfile'][number] | null {
  const record = asRecord(value);
  if (!record) return null;
  const name = readString(record.profile);
  const runCount = readCount(record.runCount);
  const totalTokens = readCount(record.totalTokens);
  const averageTps = readCount(record.averageTps);
  if (name === null || runCount === null || totalTokens === null) return null;
  return { name, runCount, totalTokens, ...(averageTps !== null ? { averageTps } : {}) };
}

function parseWindowTask(value: unknown): StatsWindowSnapshot['byTask'][number] | null {
  const record = asRecord(value);
  if (!record) return null;
  const name = readString(record.taskId);
  const source = record.source;
  const runCount = readCount(record.runCount);
  const durationMs = readCount(record.durationMs);
  const averageDurationMs = readCount(record.averageDurationMs);
  if (name === null || !isTaskSource(source) || runCount === null || durationMs === null || averageDurationMs === null) return null;
  return { name, source, runCount, durationMs, averageDurationMs };
}

function toDaily(today: StatsTodaySnapshot): StatsDailySnapshot {
  return {
    dayKey: today.dayKey,
    dispatchCount: today.dispatchCount,
    inputTokens: today.inputTokens,
    outputTokens: today.outputTokens,
    totalTokens: today.totalTokens,
    ...(today.outcomes ? {
      outcomes: {
        done: today.outcomes.done,
        failed: today.outcomes.failed,
        cancelled: today.outcomes.cancelled,
      },
    } : {}),
  };
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(value)) return [];
  const output: T[] = [];
  for (const item of value.slice(0, limit)) {
    const parsed = parse(item);
    if (parsed) output.push(parsed);
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isPeriod(value: unknown): value is StatsPeriod {
  return value === '24h' || value === '7d' || value === '1mo';
}

function isTaskSource(value: unknown): value is StatsWindowSnapshot['byTask'][number]['source'] {
  return value === 'builtin' || value === 'project' || value === 'unknown';
}
