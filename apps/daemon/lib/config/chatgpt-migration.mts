/** One-time migration of persisted provider references; never client/auth identities. */
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Exact legacy provider ids mapped to their renamed canonical ids. `anthropic`
 *  (the old subscription provider) is deliberately absent here because it now
 *  means the API provider; it is handled as a one-shot rename in
 *  {@link PROVIDER_ID_RENAMES} so it is never rewritten again. */
const LEGACY_PROVIDER_IDS: Readonly<Record<string, string>> = {
  codex: 'chatgpt',
  'anthropic-api': 'anthropic',
  'opencode-native': 'opencode-zen',
};
/** Legacy id of the subscription Claude provider: it now lives at `claude-coding`. */
const LEGACY_SUBSCRIPTION_PROVIDER_ID = 'anthropic';
/** Canonical id of the subscription Claude provider. */
const SUBSCRIPTION_PROVIDER_ID = 'claude-coding';
/** Left-to-right matchers for the bare/leaf provider ids used by
 *  `excludeProviderIds` and runtime provider maps. The subscription entry must
 *  be tested before the API entry so a legacy `anthropic` leaf becomes
 *  `claude-coding` exactly once. A text value is staged with a sentinel while
 *  rewriting, so a later stage in the same pass (and any second pass) leaves an
 *  already-migrated document byte-identical and never aliases a modern API
 *  `anthropic` back to the subscription provider. */
const PROVIDER_ID_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(LEGACY_PROVIDER_IDS).map(([from, to]) => [from, to] as const),
  [LEGACY_SUBSCRIPTION_PROVIDER_ID, SUBSCRIPTION_PROVIDER_ID],
];

const STAGE_PREFIX = '\u0000';
const stageProviderSentinel = (value: string): string => `${STAGE_PREFIX}${value}`;
const unstageProviderSentinel = (value: string): string =>
  value.startsWith(STAGE_PREFIX) ? value.slice(STAGE_PREFIX.length) : value;

/** True once a value carries the inner-stage sentinel. */
function isStagedProvider(value: string): boolean {
  return value.startsWith(STAGE_PREFIX);
}

/** Stage a legacy provider id rewrite on its sentinel form. The sentinel marks
 *  the result as canonical for a single migration pass, so a later stage never
 *  chains a rewritten id onward. Matching stops at the first hit. */
function stageProviderId(value: string): string {
  if (isStagedProvider(value)) return value;
  for (const [from, to] of PROVIDER_ID_RENAMES) {
    if (value === from) return stageProviderSentinel(to);
  }
  return value;
}

/**
 * Migrate a bare provider id outside a full document pass (historical stats
 * lookups). Only the exact legacy identity aliases are rewritten; the legacy
 * subscription `anthropic` is deliberately NOT aliased here, because a modern
 * API `anthropic` and a historical subscription `anthropic` are
 * indistinguishable from a single bare id and the API meaning is current.
 */
export function migrateProviderId(value: string): string {
  return LEGACY_PROVIDER_IDS[value] ?? value;
}

/**
 * Migrate a provider target. Only the provider segment of
 * `<provider>/<model>[:<client>]` is rewritten: exact legacy ids are remapped,
 * and the legacy subscription id becomes `claude-coding`. The model id and any
 * `:<client>` suffix stay byte-identical. A canonical provider is marked with
 * the inner-stage sentinel so a later stage of the same pass never aliases an
 * API `anthropic` back to the subscription provider.
 */
export function migrateProviderTargetId(value: string): string {
  const slash = value.indexOf('/');
  if (slash < 0) return stageProviderId(value);
  return `${stageProviderId(value.slice(0, slash))}${value.slice(slash)}`;
}

/** Public target migration for callers outside a full document pass. */
export function migrateStoredProviderTargetId(value: string): string {
  return unstageProviderSentinel(migrateProviderTargetId(value));
}

function migrate<T>(original: T, apply: (record: RecordValue) => void): { record: T; changed: boolean } {
  if (!object(original)) return { record: original, changed: false };
  const record = structuredClone(original);
  apply(record);
  const changed = JSON.stringify(record) !== JSON.stringify(original);
  return { record: changed ? record : original, changed };
}
function isProviderKey(value: string): boolean {
  if (isStagedProvider(value)) return false;
  return stageProviderId(value) !== value;
}

function migrateLayer(layer: unknown): void {
  if (!object(layer)) return;
  const ref = layer.explicitRuntime;
  if (object(ref) && ref.kind === 'target' && typeof ref.target === 'string') {
    ref.target = migrateProviderTargetId(ref.target);
  }
  if (!object(layer.dispatch)) return;
  for (const key of ['excludeProviderIds', 'excludeModelIds', 'excludeProfileIds']) {
    const entries = layer.dispatch[key];
    if (!Array.isArray(entries)) continue;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (typeof entry !== 'string') continue;
      const migrated = key === 'excludeProviderIds'
        ? stageProviderId(entry)
        : migrateProviderTargetId(entry);
      entries[index] = isStagedProvider(migrated) ? unstageProviderSentinel(migrated) : migrated;
    }
    layer.dispatch[key] = [...new Set(entries)];
  }
}

/** Marker written into a foreman config document once provider identities have
 *  been migrated. Its presence means later reads must leave canonical
 *  `anthropic` (API) references untouched instead of reinterpreting them. */
export const FOREMAN_PROVIDER_MIGRATION_MARKER = 'provider-identity-v1';

export function hasForemanProviderMigrationMarker(record: unknown): boolean {
  return object(record) && record.providerMigration === FOREMAN_PROVIDER_MIGRATION_MARKER;
}

/** Add the migration marker to a foreman config document, preserving unknowns. */
export function markForemanProviderMigration<T>(record: T): { record: T; changed: boolean } {
  return migrate(record, (root) => {
    if (root.providerMigration === FOREMAN_PROVIDER_MIGRATION_MARKER) return;
    root.providerMigration = FOREMAN_PROVIDER_MIGRATION_MARKER;
  });
}

/** Migrate persisted task settings provider references (explicit runtime
 *  targets and dispatch exclusions). Callers gate this on
 *  {@link hasForemanProviderMigrationMarker} so a legacy document migrates
 *  exactly once and later reads leave modern `anthropic` API refs untouched. */
export function migrateForemanChatGPTReferences<T>(record: T): { record: T; changed: boolean } {
  const staged = migrate(record, (root) => {
    const settings = object(root.tasks) ? root.tasks.settings : undefined;
    if (!object(settings)) return;
    migrateLayer(settings.global);
    if (object(settings.byTask)) Object.values(settings.byTask).forEach(migrateLayer);
  });
  if (!staged.changed) return staged;
  return finalize(record, staged.record);
}

/** Build a runtime provider-map migrator. `migrateKey` stages the rewrite so a
 *  later stage of the same pass cannot chain it; an id already present in the
 *  source wins over a mapped legacy alias, which otherwise carries its value to
 *  the canonical key. */
function providerKeyMigrator(
  migrateKey: (value: string) => string,
): (value: unknown) => unknown {
  return (value: unknown): unknown => {
    if (!object(value)) return value;
    if (!Object.keys(value).some(isProviderKey)) return value;
    const next: RecordValue = {};
    for (const [key, entry] of Object.entries(value)) {
      const staged = migrateKey(key);
      // An explicit canonical entry already in the source wins over a mapped
      // legacy alias; look it up under its plain (unstaged) id.
      const canonical = unstageProviderSentinel(staged);
      const canonicalIsStable = stageProviderId(canonical) === canonical;
      next[staged] = staged === key || !canonicalIsStable ? entry : (value[canonical] ?? entry);
    }
    return next;
  };
}

const migrateRuntimeProviderKey = providerKeyMigrator(stageProviderId);
const migratePolicyProviderKey = providerKeyMigrator(migrateProviderTargetId);

/** Migrate persisted runtime alias references: alias targets, provider keys,
 *  and policy provider keys. Callers gate this on
 *  {@link hasRuntimeProviderMigrationMarker}. */
export function migrateRuntimeChatGPTReferences<T>(record: T): { record: T; changed: boolean } {
  const staged = migrate(record, (root) => {
    if (object(root.aliases)) {
      for (const [name, target] of Object.entries(root.aliases)) {
        if (typeof target === 'string') root.aliases[name] = migrateProviderTargetId(target);
      }
    }
    if (root.providers !== undefined) root.providers = migrateRuntimeProviderKey(root.providers);
    if (root.policy_max_usage_pct !== undefined) {
      root.policy_max_usage_pct = migratePolicyProviderKey(root.policy_max_usage_pct);
    }
  });
  if (!staged.changed) return staged;
  return finalize(record, staged.record);
}

/** Recursively strip the inner-stage sentinel from every string in a migrated
 *  document so the persisted value is the plain canonical id. */
function unstageDeep(value: unknown): unknown {
  if (typeof value === 'string') return unstageProviderSentinel(value);
  if (Array.isArray(value)) return value.map(unstageDeep);
  if (object(value)) {
    const next: RecordValue = {};
    for (const [key, entry] of Object.entries(value)) next[unstageDeep(key) as string] = unstageDeep(entry);
    return next;
  }
  return value;
}

/** Finalize a migrated document: strip stage sentinels and report whether the
 *  persisted value differs from the caller's input. */
function finalize<T>(original: T, staged: T): { record: T; changed: boolean } {
  const record = unstageDeep(staged) as T;
  return { record, changed: JSON.stringify(record) !== JSON.stringify(original) };
}

/** Marker key for the runtime alias document. Underscore-prefixed so it cannot
 *  collide with an alias name, and unrelated top-level fields stay verbatim. */
export const RUNTIME_PROVIDER_MIGRATION_MARKER_KEY = '_providerMigration';
export const RUNTIME_PROVIDER_MIGRATION_MARKER = 'provider-identity-v1';

export function hasRuntimeProviderMigrationMarker(record: unknown): boolean {
  return (
    object(record) &&
    record[RUNTIME_PROVIDER_MIGRATION_MARKER_KEY] === RUNTIME_PROVIDER_MIGRATION_MARKER
  );
}

export function markRuntimeProviderMigration<T>(record: T): { record: T; changed: boolean } {
  return migrate(record, (root) => {
    if (root[RUNTIME_PROVIDER_MIGRATION_MARKER_KEY] === RUNTIME_PROVIDER_MIGRATION_MARKER) return;
    root[RUNTIME_PROVIDER_MIGRATION_MARKER_KEY] = RUNTIME_PROVIDER_MIGRATION_MARKER;
  });
}

/** `providerMigration` entry used when generating a fresh foreman config, so a
 *  first-run document starts pre-marked and never triggers a legacy rewrite. */
export const FOREMAN_PROVIDER_MIGRATION_MARKER_ENTRY: Readonly<Record<string, string>> =
  Object.freeze({ providerMigration: FOREMAN_PROVIDER_MIGRATION_MARKER });

/** Marker entry used when generating a fresh runtime alias document. */
export const RUNTIME_PROVIDER_MIGRATION_MARKER_ENTRY: Readonly<Record<string, string>> =
  Object.freeze({ [RUNTIME_PROVIDER_MIGRATION_MARKER_KEY]: RUNTIME_PROVIDER_MIGRATION_MARKER });
