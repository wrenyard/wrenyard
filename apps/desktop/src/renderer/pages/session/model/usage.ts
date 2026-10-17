import { isUsableTpsSample, rollingTps, tpsOfSample as tpsOf, weightedTps } from '@wrenyard/protocol/tps';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { ContextInspection, ContextItem, ContextItemKind, ContextLayerId, QuotaSnapshot, TaskRunUsage } from '@/shell-contract';
import type { SessionRoutesPreviewRole } from '@wrenyard/protocol';
import type { CallContextSnapshot, CallModel } from './types.js';
import { CALL_ROLE_LABEL } from './describe.js';

/**
 * Pure usage projections for the session page. No React, DOM, bridge or window
 * access lives here: the status-bar items render exactly what these functions
 * derive from a `ContextInspection`, the loaded
 * call models and a quota snapshot.
 *
 * The main reasoning view is forward-looking (context ledger spec): the budget
 * answers "how large will the *next* reasoning view be", not "how large was the
 * last request". Layer totals are authoritative for the total; individual items
 * only drive ordering and the composition breakdown (usage spec 3.1).
 */

/** Composition groups shown in the usage panel, in fixed display order. */
export type UsageGroupId =
  | 'resident'
  | 'workspace'
  | 'conversation'
  | 'material'
  | 'task'
  | 'runtime'
  | 'input';

/** Composition groups in fixed display order, shared by every usage surface. */
export const USAGE_GROUP_ORDER: readonly UsageGroupId[] = [
  'resident',
  'workspace',
  'conversation',
  'material',
  'task',
  'runtime',
  'input',
];

export interface UsageGroupView {
  id: UsageGroupId;
  label: string;
  tokens: number;
  /** CSS custom property, e.g. `var(--chart-1)`. */
  color: string;
}

/** Fixed colour per group so the legend stays stable as groups appear. */
const GROUP_COLOR: Record<UsageGroupId, string> = {
  resident: 'var(--chart-1)',
  workspace: 'var(--chart-2)',
  conversation: 'var(--chart-3)',
  material: 'var(--chart-4)',
  task: 'var(--chart-5)',
  runtime: 'var(--chart-1)',
  input: 'var(--chart-2)',
};

const GROUP_LABEL: Record<UsageGroupId, string> = {
  resident: '常驻',
  workspace: '工作区快照',
  conversation: '对话',
  material: '资料',
  task: '任务结果',
  runtime: '运行信息',
  input: '本次输入',
};

const RESIDENT_LAYERS: readonly ContextLayerId[] = ['wy-system', 'wy-global', 'wy-role'];
const CONVERSATION_KINDS: readonly ContextItemKind[] = ['user', 'assistant', 'thinking', 'reply', 'interrupt', 'error'];
const MATERIAL_KINDS: readonly ContextItemKind[] = ['doc', 'memory', 'search', 'files'];
const TASK_KINDS: readonly ContextItemKind[] = ['action-result', 'ws-update'];

export interface ContextBudgetView {
  /** Layer total plus the text currently in the input box. */
  total: number;
  /** Model context window; absent when the model declares none. */
  window: number | undefined;
  /** Reserved output allowance; absent when the model declares none. */
  reserved: number | undefined;
  /** `window - reserved`, the available input budget; absent when either is unknown. */
  available: number | undefined;
  /** `total / available`, undefined when the budget cannot be computed. */
  ratio: number | undefined;
  /** True only when both window and reserved are known and the total exceeds the budget. */
  exceeded: boolean;
}

/** Forward-looking context budget: the ring's ratio and the send-blocking flag. */
export function contextBudget(inspection: ContextInspection, inputTokens = 0): ContextBudgetView {
  const total = inspection.totalTokens + Math.max(0, inputTokens);
  const contextWindow = inspection.model.contextWindow;
  const reserved = inspection.model.maxOutputTokens;
  const available = contextWindow !== undefined && reserved !== undefined
    ? Math.max(0, contextWindow - reserved)
    : undefined;
  const ratio = available !== undefined && available > 0 ? total / available : undefined;
  return {
    total,
    window: contextWindow,
    reserved,
    available,
    ratio,
    exceeded: available !== undefined && total > available,
  };
}

function layerTokens(inspection: ContextInspection, ids: readonly ContextLayerId[]): number {
  let total = 0;
  for (const layer of inspection.layers) {
    if (ids.includes(layer.id)) total += layer.tokens;
  }
  return total;
}

function itemTokens(items: readonly ContextItem[], kinds: readonly ContextItemKind[]): number {
  let total = 0;
  for (const item of items) {
    if (kinds.includes(item.kind)) total += item.tokens;
  }
  return total;
}

/**
 * User-facing composition groups (usage spec 5.2). Layers and event kinds are
 * merged into groups that read as sources, not implementation detail. A group
 * with no tokens is omitted, except that the transient input group only
 * appears once something is typed.
 */
export function usageGroups(inspection: ContextInspection, inputTokens = 0): UsageGroupView[] {
  const values: Array<{ id: UsageGroupId; tokens: number }> = [
    { id: 'resident', tokens: layerTokens(inspection, RESIDENT_LAYERS) },
    { id: 'workspace', tokens: layerTokens(inspection, ['wy-workspace']) },
    { id: 'conversation', tokens: itemTokens(inspection.items, CONVERSATION_KINDS) },
    { id: 'material', tokens: itemTokens(inspection.items, MATERIAL_KINDS) },
    { id: 'task', tokens: itemTokens(inspection.items, TASK_KINDS) },
    { id: 'runtime', tokens: layerTokens(inspection, ['wy-info']) },
    { id: 'input', tokens: Math.max(0, inputTokens) },
  ];
  return values
    .filter((entry) => entry.tokens > 0)
    .map((entry) => ({ id: entry.id, label: GROUP_LABEL[entry.id], tokens: entry.tokens, color: GROUP_COLOR[entry.id] }));
}

/** One recorded TPS sample: generated tokens over the measured window. */
export interface TpsSample {
  outputTokens: number;
  windowMs: number;
}

/** The shared usability rule: enough tokens and window, and a plausible rate. */
const validTps = isUsableTpsSample;

/** A successful call's recorded TPS sample; undefined for historical records. */
function callSample(call: CallModel): TpsSample | undefined {
  if (call.status !== 'ok') return undefined;
  return validTps(call.tps) ? call.tps : undefined;
}

/** Every valid main-reasoning sample of the session, oldest first. */
export function mainSamples(calls: readonly CallModel[]): TpsSample[] {
  const samples: TpsSample[] = [];
  for (const call of calls) {
    if (call.role !== 'reason') continue;
    const sample = callSample(call);
    if (sample !== undefined) samples.push(sample);
  }
  return samples;
}

/**
 * Session generation speed (session metrics spec): the token-weighted speed of
 * the latest five valid main-reasoning samples. Only recorded samples count, so
 * historical calls without `tps` are ignored and no rate is inferred from
 * official output usage and local timestamps. Undefined when no sample is
 * usable, so the UI shows an em dash instead of a fabricated rate.
 */
export function mainSpeed(calls: readonly CallModel[]): number | undefined {
  return rollingTps(mainSamples(calls), 5);
}

/** A dispatched task's usable usage, or undefined when it carries none. */
function taskUsageData(usage: TaskRunUsage | undefined): { input: number; output: number; cached: number; total: number } | undefined {
  if (usage === undefined || usage.completeness === 'unavailable') return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return {
    input,
    output,
    cached: usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0,
    total: usage.totalTokens ?? input + output,
  };
}

/**
 * A tokenizer speed sample. The sampled token weight is reconstructed from
 * the measured rate and window (`outputTps × generationMs / 1000`) and never
 * from the official `outputTokens`; incomplete rows yield
 * none. Requires a finite positive `outputTps` and a finite window of at least
 * 100 ms.
 */
function taskSample(usage: TaskRunUsage | undefined): TpsSample | undefined {
  if (usage === undefined) return undefined;
  const { outputTps, generationMs } = usage;
  if (outputTps === undefined || generationMs === undefined) return undefined;
  if (!Number.isFinite(outputTps) || outputTps <= 0) return undefined;
  if (!Number.isFinite(generationMs) || generationMs < 100) return undefined;
  const sample: TpsSample = { outputTokens: (outputTps * generationMs) / 1000, windowMs: generationMs };
  return validTps(sample) ? sample : undefined;
}

type Pricing = readonly [number, number, number];

interface ModelPricing {
  pricing: Pricing;
  free: boolean;
}

/**
 * Catalog price for a provider-scoped ledger route key (`provider/model`).
 * Providers expose `[cached, input, output]` USD per million tokens. The model
 * is matched by its exact registered id only: there is no canonical fallback,
 * so a historical spelling never borrows another identity's price. A model
 * without a catalog row has unknown price.
 */
function pricingFor(publicId: string, quota: QuotaSnapshot | null | undefined): ModelPricing | undefined {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return undefined;
  const providerId = publicId.slice(0, separator);
  const modelId = publicId.slice(separator + 1);
  const entry = quota?.catalog?.find((catalog) => catalog.id === providerId);
  const model = entry?.models?.find((candidate) => candidate.id === modelId);
  if (!model) return undefined;
  const pricing = model.pricing;
  if (!pricing || pricing.length !== 3 || !pricing.every((value) => Number.isFinite(value))) return undefined;
  return { pricing, free: model.free === true };
}

function costOf(pricing: ModelPricing, input: number, cachedInput: number, output: number): number {
  // Reasoning tokens are already inside `output`; adding them again would
  // double-charge. A free model is exactly zero, never undefined.
  if (pricing.free) return 0;
  const freshInput = Math.max(0, input - cachedInput);
  const [cachedPrice, inputPrice, outputPrice] = pricing.pricing;
  return (freshInput * inputPrice + cachedInput * cachedPrice + output * outputPrice) / 1_000_000;
}

/**
 * Cost of one call in USD from `usage` and the catalog price, or undefined when
 * the price is unknown (never substituted with zero). Free models cost 0.
 */
export function callCost(call: CallModel, quota: QuotaSnapshot | null | undefined): number | undefined {
  if (call.usage === undefined) return undefined;
  const pricing = pricingFor(call.model, quota);
  if (pricing === undefined) return undefined;
  return costOf(pricing, call.usage.input ?? 0, call.usage.cachedInput ?? 0, call.usage.output ?? 0);
}

/** Consumption rows in display order: main reasoning, the auxiliary roles, then tasks. */
const CONSUMPTION_ROLE_ORDER: readonly CallModel['role'][] = [
  'reason',
  'reply',
  'dispatch',
  'document',
  'vcs',
  'project',
  'schedule',
  'search',
  'memory-search',
  'title',
];

/**
 * One source's token consumption and generation speed. `total` is
 * `input + output` (output already includes reasoning) and `cacheRatio` is
 * undefined whenever the row reported no input, never fabricated.
 */
export interface ConsumptionRow {
  /** Row identity: a call role, `task`, or `sum`. */
  key: string;
  label: string;
  /** Calls of the role, or dispatched tasks for the `task` row. */
  calls: number;
  /** Token-weighted speed of the row's valid samples; undefined when it has none. */
  speed: number | undefined;
  total: number;
  input: number;
  output: number;
  /** Cached share of the input. */
  cached: number;
  /** `cached / input`; undefined when the row reported no input. */
  cacheRatio: number | undefined;
  /** `task` row only: true when a terminal dispatched task had no usage. */
  partial?: boolean;
}

export interface ConsumptionView {
  /** Role rows in display order, followed by the `task` row when tasks ran. */
  rows: ConsumptionRow[];
  /** Aggregate over every returned row, including session-wide speed and cache. */
  sum: ConsumptionRow;
}

/** One role's row, or undefined when the role has no calls at all. */
function roleConsumptionRow(role: CallModel['role'], calls: readonly CallModel[]): ConsumptionRow | undefined {
  const roleCalls = calls.filter((call) => call.role === role);
  // Every role that actually occurs keeps a row (and its call count) even when
  // its calls reported neither usage nor a TPS sample.
  if (roleCalls.length === 0) return undefined;
  const samples: TpsSample[] = [];
  for (const call of roleCalls) {
    const sample = callSample(call);
    if (sample !== undefined) samples.push(sample);
  }
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const call of roleCalls) {
    input += call.usage?.input ?? 0;
    output += call.usage?.output ?? 0;
    cached += call.usage?.cachedInput ?? 0;
  }
  const total = input + output;
  return {
    key: role,
    label: CALL_ROLE_LABEL[role],
    calls: roleCalls.length,
    speed: weightedTps(samples),
    total,
    input,
    output,
    cached,
    cacheRatio: input === 0 ? undefined : cached / input,
  };
}

/**
 * A dispatched task's row for the metrics panel. `sample`/`speed` are present
 * only for tokenizer speed samples; `missing` marks a terminal task whose usage
 * could not be read, while a running task simply has no usage yet.
 */
export interface SessionTaskRow {
  taskRunId: string;
  title: string;
  model: string | undefined;
  status: string;
  running: boolean;
  input: number;
  output: number;
  cached: number;
  total: number;
  /** Recorded tokenizer speed sample; absent while running or unavailable. */
  sample: TpsSample | undefined;
  /** Speed of {@link sample}; undefined when absent. */
  speed: number | undefined;
  /** True when a terminal task's usage could not be read. */
  missing: boolean;
  /** Reference cost the daemon recorded for a terminal task; absent when unknown. */
  costUsd: number | undefined;
}

/** Facts the session hook knows about one dispatched task. */
export interface SessionTaskInput {
  taskRunId: string;
  title: string;
  model?: string;
  status: string;
  usage?: TaskRunUsage;
}

/** Terminal task-run statuses whose recorded usage is authoritative. */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

/** The daemon's marker for a task-run read that failed: missing, never running. */
const UNAVAILABLE_TASK_STATUS = 'unavailable';

/**
 * Projects dispatched-task facts into metric rows, keeping the input order.
 * Only terminal tasks (`done`/`failed`/`cancelled`/`interrupted`) may contribute
 * usage, cache, totals and speed: a non-terminal task counts only as running
 * even when it already carries partial usage, and `unavailable` counts as a
 * missing terminal read rather than a running task.
 */
export function sessionTaskRows(tasks: readonly SessionTaskInput[]): SessionTaskRow[] {
  return tasks.map((task) => {
    const terminal = TERMINAL_TASK_STATUSES.has(task.status);
    const running = !terminal && task.status !== UNAVAILABLE_TASK_STATUS;
    const usage = terminal ? taskUsageData(task.usage) : undefined;
    const sample = terminal ? taskSample(task.usage) : undefined;
    return {
      taskRunId: task.taskRunId,
      title: task.title,
      model: task.model,
      status: task.status,
      running,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cached: usage?.cached ?? 0,
      total: usage?.total ?? 0,
      sample,
      speed: sample === undefined ? undefined : tpsOf(sample),
      missing: !running && usage === undefined,
      costUsd: terminal && Number.isFinite(task.usage?.referenceCostUsd) ? task.usage?.referenceCostUsd : undefined,
    };
  });
}

/**
 * The `task` row for tasks this session dispatched. A row is absent when
 * nothing was dispatched. Running tasks count toward `calls` but contribute no
 * usage until they are terminal; `partial` marks a terminal task with no usage.
 */
function taskConsumptionRow(tasks: readonly SessionTaskRow[]): ConsumptionRow | undefined {
  if (tasks.length === 0) return undefined;
  let input = 0;
  let output = 0;
  let cached = 0;
  let total = 0;
  let partial = false;
  const samples: TpsSample[] = [];
  for (const task of tasks) {
    if (task.missing) partial = true;
    if (task.running) continue;
    input += task.input;
    output += task.output;
    cached += task.cached;
    total += task.total;
    if (task.sample !== undefined) samples.push(task.sample);
  }
  return {
    key: 'task',
    label: '任务',
    calls: tasks.length,
    speed: weightedTps(samples),
    total,
    input,
    output,
    cached,
    cacheRatio: input === 0 ? undefined : cached / input,
    ...(partial ? { partial: true } : {}),
  };
}

/** Aggregate of every returned row, for the panel's headline total. */
function sumConsumptionRow(rows: readonly ConsumptionRow[], samples: readonly TpsSample[]): ConsumptionRow {
  let calls = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let total = 0;
  for (const row of rows) {
    calls += row.calls;
    input += row.input;
    output += row.output;
    cached += row.cached;
    total += row.total;
  }
  return {
    key: 'sum',
    label: '合计',
    calls,
    speed: weightedTps(samples),
    total,
    input,
    output,
    cached,
    cacheRatio: input === 0 ? undefined : cached / input,
  };
}

/**
 * Consumption of one session: one row per conversation that reported usage, in
 * fixed role order, plus a `任务` row for the tasks this session dispatched.
 * Speed is token-weighted from valid recorded samples; the `sum` row's speed
 * covers every call and terminal task sample. Cache ratio and totals cover the
 * whole session (calls plus dispatched tasks).
 */
export function consumptionRows(
  calls: readonly CallModel[],
  tasks: readonly SessionTaskRow[],
): ConsumptionView {
  const rows: ConsumptionRow[] = [];
  for (const role of CONSUMPTION_ROLE_ORDER) {
    const row = roleConsumptionRow(role, calls);
    if (row !== undefined) rows.push(row);
  }
  const taskRow = taskConsumptionRow(tasks);
  if (taskRow !== undefined) rows.push(taskRow);

  const samples: TpsSample[] = [];
  for (const call of calls) {
    const sample = callSample(call);
    if (sample !== undefined) samples.push(sample);
  }
  for (const task of tasks) {
    if (!task.running && task.sample !== undefined) samples.push(task.sample);
  }
  return { rows, sum: sumConsumptionRow(rows, samples) };
}

/** The three sources the status-bar tips cluster a session into. */
export type MetricClusterKey = 'task' | 'reason' | 'aux';

/** One cluster's accumulated tokens, time and speed for the status-bar tips. */
export interface MetricCluster {
  key: MetricClusterKey;
  label: string;
  /** Calls of the cluster, or dispatched tasks for `task`. */
  count: number;
  input: number;
  output: number;
  cached: number;
  /** `cached / input`; undefined when the cluster reported no input. */
  cacheRatio: number | undefined;
  /** Accumulated elapsed time of finished calls, or of finished dispatch actions for `task`. */
  durationMs: number;
  /** Token-weighted speed of the cluster's valid samples; undefined when it has none. */
  speed: number | undefined;
  /** Estimated reference cost of the cluster. */
  cost: SessionCostEstimate;
  /** Distinct models the cluster's calls ran on, most recent first; empty for `task`. */
  models: string[];
}

/** The timing facts of one dispatch action; a structural subset of the action model. */
export interface DispatchTiming {
  taskRunId?: string;
  startedAt: string;
  endedAt?: string;
}

function elapsedMs(startedAt: string, endedAt: string | undefined): number {
  if (endedAt === undefined) return 0;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Elapsed time of each finished dispatch, keyed by task run and counted once per run. */
function dispatchDurations(dispatches: readonly DispatchTiming[]): Map<string, number> {
  const durations = new Map<string, number>();
  for (const dispatch of dispatches) {
    if (dispatch.taskRunId === undefined) continue;
    const ms = elapsedMs(dispatch.startedAt, dispatch.endedAt);
    durations.set(dispatch.taskRunId, Math.max(durations.get(dispatch.taskRunId) ?? 0, ms));
  }
  return durations;
}

function callCluster(
  key: 'reason' | 'aux',
  label: string,
  calls: readonly CallModel[],
  quota: QuotaSnapshot | undefined,
): MetricCluster {
  let input = 0;
  let output = 0;
  let cached = 0;
  let durationMs = 0;
  const samples: TpsSample[] = [];
  for (const call of calls) {
    input += call.usage?.input ?? 0;
    output += call.usage?.output ?? 0;
    cached += call.usage?.cachedInput ?? 0;
    durationMs += elapsedMs(call.startedAt, call.endedAt);
    const sample = callSample(call);
    if (sample !== undefined) samples.push(sample);
  }
  return {
    key, label, count: calls.length, input, output, cached,
    cacheRatio: input === 0 ? undefined : cached / input,
    durationMs,
    speed: weightedTps(samples),
    cost: sessionCostEstimate(calls, [], quota),
    models: [...new Set([...calls].reverse().map((call) => call.model))],
  };
}

/**
 * A session clustered into dispatched tasks, main reasoning and auxiliary calls
 * (session metrics spec). A cluster with nothing in it is omitted. Task time is
 * the elapsed time of finished dispatch actions, counted once per task run; the
 * clusters overlap in wall-clock time, so their durations are accumulated work
 * time rather than a partition of the session's elapsed time.
 */
export function metricClusters(
  calls: readonly CallModel[],
  tasks: readonly SessionTaskRow[],
  dispatches: readonly DispatchTiming[],
  quota: QuotaSnapshot | undefined,
): MetricCluster[] {
  const clusters: MetricCluster[] = [];
  if (tasks.length > 0) {
    let input = 0;
    let output = 0;
    let cached = 0;
    const samples: TpsSample[] = [];
    for (const task of tasks) {
      if (task.running) continue;
      input += task.input;
      output += task.output;
      cached += task.cached;
      if (task.sample !== undefined) samples.push(task.sample);
    }
    let durationMs = 0;
    for (const ms of dispatchDurations(dispatches).values()) durationMs += ms;
    clusters.push({
      key: 'task', label: '任务', count: tasks.length, input, output, cached,
      cacheRatio: input === 0 ? undefined : cached / input,
      durationMs,
      speed: weightedTps(samples),
      cost: sessionCostEstimate([], tasks, quota),
      models: [],
    });
  }
  const reason = calls.filter((call) => call.role === 'reason');
  if (reason.length > 0) clusters.push(callCluster('reason', '推理', reason, quota));
  const aux = calls.filter((call) => call.role !== 'reason');
  if (aux.length > 0) clusters.push(callCluster('aux', '辅助', aux, quota));
  return clusters;
}

/** The session's estimated reference cost; `partial` when some part has no known price. */
export interface SessionCostEstimate {
  /** USD over everything with a known price; undefined when nothing is priced. */
  value: number | undefined;
  partial: boolean;
}

/**
 * Estimated reference cost of the whole session: internal calls priced from the
 * catalog plus the reference cost recorded for each finished dispatched task.
 * Unpriced calls and tasks are left out and flagged through `partial`, never
 * counted as zero.
 */
export function sessionCostEstimate(
  calls: readonly CallModel[],
  tasks: readonly SessionTaskRow[],
  quota: QuotaSnapshot | undefined,
): SessionCostEstimate {
  let value = 0;
  let priced = 0;
  let partial = false;
  for (const call of calls) {
    if (call.usage === undefined) continue;
    const cost = callCost(call, quota);
    if (cost === undefined) partial = true;
    else { value += cost; priced += 1; }
  }
  for (const task of tasks) {
    if (task.running) continue;
    if (task.costUsd === undefined) partial = true;
    else { value += task.costUsd; priced += 1; }
  }
  return { value: priced === 0 ? undefined : value, partial };
}

/** Finished dispatched tasks of one model, for the expanded task rows of the tips. */
export interface TaskModelGroup {
  /** The model's display name from the resolved runtime, or an empty string when none was resolved. */
  model: string;
  count: number;
  input: number;
  output: number;
  cached: number;
  cost: SessionCostEstimate;
  /** Accumulated elapsed time of the group's dispatch actions. */
  durationMs: number;
  /** Token-weighted speed of the group's valid samples; undefined when it has none. */
  speed: number | undefined;
}

/** Finished dispatched tasks grouped by model, largest total first. */
export function taskModelGroups(
  tasks: readonly SessionTaskRow[],
  dispatches: readonly DispatchTiming[],
): TaskModelGroup[] {
  const durations = dispatchDurations(dispatches);
  const groups = new Map<string, SessionTaskRow[]>();
  for (const task of tasks) {
    if (task.running) continue;
    // The runtime label is `<client> · <model display name>`; tasks group by the model alone.
    const model = (task.model ?? '').split(' · ').at(-1) ?? '';
    const list = groups.get(model);
    if (list) list.push(task);
    else groups.set(model, [task]);
  }
  return [...groups.entries()]
    .map(([model, rows]) => ({
      model,
      count: rows.length,
      input: rows.reduce((sum, row) => sum + row.input, 0),
      output: rows.reduce((sum, row) => sum + row.output, 0),
      cached: rows.reduce((sum, row) => sum + row.cached, 0),
      cost: sessionCostEstimate([], rows, undefined),
      durationMs: rows.reduce((sum, row) => sum + (durations.get(row.taskRunId) ?? 0), 0),
      speed: weightedTps(rows.flatMap((row) => (row.sample === undefined ? [] : [row.sample]))),
    }))
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

/**
 * Calls grouped by model, largest total first. Each call is priced on its own
 * `provider/model` route first; `nameOf` then maps that public id to the model
 * name the group is keyed and labelled by, so the same model served by two
 * providers lands in one group with both routes' costs added up.
 */
export function callModelGroups(
  calls: readonly CallModel[],
  quota: QuotaSnapshot | undefined,
  nameOf: (publicId: string) => string,
): TaskModelGroup[] {
  const groups = new Map<string, CallModel[]>();
  for (const call of calls) {
    const name = nameOf(call.model);
    const list = groups.get(name);
    if (list) list.push(call);
    else groups.set(name, [call]);
  }
  return [...groups.entries()]
    .map(([model, rows]) => {
      const cluster = callCluster('aux', '', rows, quota);
      return {
        model,
        count: rows.length,
        input: cluster.input,
        output: cluster.output,
        cached: cluster.cached,
        cost: cluster.cost,
        durationMs: cluster.durationMs,
        speed: cluster.speed,
      };
    })
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

/** Internal LLM roles, in the fixed order the ctx popover lists them. */
const ROLE_CONTEXT_ORDER: readonly CallModel['role'][] = [
  'reason',
  'reply',
  'dispatch',
  'document',
  'vcs',
  'project',
  'schedule',
  'search',
  'memory-search',
  'title',
];

/**
 * One internal LLM conversation's managed context: the latest reported
 * single-request actual input tokens and the context window of the model that
 * produced that sample. The forward-looking estimate of the next request is
 * never mixed in here.
 */
export interface RoleContextEntry {
  role: CallModel['role'];
  label: string;
  /** Public id of the sampled, running or preview model; undefined when unknown. */
  model: string | undefined;
  /** Resolved model display name; undefined when the caller knows none. */
  modelLabel: string | undefined;
  /** Latest reported single-request actual input tokens; undefined when unknown. */
  tokens: number | undefined;
  /** Context window of the model that produced `tokens`; undefined when unknown. */
  window: number | undefined;
  /** `tokens / window`; undefined when either is unknown. */
  ratio: number | undefined;
  /** True while a request is in flight and `tokens` is the previous reported snapshot. */
  latestReported?: boolean;
  /**
   * Preview selection failure; surfaced only for a role with no actual sample,
   * so an unavailable future route cannot hide historical usage.
   */
  error?: string;
}

/** Model facts the caller resolves for a public id; fields are omitted when unknown. */
export interface RoleModelInfo {
  label?: string;
  contextWindow?: number;
}

export interface RoleContextOptions {
  /** Public id of the main model currently selected; samples of another model are masked. */
  reasonModel?: string;
  /** Resolve a model public id to its display name and context window. */
  resolve(modelId: string): RoleModelInfo | undefined;
  /**
   * Per-role auxiliary route preview from the daemon. Every listed role appears
   * even before its first call, and a role with `error` appears with no model.
   */
  preview?: readonly SessionRoutesPreviewRole[];
}

/** The latest reported single-request snapshot across a role's calls, by ledger seq. */
function latestRoleSnapshot(calls: readonly CallModel[]): CallContextSnapshot | undefined {
  let latest: CallContextSnapshot | undefined;
  for (const call of calls) {
    for (const snapshot of call.snapshots ?? []) {
      if (latest === undefined || snapshot.seq > latest.seq) latest = snapshot;
    }
  }
  return latest;
}

/**
 * Per-role context projection for the ctx popover: one entry per internal LLM
 * conversation, in fixed role order. Every row shows the latest reported
 * single-request actual input tokens and the window of the model that produced
 * that sample; the numerator and denominator therefore always come from the
 * same model. A role that has not run yet borrows the route preview's model (and
 * its own window) for identity only, with no tokens. Model name and window come
 * from the caller's resolver, so this module never imports React or hooks.
 */
export function roleContexts(calls: readonly CallModel[], options: RoleContextOptions): RoleContextEntry[] {
  const previewByRole = new Map<CallModel['role'], SessionRoutesPreviewRole>();
  for (const entry of options.preview ?? []) previewByRole.set(entry.role, entry);
  // An empty selection is no selection: it names no model and masks no sample.
  const reasonModel = options.reasonModel === '' ? undefined : options.reasonModel;
  const entries: RoleContextEntry[] = [];
  for (const role of ROLE_CONTEXT_ORDER) {
    const isReason = role === 'reason';
    const preview = previewByRole.get(role);
    const roleCalls = calls.filter((call) => call.role === role);
    const hasRun = roleCalls.length > 0;
    let sample = latestRoleSnapshot(roleCalls);
    // The main model can switch, so a snapshot of a previously selected model is
    // not the current main identity and must not be shown as its occupancy.
    if (isReason && sample !== undefined && reasonModel !== undefined && sample.model !== reasonModel) {
      sample = undefined;
    }
    // A role appears once it ran, once the main model is known, or on the
    // preview that lists it — but an errored preview role always appears.
    const present = isReason ? sample !== undefined || reasonModel !== undefined : hasRun || preview !== undefined;
    if (!present) continue;

    const identity = sample?.model
      ?? (isReason ? reasonModel : hasRun ? roleCalls[roleCalls.length - 1]!.model : preview?.model);
    if (identity === undefined && preview?.error === undefined) continue;
    const resolved = identity === undefined ? undefined : options.resolve(identity);
    const tokens = sample?.inputTokens;
    const window = sample !== undefined
      ? resolved?.contextWindow
      : preview !== undefined && !hasRun
        ? preview.contextWindow ?? resolved?.contextWindow
        : resolved?.contextWindow;
    const modelLabel = sample !== undefined
      ? resolved?.label
      : preview !== undefined && !hasRun
        ? preview.modelName ?? resolved?.label
        : resolved?.label;
    const ratio = window !== undefined && tokens !== undefined && Number.isFinite(window) && window > 0
      ? tokens / window
      : undefined;
    const running = roleCalls.some((call) => call.status === 'running');
    entries.push({
      role,
      label: CALL_ROLE_LABEL[role],
      model: identity,
      modelLabel,
      tokens,
      window,
      ratio,
      ...(running && sample !== undefined ? { latestReported: true } : {}),
      // A valid actual sample wins: only a role with no sample reports the
      // preview failure, so an unavailable future route never hides historical
      // usage as an error.
      ...(preview?.error === undefined || sample !== undefined ? {} : { error: preview.error }),
    });
  }
  return entries;
}

let inputEncoder: Tiktoken | undefined;

/** Shared raw input estimator; calibration is only a display hint. */
export function countInputTokens(text: string): number {
  if (text === '') return 0;
  inputEncoder ??= getEncoding('o200k_base');
  return inputEncoder.encode(text).length;
}
