import { WrenyardIpcClient } from '@wrenyard/control-client';
import type {
  StatsDailySnapshot,
  StatsOutcomesSnapshot,
  StatsPeriod,
  StatsRankingSnapshot,
  StatsSnapshot,
  StatsTodaySnapshot,
  StatsWindowSnapshot,
  TaskRunSnapshot,
  TaskRunSpeedEvidence,
  TaskRunUsage,
} from './shell-contract.js';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_DAILY_ROWS = 365;
const MAX_RANKING_ROWS = 20;
const MAX_WINDOW_ROWS = 20;
const MAX_TASK_RUN_ROWS = 50;

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
      recentTaskRuns: [],
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
    recentTaskRuns: [],
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
    recentTaskRuns: parseArray(record.recentRuns, parseTaskRunSnapshot, MAX_TASK_RUN_ROWS),
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
  if (!record) return null;
  const model = readString(record.model);
  const name = model;
  const dispatchCount = readCount(record.dispatchCount);
  const totalTokens = readCount(record.totalTokens);
  if (name === null || dispatchCount === null || totalTokens === null) return null;
  const result: StatsRankingSnapshot = { name, dispatchCount, totalTokens };
  if (model !== null) result.model = model;
  const modelDisplayName = readString(record.model_display_name);
  if (modelDisplayName !== null) result.modelDisplayName = modelDisplayName;
  const providerDisplayNames = parseProviderDisplayNames(record.provider_display_names);
  if (providerDisplayNames !== null) result.providerDisplayNames = providerDisplayNames;
  return result;
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
  const model = readString(record.model);
  const name = model;
  const runCount = readCount(record.runCount);
  const totalTokens = readCount(record.totalTokens);
  const averageTps = readCount(record.averageTps);
  if (name === null || runCount === null || totalTokens === null) return null;
  const result: StatsWindowSnapshot['byProfile'][number] = { name, runCount, totalTokens };
  if (model !== null) result.model = model;
  if (averageTps !== null) result.averageTps = averageTps;
  const modelDisplayName = readString(record.model_display_name);
  if (modelDisplayName !== null) result.modelDisplayName = modelDisplayName;
  const providerDisplayNames = parseProviderDisplayNames(record.provider_display_names);
  if (providerDisplayNames !== null) result.providerDisplayNames = providerDisplayNames;
  return result;
}

function parseProviderDisplayNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 256) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.length > 0 ? result : null;
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

export function parseTaskRunSnapshot(value: unknown): TaskRunSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const taskRunId = readTaskRunId(record.task_run_id);
  const taskId = readTaskId(record.task) ?? readTaskId(record.task_id);
  if (taskRunId === null || taskId === null) return null;

  const sourceValue = record.source;
  const statusValue = record.status;
  const resolvedRecord = asRecord(record.resolved);
  const speedRecord = resolvedRecord ? resolvedRecord.speed : record['resolved.speed'];
  const speed = parseTaskRunSpeed(speedRecord);
  const usage = parseTaskRunUsage(record.usage);
  if (!usage) return null;
  const resolvedClient = readString(resolvedRecord?.client) ?? readString(record.resolved_client);
  const resolvedProvider = readString(resolvedRecord?.provider) ?? readString(record.resolved_provider);
  const resolvedProfile = readString(resolvedRecord?.profile) ?? readString(record.resolved_profile);
  const resolvedModel = readString(resolvedRecord?.model) ?? readString(record.resolved_model);
  const resolvedModelId = readString(resolvedRecord?.model_id) ?? readString(record.resolved_model_id);
  const providerDisplayName = readString(record.provider_display_name);
  const modelDisplayName = readString(record.model_display_name);
  // Paired Catalog display labels travel only when the server row carries both
  // as nonempty strings; they are never derived from resolved identities and
  // one is never copied when its sibling is missing.
  const displayLabels =
    providerDisplayName !== null &&
    providerDisplayName.length > 0 &&
    modelDisplayName !== null &&
    modelDisplayName.length > 0
      ? {
          resolvedProviderDisplayName: providerDisplayName,
          resolvedModelDisplayName: modelDisplayName,
        }
      : null;

  return {
    taskRunId,
    taskId,
    ...(typeof record.task_name === 'string' && record.task_name.length > 0 ? { taskName: record.task_name } : {}),
    ...(isTaskSource(sourceValue) ? { source: sourceValue } : {}),
    ...(isTaskRunStatus(statusValue) ? { status: statusValue } : {}),
    ...(readString(record.started_at) !== null ? { startedAt: record.started_at as string } : {}),
    ...(readString(record.finished_at) !== null ? { finishedAt: record.finished_at as string } : {}),
    ...(readString(record.project) !== null ? { project: record.project as string } : {}),
    ...(resolvedClient !== null ? { resolvedClient } : {}),
    ...(resolvedProvider !== null ? { resolvedProvider } : {}),
    ...(resolvedProfile !== null ? { resolvedProfile } : {}),
    ...(resolvedModel !== null ? { resolvedModel } : {}),
    ...(resolvedModelId !== null ? { resolvedModelId } : {}),
    ...(displayLabels !== null ? displayLabels : {}),
    ...(speed ? { speed } : {}),
    usage,
  };
}

function parseTaskRunSpeed(value: unknown): TaskRunSpeedEvidence | null {
  const record = asRecord(value);
  if (!record) return null;
  const effectiveTps = readCount(record.effective_tps);
  const source = readSpeedSource(record.source);
  if (effectiveTps === null || source === null) return null;
  const sampleCount = readCount(record.sample_count);
  const expectedTpsMet = readBoolean(record.expected_tps_met);
  return {
    effectiveTps,
    source,
    sampleCount: sampleCount !== null ? sampleCount : null,
    expectedTpsMet: expectedTpsMet !== null ? expectedTpsMet : null,
    ...(typeof record.degradation_reason === 'string' && record.degradation_reason.length > 0
      ? { degradationReason: record.degradation_reason }
      : {}),
  };
}

function parseTaskRunUsage(value: unknown): TaskRunUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const attemptCount = readCount(record.attempt_count);
  const usageEventCount = readCount(record.usage_event_count);
  if (attemptCount === null || usageEventCount === null) return null;
  const completeness = readCompleteness(record.completeness);
  const referenceCostUsd = readNumber(record.reference_cost_usd);
  const referenceCostComplete = record.reference_cost_complete === true;
  if (referenceCostComplete && referenceCostUsd === null) return null;
  // A missing reference cost is retained as `undefined` (not dropped) for runs
  // that are not fully costed; a real numeric zero is preserved verbatim and is
  // not substituted. Structural validation above (attempt/usage counts) still
  // applies, so unrelated malformed rows are rejected.
  return {
    completeness: completeness ?? (referenceCostComplete ? 'complete' : 'partial'),
    attemptCount,
    usageEventCount,
    ...(readNumber(record.input_tokens) !== null ? { inputTokens: record.input_tokens as number } : {}),
    ...(readNumber(record.cached_input_tokens) !== null ? { cachedInputTokens: record.cached_input_tokens as number } : {}),
    ...(readNumber(record.cache_read_input_tokens) !== null ? { cacheReadInputTokens: record.cache_read_input_tokens as number } : {}),
    ...(readNumber(record.cache_creation_input_tokens) !== null ? { cacheCreationInputTokens: record.cache_creation_input_tokens as number } : {}),
    ...(readNumber(record.output_tokens) !== null ? { outputTokens: record.output_tokens as number } : {}),
    ...(readNumber(record.total_tokens) !== null ? { totalTokens: record.total_tokens as number } : {}),
    ...(readNumber(record.agent_turn_ms) !== null ? { agentTurnMs: record.agent_turn_ms as number } : {}),
    ...(readNumber(record.output_tps) !== null ? { outputTps: record.output_tps as number } : {}),
    ...(record.tps_contract === 'agent_turn_v1' ? { tpsContract: 'agent_turn_v1' as const } : {}),
    ...(referenceCostUsd !== null ? { referenceCostUsd } : {}),
    referenceCostComplete,
    ...(typeof record.reference_cost_basis === 'string' && record.reference_cost_basis.length > 0
      ? { referenceCostBasis: record.reference_cost_basis }
      : {}),
  };
}

function readTaskRunId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function readTaskId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readSpeedSource(value: unknown): TaskRunSpeedEvidence['source'] | null {
  return value === 'local_31d' || value === 'provider_override' || value === 'catalog_default' ? value : null;
}

function readCompleteness(value: unknown): TaskRunUsage['completeness'] | null {
  return value === 'complete' || value === 'partial' || value === 'unavailable' ? value : null;
}

function isTaskRunStatus(value: unknown): value is TaskRunSnapshot['status'] {
  return value === 'done' || value === 'failed' || value === 'cancelled' || value === 'interrupted'
    || value === 'running' || value === 'queued';
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
