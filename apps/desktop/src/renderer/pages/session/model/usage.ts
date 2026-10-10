import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type {
  ContextInspection,
  ContextItem,
  ContextItemKind,
  ContextLayerId,
  QuotaSnapshot,
  TaskRunUsage,
} from '@/shell-contract';
import type { SessionRoutesPreviewRole } from '@wrenyard/protocol';
import type { CallModel } from './types.js';
import { CALL_ROLE_LABEL } from './describe.js';

/**
 * Pure usage projections for the session page. No React, DOM, bridge or window
 * access lives here: the status-bar items and the inspector context tab render
 * exactly what these functions derive from a `ContextInspection`, the loaded
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
const MATERIAL_KINDS: readonly ContextItemKind[] = ['doc', 'memory', 'doc-search', 'files'];
const TASK_KINDS: readonly ContextItemKind[] = ['action-result', 'ws-update'];

/** Display label of every context item kind. */
export const ITEM_KIND_LABEL: Record<ContextItemKind, string> = {
  user: '用户消息',
  assistant: '助手消息',
  thinking: '主推理思考',
  'doc-search': '文档检索',
  files: '文件',
  error: '错误',
  reply: '回复',
  doc: '文档',
  memory: '记忆',
  'action-result': '行动结果',
  'ws-update': '工作区更新',
  interrupt: '中断',
};

const KIND_GROUP: Record<ContextItemKind, UsageGroupId> = {
  user: 'conversation',
  assistant: 'conversation',
  thinking: 'conversation',
  error: 'conversation',
  'doc-search': 'material',
  files: 'material',
  reply: 'conversation',
  interrupt: 'conversation',
  doc: 'material',
  memory: 'material',
  'action-result': 'task',
  'ws-update': 'task',
};

const LAYER_GROUP: Record<ContextLayerId, UsageGroupId> = {
  'wy-system': 'resident',
  'wy-global': 'resident',
  'wy-role': 'resident',
  'wy-workspace': 'workspace',
  'wy-ctx': 'conversation',
  'wy-info': 'runtime',
};

const LAYER_LABEL: Record<ContextLayerId, string> = {
  'wy-system': '系统提示',
  'wy-global': '全局记忆',
  'wy-role': '角色',
  'wy-workspace': '工作区快照',
  'wy-ctx': '对话上下文',
  'wy-info': '运行信息',
};

/** Composition group of a context item kind. */
export function groupOfItemKind(kind: ContextItemKind): UsageGroupId {
  return KIND_GROUP[kind];
}

/** Composition group of a context layer. */
export function groupOfLayer(id: ContextLayerId): UsageGroupId {
  return LAYER_GROUP[id];
}

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

/** Groups whose members are context items rather than layers. */
const ITEM_BACKED_GROUPS: ReadonlySet<UsageGroupId> = new Set(['conversation', 'material', 'task']);

export interface ContextTreeRow {
  /** Stable identity; also the expansion-set member of group and type rows. */
  key: string;
  depth: 0 | 1 | 2;
  kind: 'group' | 'type' | 'item';
  label: string;
  tokens: number;
  /** `tokens / inspection.totalTokens`, or 0 when the total is unknown. */
  share: number;
  item?: ContextItem;
}

export interface ContextTreeOptions {
  expandedGroups: ReadonlySet<UsageGroupId>;
  expandedKinds: ReadonlySet<string>;
  sort: 'tokens' | 'seq';
  /** Restrict to one turn; absent means every turn. */
  turn?: number;
  /** Restrict to these item kinds; empty or absent means every kind. */
  kinds?: ReadonlySet<ContextItemKind>;
}

/**
 * Group → type → item rows of the composition tree. Filtering, ordering and
 * expansion live here so the inspector tree renders exactly what this module
 * derives and can never drift from the composition panel.
 */
export function contextTreeRows(inspection: ContextInspection, options: ContextTreeOptions): ContextTreeRow[] {
  const { expandedGroups, expandedKinds, sort, turn, kinds } = options;
  const total = inspection.totalTokens;
  const shareOf = (tokens: number): number => (total > 0 ? tokens / total : 0);
  const compare = sort === 'seq'
    ? (left: ContextItem, right: ContextItem): number => left.seq - right.seq
    : (left: ContextItem, right: ContextItem): number => right.tokens - left.tokens || left.seq - right.seq;

  const visible = inspection.items.filter((item) => (turn === undefined || item.turn === turn)
    && (kinds === undefined || kinds.size === 0 || kinds.has(item.kind)));
  const byKind = new Map<ContextItemKind, ContextItem[]>();
  for (const item of visible) {
    const list = byKind.get(item.kind);
    if (list) list.push(item);
    else byKind.set(item.kind, [item]);
  }

  const rows: ContextTreeRow[] = [];
  for (const group of USAGE_GROUP_ORDER) {
    if (ITEM_BACKED_GROUPS.has(group)) {
      const groupKinds = [...byKind.keys()].filter((kind) => groupOfItemKind(kind) === group);
      if (groupKinds.length === 0) continue;
      let groupTokens = 0;
      for (const kind of groupKinds) for (const item of byKind.get(kind) ?? []) groupTokens += item.tokens;
      rows.push({ key: group, depth: 0, kind: 'group', label: GROUP_LABEL[group], tokens: groupTokens, share: shareOf(groupTokens) });
      if (!expandedGroups.has(group)) continue;
      for (const kind of groupKinds) {
        const children = [...(byKind.get(kind) ?? [])].sort(compare);
        let kindTokens = 0;
        for (const item of children) kindTokens += item.tokens;
        rows.push({ key: kind, depth: 1, kind: 'type', label: ITEM_KIND_LABEL[kind], tokens: kindTokens, share: shareOf(kindTokens) });
        if (!expandedKinds.has(kind)) continue;
        for (const item of children) {
          rows.push({
            key: `i:${item.seq}`,
            depth: 2,
            kind: 'item',
            label: item.label,
            tokens: item.tokens,
            share: shareOf(item.tokens),
            item,
          });
        }
      }
      continue;
    }
    const groupLayers = inspection.layers.filter((layer) => groupOfLayer(layer.id) === group && layer.id !== 'wy-ctx');
    if (groupLayers.length === 0) continue;
    let layerTokens = 0;
    for (const layer of groupLayers) layerTokens += layer.tokens;
    rows.push({ key: group, depth: 0, kind: 'group', label: GROUP_LABEL[group], tokens: layerTokens, share: shareOf(layerTokens) });
    if (!expandedGroups.has(group)) continue;
    for (const layer of groupLayers) {
      rows.push({ key: layer.id, depth: 1, kind: 'type', label: LAYER_LABEL[layer.id], tokens: layer.tokens, share: shareOf(layer.tokens) });
    }
  }
  return rows;
}

/**
 * Cache-hit ratio of the most recent main-reasoning call that reported usage:
 * `cachedInput / input`. Returns undefined when no such call exists so the UI
 * never fabricates a hit rate.
 */
export function recentCacheRatio(calls: readonly CallModel[]): number | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    if (call.role !== 'reason' || call.usage === undefined) continue;
    const input = call.usage.input;
    if (typeof input !== 'number' || input <= 0) continue;
    const cached = call.usage.cachedInput ?? 0;
    return Math.max(0, Math.min(1, cached / input));
  }
  return undefined;
}

/**
 * Output throughput of the most recent finished main-reasoning call that
 * reported both a first-token and an end timestamp: `(output + reasoning)` over
 * the elapsed seconds between them. Returns undefined when no such call exists
 * or the interval is not positive, so the UI never fabricates a rate.
 */
export function recentTps(calls: readonly CallModel[]): number | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    if (call.role !== 'reason') continue;
    if (call.status === 'running') continue;
    if (call.firstTokenAt === undefined || call.endedAt === undefined) continue;
    if (call.usage === undefined) continue;
    const start = Date.parse(call.firstTokenAt);
    const end = Date.parse(call.endedAt);
    const seconds = (end - start) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    return ((call.usage.output ?? 0) + (call.usage.reasoning ?? 0)) / seconds;
  }
  return undefined;
}

type Pricing = readonly [number, number, number];

interface ModelPricing {
  pricing: Pricing;
  free: boolean;
}

/**
 * Catalog price for a gateway public id (`provider/model`, ledger spec).
 * Providers expose `[cached, input, output]` USD per million tokens. A model
 * without a catalog row has unknown price.
 */
function pricingFor(publicId: string, quota: QuotaSnapshot | null | undefined): ModelPricing | undefined {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return undefined;
  const providerId = publicId.slice(0, separator);
  const modelId = publicId.slice(separator + 1);
  const entry = quota?.catalog?.find((catalog) => catalog.id === providerId);
  const model = entry?.models?.find((candidate) => candidate.id === modelId || candidate.canonicalId === modelId);
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

/** Roles in the fixed order date surfaces list them. */
const CALL_ROLE_ORDER: readonly CallModel['role'][] = [
  'reason',
  'memory-search',
  'doc-search',
  'compile',
  'reply',
  'title',
];

/**
 * Total USD fee of one role's calls. Undefined when the quota is missing or any
 * call's price is unknown — never a partial zero (ledger spec), matching the
 * inspector's inline summary exactly.
 */
function roleFee(calls: readonly CallModel[], quota: QuotaSnapshot | undefined): number | undefined {
  if (quota === undefined) return undefined;
  let fee = 0;
  for (const call of calls) {
    const cost = callCost(call, quota);
    if (cost === undefined) return undefined;
    fee += cost;
  }
  return fee;
}

export interface SessionRoleCost {
  role: CallModel['role'];
  label: string;
  /** Undefined when the quota is missing or any call's price is unknown. */
  fee: number | undefined;
  /** Number of calls with this role. */
  calls: number;
}

export interface SessionCostView {
  /** Total USD cost; undefined when any contributing price is unknown. */
  total: number | undefined;
  /** Per-role cost in fixed role order; only roles with calls are listed. */
  byRole: SessionRoleCost[];
}

/**
 * Session cost projection for the inspector's CallSummary: per-role fees and
 * call counts, plus the total fee. An unknown price makes the affected role (and
 * the total) undefined rather than a partial zero.
 */
export function sessionCost(calls: readonly CallModel[], quota: QuotaSnapshot | undefined): SessionCostView {
  const byRole: SessionRoleCost[] = [];
  for (const role of CALL_ROLE_ORDER) {
    const roleCalls = calls.filter((call) => call.role === role);
    if (roleCalls.length === 0) continue;
    byRole.push({ role, label: CALL_ROLE_LABEL[role], fee: roleFee(roleCalls, quota), calls: roleCalls.length });
  }

  const reason = byRole.find((entry) => entry.role === 'reason');
  const reasonFee = reason ? reason.fee : 0;
  const cheap = byRole.filter((entry) => entry.role !== 'reason');
  const cheapFee = cheap.some((entry) => entry.fee === undefined)
    ? undefined
    : cheap.reduce((sum, entry) => sum + (entry.fee ?? 0), 0);
  const total = reasonFee !== undefined && cheapFee !== undefined ? reasonFee + cheapFee : undefined;

  return { total, byRole };
}

/** Consumption rows in display order: main reasoning, the auxiliary roles, then tasks. */
const CONSUMPTION_ROLE_ORDER: readonly CallModel['role'][] = [
  'reason',
  'reply',
  'compile',
  'doc-search',
  'memory-search',
  'title',
];

/**
 * One conversation's or dispatched-task group's token consumption. `total` is
 * `input + output` (output already includes reasoning) and `cacheRatio` is
 * undefined whenever the row reported no input, never fabricated.
 */
export interface ConsumptionRow {
  /** Row identity: a call role, `task`, or `sum`. */
  key: string;
  label: string;
  /** Calls of the role, or tasks for the `task` row. */
  calls: number;
  total: number;
  input: number;
  output: number;
  /** Cached share of the input. */
  cached: number;
  /** `cached / input`; undefined when the row reported no input. */
  cacheRatio: number | undefined;
  /** `task` row only: true when some dispatched task had no usage in the snapshot. */
  partial?: boolean;
}

export interface ConsumptionView {
  /** Role rows in display order, followed by the `task` row when tasks ran. */
  rows: ConsumptionRow[];
  /** Aggregate over every returned row. */
  sum: ConsumptionRow;
}

/** One role's consumption, or undefined when none of its calls reported usage. */
function roleConsumptionRow(role: CallModel['role'], calls: readonly CallModel[]): ConsumptionRow | undefined {
  const roleCalls = calls.filter((call) => call.role === role);
  if (!roleCalls.some((call) => call.usage !== undefined)) return undefined;
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
    total,
    input,
    output,
    cached,
    cacheRatio: input === 0 ? undefined : cached / input,
  };
}

/**
 * The `task` row for tasks this session dispatched. Undefined when nothing was
 * dispatched; `partial` marks a dispatched task missing from the stats snapshot.
 * `totalTokens` is preferred over the derived `input + output` per task.
 */
function taskConsumptionRow(taskUsages: readonly (TaskRunUsage | undefined)[]): ConsumptionRow | undefined {
  if (taskUsages.length === 0) return undefined;
  let input = 0;
  let output = 0;
  let cached = 0;
  let total = 0;
  let partial = false;
  for (const usage of taskUsages) {
    if (usage === undefined) {
      partial = true;
      continue;
    }
    const rowInput = usage.inputTokens ?? 0;
    const rowOutput = usage.outputTokens ?? 0;
    input += rowInput;
    output += rowOutput;
    cached += usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
    total += usage.totalTokens ?? rowInput + rowOutput;
  }
  return {
    key: 'task',
    label: '任务',
    calls: taskUsages.length,
    total,
    input,
    output,
    cached,
    cacheRatio: input === 0 ? undefined : cached / input,
    ...(partial ? { partial: true } : {}),
  };
}

/** Aggregate of every returned row, for the status bar's headline total. */
function sumConsumptionRow(rows: readonly ConsumptionRow[]): ConsumptionRow {
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
    total,
    input,
    output,
    cached,
    cacheRatio: input === 0 ? undefined : cached / input,
  };
}

/**
 * Consumption of one session: one row per conversation that reported usage, in
 * fixed role order, plus a `任务` row for tasks this session dispatched.
 * `taskUsages` carries one entry per dispatched task — its `TaskRunUsage`, or
 * undefined when the stats snapshot had no matching run. The `task` row is
 * absent when nothing was dispatched and carries `partial` when any usage was
 * missing. `sum` aggregates every returned row.
 */
export function consumptionRows(
  calls: readonly CallModel[],
  taskUsages: readonly (TaskRunUsage | undefined)[],
): ConsumptionView {
  const rows: ConsumptionRow[] = [];
  for (const role of CONSUMPTION_ROLE_ORDER) {
    const row = roleConsumptionRow(role, calls);
    if (row !== undefined) rows.push(row);
  }
  const taskRow = taskConsumptionRow(taskUsages);
  if (taskRow !== undefined) rows.push(taskRow);
  return { rows, sum: sumConsumptionRow(rows) };
}

/** Internal LLM roles, in the fixed order the ctx popover lists them. */
const ROLE_CONTEXT_ORDER: readonly CallModel['role'][] = [
  'reason',
  'reply',
  'compile',
  'doc-search',
  'memory-search',
  'title',
];

/** One internal LLM conversation's managed context: the role's latest model, its
 *  prompt tokens and its share of the model window. The reason role carries the
 *  live budget total; auxiliary roles carry their latest finished call's input,
 *  their rank-1 preview model, or no tokens at all before their first call. */
export interface RoleContextEntry {
  role: CallModel['role'];
  label: string;
  /** Latest call's or preview's model public id; undefined when neither known. */
  model: string | undefined;
  /** Resolved model display name; undefined when the caller knows none. */
  modelLabel: string | undefined;
  /** Prompt tokens of the role's current context; undefined before any call. */
  tokens: number | undefined;
  /** Model context window; undefined when the model declares none. */
  window: number | undefined;
  /** `tokens / window`; undefined when either is unknown. */
  ratio: number | undefined;
  /** Preview selection failure; present only when the daemon returned none. */
  error?: string;
}

/** Model facts the caller resolves for a public id; fields are omitted when unknown. */
export interface RoleModelInfo {
  label?: string;
  contextWindow?: number;
}

export interface RoleContextOptions {
  /** Live reason total (inspection total plus draft input); overrides the latest reason call. */
  reasonTokens?: number;
  /** Resolve a model public id to its display name and context window. */
  resolve(modelId: string): RoleModelInfo | undefined;
  /**
   * Per-role auxiliary route preview from the daemon. Every listed role appears
   * even before its first call, and a role with `error` appears with no model.
   */
  preview?: readonly SessionRoutesPreviewRole[];
}

/** Latest finished (non-running) call of a role, or undefined when it has none. */
function latestFinishedRoleCall(calls: readonly CallModel[], role: CallModel['role']): CallModel | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    if (call.role === role && call.status !== 'running') return call;
  }
  return undefined;
}

/** Reported prompt tokens of a call, else its raw input estimate; 0 when absent. */
function callContextTokens(call: CallModel | undefined): number {
  if (call === undefined) return 0;
  return call.usage?.input ?? call.estimatedInputTokens ?? 0;
}

/**
 * Per-role context projection for the ctx popover: one entry per internal LLM
 * conversation, in fixed role order. The reason role always appears when
 * `options.reasonTokens` supplies the live total; every auxiliary role the
 * preview lists appears even before its first call, using the preview's model
 * and window with no tokens. Model name and window come from the preview first,
 * then the caller's resolver, so this module never imports React or hooks.
 */
export function roleContexts(calls: readonly CallModel[], options: RoleContextOptions): RoleContextEntry[] {
  const previewByRole = new Map<CallModel['role'], SessionRoutesPreviewRole>();
  for (const entry of options.preview ?? []) previewByRole.set(entry.role, entry);
  const entries: RoleContextEntry[] = [];
  for (const role of ROLE_CONTEXT_ORDER) {
    const preview = previewByRole.get(role);
    const isReason = role === 'reason';
    const roleCalls = calls.filter((call) => call.role === role);
    const hasReasonTotal = isReason && options.reasonTokens !== undefined;
    if (roleCalls.length === 0 && !hasReasonTotal && preview === undefined) continue;
    const latest = roleCalls.length > 0 ? roleCalls[roleCalls.length - 1]! : undefined;
    const model = isReason ? latest?.model : preview?.model ?? latest?.model;
    const resolved = model === undefined ? undefined : options.resolve(model);
    const tokens = isReason
      ? options.reasonTokens ?? callContextTokens(latest)
      : roleCalls.length > 0 ? callContextTokens(latestFinishedRoleCall(calls, role) ?? latest) : undefined;
    const window = isReason ? resolved?.contextWindow : preview?.contextWindow ?? resolved?.contextWindow;
    const modelLabel = isReason ? resolved?.label : preview?.modelName ?? resolved?.label;
    const ratio = window !== undefined && tokens !== undefined && Number.isFinite(window) && window > 0
      ? tokens / window
      : undefined;
    entries.push({
      role,
      label: CALL_ROLE_LABEL[role],
      model,
      modelLabel,
      tokens,
      window,
      ratio,
      ...(preview?.error === undefined ? {} : { error: preview.error }),
    });
  }
  return entries;
}

export interface TurnGrowth {
  turn: number;
  /** Tokens added by this turn. */
  tokens: number;
  /** Running total through this turn. */
  cumulative: number;
}

/** Per-turn token growth from the inspection items, ordered oldest-first. */
export function growthByTurn(items: readonly ContextItem[]): TurnGrowth[] {
  const perTurn = new Map<number, number>();
  for (const item of items) {
    perTurn.set(item.turn, (perTurn.get(item.turn) ?? 0) + item.tokens);
  }
  const turns = [...perTurn.keys()].sort((left, right) => left - right);
  let cumulative = 0;
  return turns.map((turn) => {
    const tokens = perTurn.get(turn) ?? 0;
    cumulative += tokens;
    return { turn, tokens, cumulative };
  });
}

export interface RemainingTurnsView {
  /** Estimated full turns left at the recent average growth. */
  turns: number;
  /** True while fewer than five ended turns back the estimate. */
  warn: boolean;
}

/**
 * Remaining-turn estimate from the recent average growth (usage spec 5.1).
 * Requires at least three turns of data; fewer than five marks the estimate as
 * low-confidence. Returns null when the estimate would be meaningless.
 */
export function remainingTurns(growth: readonly TurnGrowth[], remainingTokens: number): RemainingTurnsView | null {
  if (remainingTokens <= 0) return null;
  const recent = growth.slice(-5);
  if (recent.length < 3) return null;
  const average = recent.reduce((sum, entry) => sum + entry.tokens, 0) / recent.length;
  if (!Number.isFinite(average) || average <= 0) return null;
  return { turns: Math.floor(remainingTokens / average), warn: recent.length < 5 };
}

export interface ModelPreviewInput {
  publicId: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelPreviewRow {
  publicId: string;
  displayName: string;
  contextWindow: number | undefined;
  /** `contextWindow - maxOutputTokens`; absent when either is unknown. */
  available: number | undefined;
  /** Current context at this model's available window. */
  ratio: number | undefined;
  exceeded: boolean;
  /** Estimated cost of the next reasoning input in USD; undefined when unknown. */
  inputCost: number | undefined;
}

/**
 * Switching-model preview (usage spec 7): how the current context behaves under
 * every selectable model. The token count is model-independent; calibration is
 * deliberately not applied here. Cache-hit ratio from the last reasoning call
 * estimates the cached share of the next input.
 */
export function modelPreviews(
  models: readonly ModelPreviewInput[],
  totalTokens: number,
  cacheRatio: number | undefined,
  quota: QuotaSnapshot | null | undefined,
): ModelPreviewRow[] {
  return models.map((model) => {
    const available = model.contextWindow !== undefined && model.maxOutputTokens !== undefined
      ? Math.max(0, model.contextWindow - model.maxOutputTokens)
      : undefined;
    const pricing = pricingFor(model.publicId, quota);
    const ratio = available !== undefined && available > 0 ? totalTokens / available : undefined;
    const cached = cacheRatio === undefined ? 0 : totalTokens * Math.max(0, Math.min(1, cacheRatio));
    return {
      publicId: model.publicId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      available,
      ratio,
      exceeded: available !== undefined && totalTokens > available,
      inputCost: pricing === undefined ? undefined : costOf(pricing, totalTokens, cached, 0),
    };
  });
}

let inputEncoder: Tiktoken | undefined;

/** Shared raw input estimator; calibration is only a display hint. */
export function countInputTokens(text: string): number {
  if (text === '') return 0;
  inputEncoder ??= getEncoding('cl100k_base');
  return inputEncoder.encode(text).length;
}
