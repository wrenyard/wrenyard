import type { ProviderCatalogSnapshot, ProviderModelSnapshot, QuotaSnapshot } from '../shell-contract.js';
import { brandIcon } from './brand-icons.js';

/** Evidence tiers ordered strongest-first; a measured tier always outranks a catalog default. */
const SPEED_SOURCE_RANK: Record<string, number> = {
  local_31d: 0,
  provider_override: 0,
  catalog_default: 2,
};

/**
 * Frontier family order the user confirmed: GPT, Claude, Gemini, Grok. The
 * remaining families follow in this table's order, then the stable fallback.
 */
export const FAMILY_ORDER = [
  'GPT',
  'Claude',
  'Gemini',
  'Grok',
  'DeepSeek',
  'Kimi',
  'GLM',
  'Qwen',
  'MiniMax',
  'Hunyuan',
  'Doubao',
  'Composer',
] as const;

export type ModelFamily = (typeof FAMILY_ORDER)[number] | 'Other';

/** Deterministic prefix classification: a family is a leading id token, never a label guess. */
const FAMILY_PREFIXES: ReadonlyArray<[string, ModelFamily]> = [
  ['gpt', 'GPT'],
  ['o1', 'GPT'],
  ['o3', 'GPT'],
  ['o4', 'GPT'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
  ['grok', 'Grok'],
  ['deepseek', 'DeepSeek'],
  ['kimi', 'Kimi'],
  ['glm', 'GLM'],
  ['qwen', 'Qwen'],
  ['minimax', 'MiniMax'],
  ['hunyuan', 'Hunyuan'],
  ['doubao', 'Doubao'],
  ['composer', 'Composer'],
];

/** Brand key shown next to a model name, keyed by family. */
const FAMILY_BRAND: Record<ModelFamily, string> = {
  GPT: 'openai',
  Claude: 'claude',
  Gemini: 'gemini',
  Grok: 'grok',
  DeepSeek: 'deepseek',
  Kimi: 'kimi',
  GLM: 'zhipu',
  Qwen: 'qwen',
  MiniMax: 'minimax',
  Hunyuan: 'hunyuan',
  Doubao: 'doubao',
  Composer: 'cursor',
  Other: '',
};

/** Exact catalog provider id (or prefix) to brand key; unknown ids fall back to the provider id. */
const PROVIDER_BRAND: ReadonlyArray<[string, string]> = [
  ['chatgpt', 'openai'],
  ['openai', 'openai'],
  ['anthropic', 'claude'],
  ['claude', 'claude'],
  ['gemini', 'gemini'],
  ['google', 'gemini'],
  ['spacex-ai', 'grok'],
  ['grok', 'grok'],
  ['deepseek', 'deepseek'],
  ['kimi', 'kimi'],
  ['moonshot', 'kimi'],
  ['zhipu', 'zhipu'],
  ['glm', 'zhipu'],
  ['qwen', 'qwen'],
  ['minimax', 'minimax'],
  ['hunyuan', 'hunyuan'],
  ['doubao', 'doubao'],
  ['volcengine', 'volcengine'],
  ['tokenhub', 'tencentcloud'],
  ['tencent', 'tencentcloud'],
  ['codebuddy', 'codebuddy'],
  ['cursor', 'cursor'],
  ['opencode', 'opencode'],
  ['openrouter', 'openrouter'],
];

/** One provider backing a unified model row. */
export interface ModelListProvider {
  id: string;
  label: string;
  available: boolean;
}

/** One unified model row: all providers that supply the same exact catalog model. */
export interface ModelListRow {
  key: string;
  name: string;
  family: ModelFamily;
  intelligence: string | undefined;
  providers: ModelListProvider[];
  /** True when at least one backing provider is available. */
  active: boolean;
  /** Equal-weight mean TPS over provider measurements; `null` when unmeasured. */
  tps: number | null;
  inputLabel: string;
  outputLabel: string;
  cacheLabel: string;
}

/** A rendered price component: `min–max` when the providers disagree, else the shared value. */
export function formatPriceRange(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const format = (value: number) => String(value);
  return min === max ? format(min) : `${format(min)}–${format(max)}`;
}

/**
 * Equal-weight average over one measurement per provider. Clients that
 * share one provider value must not double-weight it, and an unmeasured provider
 * never contributes a zero. Returns `null` when nothing measured the model.
 */
export function averageMeasuredTps(models: ProviderModelSnapshot[]): number | null {
  const values: number[] = [];
  for (const model of models) {
    const tps = model.effectiveTps;
    if (typeof tps === 'number' && Number.isFinite(tps)) values.push(tps);
  }
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Strongest (lowest-rank) speed source among rows that actually carry a numeric TPS. */
function measuredRank(models: ProviderModelSnapshot[]): number {
  let rank = Number.POSITIVE_INFINITY;
  for (const model of models) {
    if (typeof model.effectiveTps !== 'number' || !Number.isFinite(model.effectiveTps)) continue;
    rank = Math.min(rank, SPEED_SOURCE_RANK[model.speedSource ?? 'catalog_default'] ?? SPEED_SOURCE_RANK.catalog_default);
  }
  return rank;
}

/** Deterministic leading-token family classification with a stable `Other` fallback. */
export function classifyFamily(id: string): ModelFamily {
  const normalized = id.trim().toLowerCase();
  if (/^hy[0-9]/.test(normalized)) return 'Hunyuan';
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (normalized.startsWith(prefix)) return family;
  }
  return 'Other';
}

/** Brand key for a catalog provider id; unknown ids return the id itself so `brandIcon` may still match. */
export function providerBrand(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  for (const [prefix, brand] of PROVIDER_BRAND) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) return brand;
  }
  return normalized;
}

export function familyBrand(family: ModelFamily): string {
  return FAMILY_BRAND[family];
}

function familyRank(family: ModelFamily): number {
  const index = (FAMILY_ORDER as readonly string[]).indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
}

function modelVersion(name: string): number[] {
  const match = name.match(/\d+(?:\.\d+)*/);
  return match ? match[0].split('.').map(Number) : [];
}

function modelSeriesRank(family: ModelFamily, name: string): number {
  if (family !== 'Claude') return 0;
  const series = name.match(/\b(Fable|Opus|Sonnet|Haiku)\b/i)?.[1]?.toLowerCase();
  return { fable: 0, opus: 1, sonnet: 2, haiku: 3 }[series ?? ''] ?? 4;
}

function compareModelVariants(left: string, right: string): number {
  const leftVariant = left.replace(/\d+(?:\.\d+)*/g, '').toLowerCase();
  const rightVariant = right.replace(/\d+(?:\.\d+)*/g, '').toLowerCase();
  return leftVariant.localeCompare(rightVariant);
}

function compareModelVersions(left: string, right: string): number {
  const a = modelVersion(left);
  const b = modelVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Flattens `QuotaSnapshot.catalog` into one row per exact unified model, grouping
 * by `canonicalId ?? id`. Model labels are never treated as equivalence proof:
 * only the canonical identity unifies rows. Rows sort active families first (in
 * `FAMILY_ORDER`), then by series and descending numeric version, and every
 * supported catalog model is kept even when no provider is available.
 */
export function buildModelListRows(snapshot: QuotaSnapshot | null | undefined): ModelListRow[] {
  const catalog: ProviderCatalogSnapshot[] = snapshot?.catalog ?? [];
  interface Accumulator {
    key: string;
    name: string;
    models: ProviderModelSnapshot[];
    providers: ModelListProvider[];
    seenProviders: Set<string>;
  }
  const groups = new Map<string, Accumulator>();

  for (const entry of catalog) {
    for (const model of entry.models ?? []) {
      const key = model.canonicalId ?? model.id;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          name: model.displayName || model.id,
          models: [],
          providers: [],
          seenProviders: new Set<string>(),
        };
        groups.set(key, group);
      }
      // One provider entry per provider; a provider supplying the model twice is not double-counted.
      if (!group.seenProviders.has(entry.id)) {
        group.seenProviders.add(entry.id);
        group.models.push(model);
        group.providers.push({
          id: entry.id,
          label: entry.label || entry.id,
          available: model.available === true,
        });
      } else if (model.available === true) {
        const existing = group.providers.find((provider) => provider.id === entry.id);
        if (existing) existing.available = true;
      }
    }
  }

  const rows: ModelListRow[] = [];
  for (const group of groups.values()) {
    const family = classifyFamily(group.key);
    const active = group.providers.some((provider) => provider.available);
    // Measured providers contribute equally to the average: catalog predictions
    // are a global fallback, not an equal partner to a measured observation.
    const rank = measuredRank(group.models);
    const preferred = group.models.filter((model) => {
      if (typeof model.effectiveTps !== 'number' || !Number.isFinite(model.effectiveTps)) return false;
      return (SPEED_SOURCE_RANK[model.speedSource ?? 'catalog_default'] ?? SPEED_SOURCE_RANK.catalog_default) === rank;
    });
    const intelligence = group.models.find((model) => model.intelligence !== undefined)?.intelligence;
    rows.push({
      key: group.key,
      name: group.name,
      family,
      intelligence,
      providers: group.providers,
      active,
      tps: averageMeasuredTps(preferred),
      inputLabel: formatPriceRange(group.models.map((model) => model.pricing.inputUsdPerMillion)),
      outputLabel: formatPriceRange(group.models.map((model) => model.pricing.outputUsdPerMillion)),
      cacheLabel: formatPriceRange(group.models.map((model) => model.pricing.cachedInputUsdPerMillion)),
    });
  }

  const activeFamilies = new Set(rows.filter((row) => row.active).map((row) => row.family));
  rows.sort((left, right) => {
    const leftActive = activeFamilies.has(left.family);
    const rightActive = activeFamilies.has(right.family);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    const leftFamily = familyRank(left.family);
    const rightFamily = familyRank(right.family);
    if (leftFamily !== rightFamily) return leftFamily - rightFamily;
    const leftSeries = modelSeriesRank(left.family, left.name);
    const rightSeries = modelSeriesRank(right.family, right.name);
    if (leftSeries !== rightSeries) return leftSeries - rightSeries;
    const version = compareModelVersions(left.name, right.name);
    if (version !== 0) return version;
    const variant = compareModelVariants(left.name, right.name);
    return variant !== 0 ? variant : left.name.localeCompare(right.name);
  });
  return rows;
}

const COLUMNS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'model', label: '模型' },
  { id: 'cache', label: '缓存' },
  { id: 'input', label: '输入' },
  { id: 'output', label: '输出' },
  { id: 'tps', label: '速度' },
  { id: 'providers', label: '供应商' },
];

function formatTps(tps: number | null): string {
  if (tps === null) return '—';
  return Number.isInteger(tps) ? String(tps) : tps.toFixed(1);
}

function createIcon(slot: string, brand: string): HTMLSpanElement | null {
  const icon = brandIcon(brand);
  if (icon === null) return null;
  const wrapper = document.createElement('span');
  wrapper.className = slot;
  wrapper.title = brand;
  wrapper.append(icon);
  return wrapper;
}

/**
 * Renders the 模型列表 table. Column headings carry the USD-per-1M-token unit;
 * unavailable provider and model names are muted while active ones stay normal.
 */
export function renderModelList(container: HTMLElement, snapshot: QuotaSnapshot | null | undefined): void {
  const rows = buildModelListRows(snapshot);
  const table = document.createElement('table');
  table.className = 'model-list-table';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of COLUMNS) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = column.id === 'cache' || column.id === 'input' || column.id === 'output'
      ? `${column.label}（$/Mtok）`
      : column.label;
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  if (rows.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = COLUMNS.length;
    cell.className = 'model-list-empty';
    cell.textContent = '未发现受支持的模型。';
    row.append(cell);
    body.append(row);
  }
  for (const row of rows) {
    const tableRow = document.createElement('tr');
    tableRow.dataset.model = row.key;
    tableRow.className = `model-list-row family-${row.family.toLowerCase()}${row.active ? '' : ' is-inactive'}`;

    const model = document.createElement('td');
    const modelCell = document.createElement('span');
    modelCell.className = 'model-list-model';
    const familyIcon = createIcon('model-list-icon', familyBrand(row.family));
    if (familyIcon) modelCell.append(familyIcon);
    const name = document.createElement('span');
    name.className = `model-list-name${row.active ? '' : ' is-muted'}`;
    name.textContent = row.name;
    modelCell.append(name);
    model.append(modelCell);

    const cache = document.createElement('td');
    cache.className = 'model-list-price';
    cache.textContent = row.cacheLabel;
    const input = document.createElement('td');
    input.className = 'model-list-price';
    input.textContent = row.inputLabel;
    const output = document.createElement('td');
    output.className = 'model-list-price';
    output.textContent = row.outputLabel;
    const tps = document.createElement('td');
    tps.className = 'model-list-tps';
    tps.textContent = formatTps(row.tps);

    const providers = document.createElement('td');
    const providerList = document.createElement('span');
    providerList.className = 'model-list-providers';
    for (const provider of row.providers) {
      const chip = document.createElement('span');
      chip.className = `model-list-provider${provider.available ? '' : ' is-muted'}`;
      const icon = createIcon('model-list-icon', providerBrand(provider.id));
      if (icon) chip.append(icon);
      const label = document.createElement('span');
      label.textContent = provider.label;
      chip.append(label);
      providerList.append(chip);
    }
    providers.append(providerList);

    tableRow.append(model, cache, input, output, tps, providers);
    body.append(tableRow);
  }
  table.append(body);
  container.replaceChildren(table);
}
