import type { TaskFeatureConfig } from './types.mts'

/**
 * Resolve selected feature ids from a TaskFeatureConfig.
 *
 * Normalizes, trims, and deduplicates selected ids in declaration order.
 * Returns [] when no feature config exists.
 *
 * Validation errors are surfaced as Error throws so callers can treat them
 * as deterministic task execution errors before launching an agent.
 */
export function resolveFeatures(
  config: TaskFeatureConfig | undefined,
  input: unknown,
): readonly string[] {
  if (!config) return []

  const available = validateAvailableIds(config.available)

  if (!config.select) {
    // When select is absent, all available features are mounted.
    return available
  }

  const selected = config.select(input)
  return normalizeSelectedIds(selected, available)
}

function validateAvailableIds(available: readonly string[]): readonly string[] {
  if (!Array.isArray(available)) {
    throw new Error('TaskFeatureConfig.available must be an array of non-empty strings')
  }
  const seen = new Set<string>()
  for (const id of available) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('TaskFeatureConfig.available must contain only non-empty strings')
    }
    const trimmed = id.trim()
    if (seen.has(trimmed)) {
      throw new Error(`Duplicate feature id in available: '${trimmed}'`)
    }
    seen.add(trimmed)
  }
  return available.map((id) => id.trim())
}

function normalizeSelectedIds(
  selected: readonly string[] | undefined,
  available: readonly string[],
): readonly string[] {
  if (!Array.isArray(selected)) {
    throw new Error('Feature select() must return an array of non-empty strings')
  }

  if (selected.length === 0) {
    return []
  }

  const availSet = new Set(available)
  const result: string[] = []

  for (const id of selected) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('Feature select() returned an empty or non-string id')
    }
    const trimmed = id.trim()
    if (!availSet.has(trimmed)) {
      throw new Error(
        `Selected feature '${trimmed}' is not in the declared available set: [${available.join(', ')}]`,
      )
    }
    if (!result.includes(trimmed)) {
      result.push(trimmed)
    }
  }

  return result
}
