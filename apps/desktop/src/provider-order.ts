export interface ProviderOrderEntry {
  id: string;
  /** @deprecated Retained for settings compatibility; ordering is the only user preference. */
  enabled: boolean;
}

/**
 * Trim a saved provider id. Provider identity migrations are gone: discovery and
 * quota data already supply canonical ids, and a preference only reorders the
 * providers those current sources report. An empty result is an unusable row.
 */
export function normalizeProviderId(rawId: string): string {
  return rawId.trim();
}

/** Keep one bounded entry per provider while preserving the user's order. */
export function normalizeProviderOrder(entries: readonly ProviderOrderEntry[]): ProviderOrderEntry[] {
  const seen = new Set<string>();
  const normalized: ProviderOrderEntry[] = [];
  for (const entry of entries) {
    const id = normalizeProviderId(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
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
    const id = normalizeProviderId(rawId);
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
