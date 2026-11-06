import { REASONING_EFFORTS, models as registeredModels, type ReasoningEffort } from '@wrenyard/models'
import type { PublicGatewayModel } from '@wrenyard/providers/catalog'

/** One model as the endpoint lists it, normalized onto product metadata. */
export interface NormalizedModelMetadata {
  id: string
  displayName: string
  maxInputTokens: number
  maxOutputTokens?: number
  reasoningEfforts?: readonly ReasoningEffort[]
  inputModalities: readonly string[]
}

const DEFAULT_MAX_INPUT_TOKENS = 200_000
const EFFORT_LEVELS: ReadonlySet<string> = new Set(REASONING_EFFORTS.filter(effort => effort !== 'default'))

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function firstPositiveInteger(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = positiveInteger(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

function effortValues(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const levels = value.flatMap((entry) => {
      if (typeof entry === 'string') return [entry]
      if (isRecord(entry)) {
        const effort = nonEmptyString(entry.effort)
        return effort === undefined ? [] : [effort]
      }
      return []
    })
    return levels
  }
  if (isRecord(value)) {
    for (const key of ['valid', 'valid_efforts', 'values']) {
      const levels = strings(value[key])
      if (levels !== undefined) return levels
    }
  }
  return undefined
}

/** The endpoint's declared reasoning ladder, including an explicit empty list. */
function reasoningEffortsOf(entry: JsonRecord): string[] | undefined {
  for (const key of ['reasoning_levels', 'supported_reasoning_levels']) {
    if (entry[key] === undefined) continue
    const levels = effortValues(entry[key])
    if (levels !== undefined) return levels
  }
  const reasoning = entry.reasoning
  if (isRecord(reasoning)) {
    const levels = effortValues(reasoning.effort)
    if (levels !== undefined) return levels
  }
  const thinkEfforts = entry.think_efforts
  if (isRecord(thinkEfforts)) {
    const levels = effortValues(thinkEfforts)
    if (levels !== undefined) return levels
  }
  return undefined
}

function knownEfforts(levels: readonly string[]): ReasoningEffort[] {
  return levels.filter((level): level is ReasoningEffort => EFFORT_LEVELS.has(level))
}

function inputModalitiesOf(entry: JsonRecord): string[] | undefined {
  const modalities = entry.modalities
  if (isRecord(modalities)) {
    const values = strings(modalities.input)
    if (values !== undefined) return values
  }
  for (const key of ['input_modalities', 'inputModalities']) {
    const values = strings(entry[key])
    if (values !== undefined) return values
  }
  return undefined
}

function catalogFor(id: string) {
  const direct = registeredModels.get(id)
  if (direct !== undefined) return direct
  const separator = id.indexOf('/')
  if (separator <= 0 || separator === id.length - 1) return undefined
  return registeredModels.get(id.slice(separator + 1))
}

function modelsOf(body: unknown): unknown[] {
  if (!isRecord(body)) return []
  if (Array.isArray(body.data)) return body.data
  if (Array.isArray(body.models)) return body.models
  return []
}

/**
 * Normalize one endpoint model-list response onto the metadata sessions consume.
 *
 * Endpoint values win, an exact registered identity supplies a missing field,
 * and only an input limit falls back to the 200k client default. A provider
 * prefix is used solely for the exact catalog lookup; the returned id stays the
 * endpoint's own spelling.
 */
export function parseModelList(body: unknown): NormalizedModelMetadata[] {
  const normalized: NormalizedModelMetadata[] = []
  for (const value of modelsOf(body)) {
    if (!isRecord(value)) continue
    const id = nonEmptyString(value.id) ?? nonEmptyString(value.slug)
    if (id === undefined) continue
    const catalog = catalogFor(id)
    const defaults = catalog?.defaults
    const endpointInput = firstPositiveInteger(value, ['max_input_tokens', 'maxInputTokens', 'input_tokens'])
      ?? (isRecord(value.limit) ? positiveInteger(value.limit.input) : undefined)
    const endpointContext = firstPositiveInteger(value, ['context_window', 'contextWindow', 'context_length', 'contextLength'])
      ?? (isRecord(value.limit) ? positiveInteger(value.limit.context) : undefined)
    const endpointOutput = firstPositiveInteger(value, ['max_output_tokens', 'maxOutputTokens', 'max_tokens', 'maxTokens'])
      ?? (isRecord(value.limit) ? positiveInteger(value.limit.output) : undefined)
    const endpointEfforts = reasoningEffortsOf(value)
    const endpointModalities = inputModalitiesOf(value)
    const displayName = nonEmptyString(value.display_name) ?? nonEmptyString(value.displayName)
      ?? nonEmptyString(value.name) ?? catalog?.displayName ?? id
    const maxInputTokens = endpointInput
      ?? defaults?.maxInputTokens
      ?? endpointContext
      ?? defaults?.contextWindow
      ?? DEFAULT_MAX_INPUT_TOKENS
    const maxOutputTokens = endpointOutput ?? defaults?.maxOutputTokens
    const efforts = endpointEfforts === undefined ? defaults?.reasoningEfforts : knownEfforts(endpointEfforts)
    const modalities = endpointModalities !== undefined && endpointModalities.length > 0
      ? endpointModalities
      : defaults?.inputModalities !== undefined && defaults.inputModalities.length > 0
        ? defaults.inputModalities
        : ['text']
    normalized.push({
      id,
      displayName,
      maxInputTokens,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
      inputModalities: modalities,
    })
  }
  return normalized
}

/**
 * Complete missing metadata on one Gateway connection row from the registered
 * catalog. A non-empty endpoint value wins; an empty effort ladder is treated
 * as undeclared here so registry efforts can backfill it. This executes when
 * the connection is published, so a session still reads only connection
 * metadata. `parseModelList` keeps an endpoint's explicit empty list.
 */
export function withCatalogMetadata(model: PublicGatewayModel): PublicGatewayModel {
  const defaults = registeredModels.get(model.id)?.defaults
  if (defaults === undefined) return model
  const maxInputTokens = model.maxInputTokens ?? defaults.maxInputTokens
  const inputModalities = model.inputModalities ?? defaults.inputModalities
  const capabilities = model.capabilities
    ?? inputModalities?.filter((modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image')
  const backfillEfforts = model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
  return {
    ...model,
    contextWindow: model.contextWindow ?? defaults.contextWindow,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(model.maxOutputTokens === undefined && model.maxTokens === undefined
      && defaults.maxOutputTokens !== undefined
      ? { maxOutputTokens: defaults.maxOutputTokens }
      : {}),
    ...(backfillEfforts && defaults.reasoningEfforts !== undefined
      ? { reasoningEfforts: defaults.reasoningEfforts }
      : {}),
    ...(capabilities === undefined || capabilities.length === 0 ? {} : { capabilities }),
  }
}
