export interface ProviderOrderEntry {
  id: string;
  /** @deprecated Retained for settings compatibility; ordering is the only user preference. */
  enabled: boolean;
}

/** Collapse legacy/runtime-specific ids to the current product provider id.
 *  The legacy `codex` provider id migrates to the single `chatgpt` provider
 *  (data migration only; the registry defines no aliases).
 *  The codex client remains distinct.
 *  The legacy internal `opencode-native` id migrates to the current
 *  `opencode-zen` provider so a saved order entry keeps its position. */
export function canonicalProviderId(rawId: string): string {
  const id = rawId.trim();
  if (id === 'xai') return 'spacex-ai';
  if (id === 'codebuddy' || id.startsWith('codebuddy-')) return 'codebuddy';
  if (id === 'codex') return 'chatgpt';
  if (id === 'opencode-native') return 'opencode-zen';
  return id;
}

/** Keep one bounded entry per provider while preserving the user's order. */
export function normalizeProviderOrder(entries: readonly ProviderOrderEntry[]): ProviderOrderEntry[] {
  const positions = new Map<string, number>();
  const normalized: ProviderOrderEntry[] = [];
  for (const entry of entries) {
    const id = canonicalProviderId(entry.id);
    if (!id) continue;
    const position = positions.get(id);
    if (position !== undefined) {
      continue;
    }
    positions.set(id, normalized.length);
    normalized.push({ id, enabled: true });
  }
  return normalized;
}

/**
 * Apply a user-supplied id order. The legacy enablement bit is normalized to
 * true because activation and quota capability now determine visibility.
 */
export function reorderProviders(
  entries: readonly ProviderOrderEntry[],
  orderedIds: readonly string[],
): ProviderOrderEntry[] {
  const existing = new Map(normalizeProviderOrder(entries).map((entry) => [entry.id, entry]));
  const result: ProviderOrderEntry[] = [];
  const seen = new Set<string>();
  const append = (rawId: string): void => {
    const id = canonicalProviderId(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(existing.get(id) ?? { id, enabled: true });
  };
  for (const id of orderedIds) append(id);
  for (const id of existing.keys()) append(id);
  return result.map((entry) => ({ ...entry }));
}

/** Available providers form the leading section; user order is stable inside each section. */
export function sortProvidersByAvailability<T extends { id: string; configured: boolean }>(
  providers: readonly T[],
  entries: readonly ProviderOrderEntry[],
): T[] {
  const preference = new Map(normalizeProviderOrder(entries).map((entry, index) => [entry.id, index]));
  return providers
    .map((provider, sourceIndex) => ({ provider, sourceIndex }))
    .sort((left, right) => {
      if (left.provider.configured !== right.provider.configured) return left.provider.configured ? -1 : 1;
      const leftIndex = preference.get(left.provider.id) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = preference.get(right.provider.id) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || left.sourceIndex - right.sourceIndex;
    })
    .map(({ provider }) => provider);
}
