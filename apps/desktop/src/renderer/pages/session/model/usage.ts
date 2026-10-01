import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type {
  ContextInspection,
  ContextItem,
  ContextItemKind,
  ContextLayerId,
  QuotaSnapshot,
} from '@/shell-contract';
import type { CallModel } from './types.js';

/**
 * Pure usage-meter projections for the session page. No React, DOM, bridge or
 * window access lives here: the ring, the usage panel and the inspector context
 * tab render exactly what these functions derive from a `ContextInspection`,
 * the loaded call models and a quota snapshot.
 *
 * The main reasoning view is forward-looking (context ledger spec): the meter
 * answers "how large will the *next* reasoning view be", not "how large was
 * the last request". Layer totals are authoritative for the total; individual
 * items only drive ordering and the composition breakdown (usage spec 3.1).
 */

/** A turn may issue at most this many expensive (reason) requests (ledger spec). */
export const MAX_REASON_CALLS_PER_TURN = 10;

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
const CONVERSATION_KINDS: readonly ContextItemKind[] = ['user', 'assistant', 'reply', 'interrupt'];
const MATERIAL_KINDS: readonly ContextItemKind[] = ['doc', 'memory'];
const TASK_KINDS: readonly ContextItemKind[] = ['action-result', 'ws-update'];

/** Display label of every context item kind. */
export const ITEM_KIND_LABEL: Record<ContextItemKind, string> = {
  user: '用户消息',
  assistant: '助手消息',
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

/** Exact grouped integer for hover tooltips. */
export function formatExactTokens(tokens: number): string {
  return Math.round(tokens).toLocaleString();
}

let inputEncoder: Tiktoken | undefined;

/** Shared raw input estimator; calibration is only a display hint. */
export function countInputTokens(text: string): number {
  if (text === '') return 0;
  inputEncoder ??= getEncoding('cl100k_base');
  return inputEncoder.encode(text).length;
}
