export interface ProviderOrderEntry {
  id: string;
  /** @deprecated Retained for settings compatibility; ordering is the only user preference. */
  enabled: boolean;
}

/** Collapse legacy/runtime-specific ids to the current product provider id. */
export function canonicalProviderId(rawId: string): string {
  const id = rawId.trim();
  if (id === 'xai') return 'spacex-ai';
  if (id === 'codebuddy' || id.startsWith('codebuddy-')) return 'codebuddy';
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

/** Swap two providers in the shared persisted order. */
export function swapProviders(
  entries: readonly ProviderOrderEntry[],
  firstId: string,
  secondId: string,
): ProviderOrderEntry[] {
  const order = normalizeProviderOrder(entries);
  if (!order.some((entry) => entry.id === firstId)) order.push({ id: firstId, enabled: true });
  if (!order.some((entry) => entry.id === secondId)) order.push({ id: secondId, enabled: true });
  const first = order.findIndex((entry) => entry.id === firstId);
  const second = order.findIndex((entry) => entry.id === secondId);
  if (first < 0 || second < 0 || first === second) return order;
  [order[first], order[second]] = [order[second], order[first]];
  return order;
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
