import type {
  ProviderCatalogSnapshot,
  ProviderModelSnapshot,
  QuotaSnapshot,
} from '@/shell-contract';
import { FAMILY_ORDER, classifyFamily, type ModelFamily } from '@/renderer/lib/model-brand';

/**
 * Pure model-list projection for the Model Supply page. No React, DOM, bridge
 * or window access lives here: the component layer renders exactly the rows
 * this module derives from a quota snapshot.
 */

/** Evidence tiers ordered strongest-first; a measured tier always outranks a catalog default. */
const SPEED_SOURCE_RANK: Record<string, number> = {
  local_31d: 0,
  provider_override: 0,
  catalog_default: 2,
};

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
  intelligence: ProviderModelSnapshot['intelligence'];
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
  if (values.length === 0) return '—';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const format = (value: number) => String(value);
  return min === max ? format(min) : `${format(min)}–${format(max)}`;
}

/**
 * Equal-weight average over one measurement per provider. Clients that share
 * one provider value must not double-weight it, and an unmeasured provider
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
    rank = Math.min(
      rank,
      SPEED_SOURCE_RANK[model.speedSource ?? 'catalog_default'] ?? SPEED_SOURCE_RANK.catalog_default,
    );
  }
  return rank;
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
  const series = name.match(/\b(fable|opus|sonnet|haiku)\b/i)?.[1]?.toLowerCase();
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
      inputLabel: formatPriceRange(group.models.map((model) => model.pricing[1])),
      outputLabel: formatPriceRange(group.models.map((model) => model.pricing[2])),
      cacheLabel: formatPriceRange(group.models.map((model) => model.pricing[0])),
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

/** Sentinel used by the family filter for "keep every family". */
export const MODEL_FAMILY_ALL = 'all';

/** Sort orders offered next to the family filter. */
export type ModelSort = 'default' | 'name' | 'speed';

/** Families actually present in the current rows, in canonical `FAMILY_ORDER`. */
export function modelFamilyOptions(rows: ModelListRow[]): ModelFamily[] {
  const present = new Set(rows.map((row) => row.family));
  const ordered: ModelFamily[] = FAMILY_ORDER.filter((family) => present.has(family));
  if (present.has('Other')) ordered.push('Other');
  return ordered;
}

/** Filter rows by family and a case-insensitive name/id substring. */
export function filterModelRows(
  rows: ModelListRow[],
  family: ModelFamily | typeof MODEL_FAMILY_ALL,
  query: string,
): ModelListRow[] {
  const trimmed = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (family !== MODEL_FAMILY_ALL && row.family !== family) return false;
    if (trimmed.length === 0) return true;
    return row.name.toLowerCase().includes(trimmed) || row.key.toLowerCase().includes(trimmed);
  });
}

/** Reorder rows for display; `default` keeps the catalog-derived order. */
export function sortModelRows(rows: ModelListRow[], sort: ModelSort): ModelListRow[] {
  if (sort === 'default') return rows;
  const copy = [...rows];
  if (sort === 'name') {
    copy.sort((left, right) => left.name.localeCompare(right.name));
    return copy;
  }
  // Speed: measured rows descend, unmeasured rows stay last.
  copy.sort((left, right) => {
    const a = left.tps ?? Number.NEGATIVE_INFINITY;
    const b = right.tps ?? Number.NEGATIVE_INFINITY;
    return b - a;
  });
  return copy;
}

/** `42`, `45.1`, `—` for an unmeasured model. */
export function formatTps(tps: number | null): string {
  if (tps === null) return '—';
  return Number.isInteger(tps) ? String(tps) : tps.toFixed(1);
}
