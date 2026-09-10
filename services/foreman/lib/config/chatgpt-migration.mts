/** One-time migration of persisted provider references; never client/auth identities. */
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function migrateProviderId(value: string): string {
  return value === 'codex' || value === 'codex-spark' ? 'chatgpt' : value;
}
export function migrateProviderTargetId(value: string): string {
  return value.replace(/^(?:codex|codex-spark)\//, 'chatgpt/');
}
function migrate<T>(original: T, apply: (record: RecordValue) => void): { record: T; changed: boolean } {
  if (!object(original)) return { record: original, changed: false };
  const record = structuredClone(original);
  apply(record);
  const changed = JSON.stringify(record) !== JSON.stringify(original);
  return { record: changed ? record : original, changed };
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
    const convert = key === 'excludeProviderIds' ? migrateProviderId : migrateProviderTargetId;
    layer.dispatch[key] = [...new Set(entries.map((entry) => typeof entry === 'string' ? convert(entry) : entry))];
  }
}
export function migrateForemanChatGPTReferences<T>(record: T): { record: T; changed: boolean } {
  return migrate(record, (root) => {
    const settings = object(root.tasks) ? root.tasks.settings : undefined;
    if (!object(settings)) return;
    migrateLayer(settings.global);
    if (object(settings.byTask)) Object.values(settings.byTask).forEach(migrateLayer);
  });
}
function migrateProviderKeys(value: unknown): unknown {
  if (!object(value) || !('codex' in value || 'codex-spark' in value)) return value;
  const selected = value.chatgpt ?? value.codex ?? value['codex-spark'];
  const next: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    const canonical = migrateProviderId(key);
    next[canonical] = canonical === 'chatgpt' ? selected : entry;
  }
  return next;
}
export function migrateRuntimeChatGPTReferences<T>(record: T): { record: T; changed: boolean } {
  return migrate(record, (root) => {
    if (object(root.aliases)) {
      for (const [name, target] of Object.entries(root.aliases)) {
        if (typeof target === 'string') root.aliases[name] = migrateProviderTargetId(target);
      }
    }
    if (root.providers !== undefined) root.providers = migrateProviderKeys(root.providers);
    if (root.policy_max_usage_pct !== undefined) root.policy_max_usage_pct = migrateProviderKeys(root.policy_max_usage_pct);
  });
}
