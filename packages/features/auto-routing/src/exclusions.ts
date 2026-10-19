import { resolveHistoricalOfferedModelId } from '@wrenyard/providers';

type ProviderDefinition = Parameters<typeof resolveHistoricalOfferedModelId>[0];

/**
 * The model ids an exclusion list removes from one provider. An entry is a bare
 * model id or a unified `provider/model` id, resolved only through this
 * provider: a historical spelling of this exact model is excluded, while an
 * unknown or ambiguous spelling is never globally remapped and can therefore
 * never bypass exclusion through another route.
 */
export function excludedModelIdsFor(
  provider: ProviderDefinition | undefined,
  excludedModels: readonly string[],
): ReadonlySet<string> {
  const excluded = new Set(excludedModels);
  if (provider === undefined) return excluded;
  for (const spelling of excludedModels) {
    const registered = resolveHistoricalOfferedModelId(provider, spelling);
    if (registered !== undefined) excluded.add(registered);
  }
  return excluded;
}
