import { models } from '@wrenyard/models';
import type {
  DisplayCurrency,
  ProviderCatalogSnapshot,
  ProviderModelSnapshot,
  QuotaSnapshot,
} from '@/shell-contract';
import { CNY_PER_USD } from '@/shell-contract';
import { FAMILY_ORDER, classifyFamily, type ModelFamily } from '@/renderer/lib/model-brand';

/**
 * Pure model-list projection for the Model Supply page. No React, DOM, bridge
 * or window access lives here: the component layer renders exactly the rows
 * this module derives from a quota snapshot.
 */

/**
 * Evidence tiers that are real pair measurements. `catalog_default` is the
 * registry fallback for a pair without evidence and `free_supply_floor` is a
 * ranking floor; neither is a measurement, so neither contributes a sample.
 */
const MEASURED_SPEED_SOURCES: ReadonlySet<string> = new Set(['local_31d', 'provider_override']);

/** One provider-attributed credit multiplier declared for a unified model row. */
export interface ModelListCredit {
  /** Verbatim multiplier string from the provider offering (e.g. `x1.33 credits`). */
  value: string;
  /** Offering display name; present only when this provider declares more than
   * one distinct multiplier for the row, so each value stays attributable. */
  label?: string;
}

/** One provider backing a unified model row. */
export interface ModelListProvider {
  id: string;
  label: string;
  available: boolean;
  /** Distinct credit multipliers this provider declares for the row, in
   * encounter order; absent when the provider declares none. Never combined
   * across providers. */
  credits?: ModelListCredit[];
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
  /** Equal-weight mean TPS over provider measurements; the registered default when unmeasured. */
  tps: number | null;
  inputLabel: string;
  outputLabel: string;
  cacheLabel: string;
}

/** A rendered price component: `min–max` when the providers disagree, else the shared value. */
export function formatPriceRange(values: number[], currency: DisplayCurrency = 'CNY'): string {
  if (values.length === 0) return '—';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const format = (value: number) => {
    if (currency !== 'CNY') return String(value);
    const converted = value * CNY_PER_USD;
    const rounded = Math.round(converted * 100) / 100;
    return String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  };
  return min === max ? format(min) : `${format(min)}–${format(max)}`;
}

/**
 * Equal-weight average over one measurement per provider. Clients that share
 * one provider value must not double-weight it, and an unmeasured provider
 * never contributes a zero. Returns `null` when nothing measured the model.
 */
/**
 * Equal-provider-weight average of genuinely measured pair TPS.
 *
 * Only `local_31d` and `provider_override` rows are measurements; a registry
 * default and a free-supply ranking floor are not samples and never contribute.
 * The caller passes one row per provider, so a provider declares its weight
 * exactly once and an unmeasured provider never contributes a zero. Returns
 * `null` when no provider measured the model.
 */
export function averageMeasuredTps(models: ProviderModelSnapshot[]): number | null {
  const values: number[] = [];
  for (const model of models) {
    if (!MEASURED_SPEED_SOURCES.has(model.speedSource ?? '')) continue;
    const tps = model.effectiveTps;
    if (typeof tps === 'number' && Number.isFinite(tps) && tps > 0) values.push(tps);
  }
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
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
 * by the registered model id. Model labels are never treated as equivalence
 * proof, and there is no secondary canonical identity: one registered id is the
 * only grouping key. Rows sort active families first (in
 * `FAMILY_ORDER`), then by series and descending numeric version, and every
 * supported catalog model is kept even when no provider is available.
 */
export function buildModelListRows(
  snapshot: QuotaSnapshot | null | undefined,
  currency: DisplayCurrency = 'CNY',
): ModelListRow[] {
  const catalog: ProviderCatalogSnapshot[] = snapshot?.catalog ?? [];
  interface Accumulator {
    key: string;
    name: string;
    models: ProviderModelSnapshot[];
    providers: ModelListProvider[];
    seenProviders: Set<string>;
    /** Provider id -> (distinct credit value -> the offering display name that declared it). */
    credits: Map<string, Map<string, string>>;
  }
  const groups = new Map<string, Accumulator>();

  for (const entry of catalog) {
    for (const model of entry.models ?? []) {
      const key = model.id;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          name: model.displayName || model.id,
          models: [],
          providers: [],
          seenProviders: new Set<string>(),
          credits: new Map<string, Map<string, string>>(),
        };
        groups.set(key, group);
      }
      // The credit multiplier is recorded per provider even when the provider is
      // already present, so every distinct value on a grouped row survives and
      // stays attributable to the offering that declared it. It is never a
      // missing multiplier and is never combined across providers.
      if (model.credits !== undefined) {
        let byValue = group.credits.get(entry.id);
        if (!byValue) {
          byValue = new Map<string, string>();
          group.credits.set(entry.id, byValue);
        }
        if (!byValue.has(model.credits)) byValue.set(model.credits, model.displayName || model.id);
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
    // Measured providers contribute equally. `group.models` carries at most one
    // row per provider, so this is the equal-provider-weight average of real
    // pair measurements; no provider's source rank excludes another provider,
    // and a registry default copy is not counted as a measurement.
    const preferred = group.models;
    const intelligence = group.models.find((model) => model.intelligence !== undefined)?.intelligence;
    const providers = group.providers.map((provider): ModelListProvider => {
      const byValue = group.credits.get(provider.id);
      if (!byValue || byValue.size === 0) return provider;
      // A single distinct multiplier is unambiguous; several are each labelled
      // with their offering display name so none is misattributed.
      const credits: ModelListCredit[] = byValue.size === 1
        ? [...byValue.keys()].map((value) => ({ value }))
        : [...byValue.entries()].map(([value, label]) => ({ value, label }));
      return { ...provider, credits };
    });
    rows.push({
      key: group.key,
      name: group.name,
      family,
      intelligence,
      providers,
      active,
      // Measured providers contribute equally when any measured the model;
      // otherwise the registered identity's default speed is the fallback.
      tps: averageMeasuredTps(preferred) ?? models.require(group.key).defaults.speed,
      // A model with no declared price contributes no price point at all; the
      // range falls back to the em dash instead of a fabricated zero.
      inputLabel: formatPriceRange(group.models.flatMap((model) => model.pricing === undefined ? [] : [model.pricing[1]]), currency),
      outputLabel: formatPriceRange(group.models.flatMap((model) => model.pricing === undefined ? [] : [model.pricing[2]]), currency),
      cacheLabel: formatPriceRange(group.models.flatMap((model) => model.pricing === undefined ? [] : [model.pricing[0]]), currency),
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
