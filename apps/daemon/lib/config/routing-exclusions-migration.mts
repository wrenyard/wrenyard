/** One-time relocation of the GLOBAL model/provider exclusions from the legacy
 *  `tasks.settings.global.dispatch` keys to the neutral root
 *  `routing.exclude.models` / `routing.exclude.providers`. Per-task exclusions
 *  are never touched. */
type RecordValue = Record<string, unknown>;

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Legacy global exclusion keys, camelCase plus the accepted snake_case alias. */
const GLOBAL_LEGACY_EXCLUSION_KEYS = {
  models: ['excludeModelIds', 'exclude_model_ids'],
  providers: ['excludeProviderIds', 'exclude_provider_ids'],
} as const;

type ExclusionKind = keyof typeof GLOBAL_LEGACY_EXCLUSION_KEYS;

/** Malformed values fail loudly: an unreadable exclusion is never dropped. */
function normalizeList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid config: ${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`Invalid config: ${label} must contain only non-empty strings`);
    }
    out.push(entry.trim());
  }
  return out;
}

/** Stable dedupe: first occurrence wins, so new values keep their order and
 *  legacy values are appended after them. */
function unionDedupe(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Relocate the global model/provider exclusions of one config document.
 *
 * Only GLOBAL legacy keys under `tasks.settings.global.dispatch` are detected;
 * every unrelated key and every per-task entry is preserved verbatim. Values
 * already at `routing.exclude` come first, legacy values are appended, and the
 * union is deduplicated stably. The legacy keys are then deleted. A document
 * with no legacy key is returned unchanged (no write, no marker), so the
 * migration is idempotent and an already-migrated document stays identical.
 */
export function migrateGlobalRoutingExclusions<T>(record: T): { record: T; changed: boolean } {
  if (!object(record)) return { record, changed: false };
  const settings = object(record.tasks) ? record.tasks.settings : undefined;
  const globalLayer = object(settings) ? settings.global : undefined;
  const rawDispatch = object(globalLayer) ? globalLayer.dispatch : undefined;
  if (!object(rawDispatch)) return { record, changed: false };
  const dispatch = rawDispatch;

  const legacy: Partial<Record<ExclusionKind, string[]>> = {};
  for (const kind of ['models', 'providers'] as const) {
    for (const alias of GLOBAL_LEGACY_EXCLUSION_KEYS[kind]) {
      const value = dispatch[alias];
      if (value === undefined || value === null) continue;
      legacy[kind] = unionDedupe(legacy[kind] ?? [], normalizeList(value, `tasks.settings.global.dispatch.${alias}`));
    }
  }
  if (legacy.models === undefined && legacy.providers === undefined) {
    return { record, changed: false };
  }

  const next = structuredClone(record) as RecordValue;
  const nextGlobal = ((next.tasks as RecordValue).settings as RecordValue).global as RecordValue;
  const nextDispatch = nextGlobal.dispatch as RecordValue;
  const existingExclude = object(next.routing) ? next.routing.exclude : undefined;
  const current: Partial<Record<ExclusionKind, string[]>> = {};
  if (object(existingExclude)) {
    if (existingExclude.models !== undefined && existingExclude.models !== null) {
      current.models = normalizeList(existingExclude.models, 'routing.exclude.models');
    }
    if (existingExclude.providers !== undefined && existingExclude.providers !== null) {
      current.providers = normalizeList(existingExclude.providers, 'routing.exclude.providers');
    }
  }

  for (const kind of ['models', 'providers'] as const) {
    for (const alias of GLOBAL_LEGACY_EXCLUSION_KEYS[kind]) delete nextDispatch[alias];
  }
  if (Object.keys(nextDispatch).length === 0) delete nextGlobal.dispatch;

  const merged: RecordValue = { ...(object(existingExclude) ? existingExclude : {}) };
  for (const kind of ['models', 'providers'] as const) {
    const values = legacy[kind] === undefined
      ? current[kind]
      : unionDedupe(current[kind] ?? [], legacy[kind]);
    if (values === undefined) delete merged[kind];
    else merged[kind] = values;
  }
  const routing: RecordValue = object(next.routing) ? { ...next.routing } : {};
  if (Object.keys(merged).length > 0) {
    routing.exclude = merged;
    next.routing = routing;
  } else {
    delete routing.exclude;
    if (Object.keys(routing).length === 0) delete next.routing;
    else next.routing = routing;
  }

  const changed = JSON.stringify(next) !== JSON.stringify(record);
  return { record: changed ? (next as T) : record, changed };
}
