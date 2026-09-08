import {
  INTELLIGENCE_ORDER,
  type IntelligenceTier,
  type TaskDispatchRequirements as CatalogTaskDispatchRequirements,
} from '@wrenyard/catalog'

/**
 * Canonical Task settings model and effective-settings resolver.
 *
 * Settings for a task are layered, and the effective value of every
 * configurable field is resolved by walking the layers in a fixed order
 * (system defaults -> builtin Task defaults -> user global -> user task ->
 * invocation) where the rightmost layer that defines a field wins.
 *
 * A layer is a partial description. Resetting a previously-pinned value is
 * expressed by deleting the field from the responsible layer (leaving it
 * undefined), which makes the next lower defined value inherit again. Layers
 * never carry copies of defaults.
 *
 * Runtime selection is mode-driven and has exactly two modes:
 *   - `automatic` ignores any explicit reference found on lower/inherited
 *     layers (a stale reference is dropped, never validated nor resolved).
 *   - `explicit` requires one structural explicit reference (an alias name or
 *     an inline target) to be effective. This module never resolves aliases
 *     nor checks compatibility against a catalog: it only carries the
 *     structural reference forward for the daemon to honor.
 *
 * Task definitions never pin a runtime; every Task defaults to `automatic`.
 * The only per-task user selection source is the persisted
 * `tasks.settings.byTask` map (plus the user-global and invocation layers).
 * This module is dependency-light by design: it only consumes plain layer
 * shapes plus persisted `tasks.settings.global`/`tasks.settings.byTask`. It
 * never mutates configuration input.
 */

export type TaskSelectionMode = 'automatic' | 'explicit'

export type TaskSettingsSourceTag =
  | 'system_global'
  | 'builtin_task'
  | 'user_global'
  | 'user_task'
  | 'invocation'

export const TASK_SETTINGS_SOURCE_ORDER: readonly TaskSettingsSourceTag[] = [
  'system_global',
  'builtin_task',
  'user_global',
  'user_task',
  'invocation',
]

/** System default mode: automatic selection. */
export const SYSTEM_DEFAULT_MODE: TaskSelectionMode = 'automatic'

/** System default total execution timeout: 15 minutes. */
export const SYSTEM_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export type TaskDefinitionKind = 'builtin' | 'project'

/** Stable key used for `tasks.settings.byTask` entries. */
export type TaskSettingsIdentity = string

/**
 * Builds the stable task-settings identity: `builtin:<name>` for builtin
 * definitions and `project:<project>:<name>` for project definitions.
 */
export function taskSettingsIdentity(definition: {
  kind?: TaskDefinitionKind
  name: string
  project?: string
}): TaskSettingsIdentity {
  if (definition.kind === 'project') {
    return `project:${definition.project ?? ''}:${definition.name}`
  }
  return `builtin:${definition.name}`
}

/* -------------------------------------------------------------------------- *
 * Dispatch requirements (the tunable automatic-execution fields)
 * -------------------------------------------------------------------------- */

export const TASK_DISPATCH_FIELDS = [
  'expectedTps',
  'minimumTps',
  'intelligenceMin',
  'intelligenceMax',
  'maxOutputUsdPerMillion',
  'excludeModelIds',
  'excludeProfileIds',
  'excludeClientIds',
  'excludeProviderIds',
  'requiredCapabilities',
  'preferredRuntime',
] as const

export type TaskDispatchField = (typeof TASK_DISPATCH_FIELDS)[number]

export type TaskDispatchRequirements = Partial<CatalogTaskDispatchRequirements>

const DISPATCH_FIELD_ALIASES: Record<TaskDispatchField, readonly string[]> = {
  expectedTps: ['expectedTps', 'expected_tps'],
  minimumTps: ['minimumTps', 'minimum_tps'],
  intelligenceMin: ['intelligenceMin', 'intelligence_min'],
  intelligenceMax: ['intelligenceMax', 'intelligence_max'],
  maxOutputUsdPerMillion: ['maxOutputUsdPerMillion', 'max_output_usd_per_million'],
  excludeModelIds: ['excludeModelIds', 'exclude_model_ids'],
  excludeProfileIds: ['excludeProfileIds', 'exclude_profile_ids'],
  excludeClientIds: ['excludeClientIds', 'exclude_client_ids'],
  excludeProviderIds: ['excludeProviderIds', 'exclude_provider_ids'],
  requiredCapabilities: ['requiredCapabilities', 'required_capabilities'],
  preferredRuntime: ['preferredRuntime', 'preferred_runtime'],
}

const POSITIVE_NUMBER_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'expectedTps',
  'minimumTps',
  'maxOutputUsdPerMillion',
])

const INTELLIGENCE_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'intelligenceMin',
  'intelligenceMax',
])

const STRING_LIST_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'excludeModelIds',
  'excludeProfileIds',
  'excludeClientIds',
  'excludeProviderIds',
  'requiredCapabilities',
])

const RUNTIME_OBJECT_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'preferredRuntime',
])

const INTELLIGENCE_TIERS: ReadonlySet<string> = new Set([
  'low',
  'mid',
  'high',
  'frontier',
  'premium',
])

/* -------------------------------------------------------------------------- *
 * Layer model
 * -------------------------------------------------------------------------- */

/**
 * Structural user explicit selection. `alias` names a registered alias to be
 * resolved by the daemon; `target` is an inline runtime target. This module
 * validates the shape but never resolves aliases or compatibility.
 */
export type TaskExplicitRuntime =
  | { kind: 'alias'; name: string }
  | { kind: 'target'; target: string }

export interface TaskSettingsLayer {
  selectionMode?: TaskSelectionMode
  /** Structural explicit reference, honored only in explicit mode. */
  explicitRuntime?: TaskExplicitRuntime
  dispatch?: Partial<TaskDispatchRequirements>
  /** Total execution timeout in milliseconds. */
  timeoutMs?: number
  /**
   * Optional user-global-only ceiling on the automatic reference price in USD
   * per million output tokens. Accepts finite values >= 0 (zero is an explicit
   * ceiling); it is independent from `dispatch.maxOutputUsdPerMillion` and,
   * during effective resolution, is sourced exclusively from the normalized
   * user-global layer.
   */
  maxAutoOutputUsdPerMillion?: number
}

/** Five named layers in merge precedence order. All are optional. */
export interface TaskSettingsLayersInput {
  system?: TaskSettingsLayer
  builtin?: TaskSettingsLayer
  userGlobal?: TaskSettingsLayer
  userTask?: TaskSettingsLayer
  invocation?: TaskSettingsLayer
}

export interface EffectiveTaskSettingsSources {
  selectionMode?: TaskSettingsSourceTag
  explicitRuntime?: TaskSettingsSourceTag
  timeoutMs?: TaskSettingsSourceTag
  maxAutoOutputUsdPerMillion?: TaskSettingsSourceTag
  dispatch?: Partial<Record<TaskDispatchField, TaskSettingsSourceTag>>
}

export interface EffectiveTaskSettings {
  mode: TaskSelectionMode
  explicitRuntime: TaskExplicitRuntime | undefined
  timeoutMs: number
  dispatch: TaskDispatchRequirements
  /** User-global auto reference-price ceiling; undefined when never set. */
  maxAutoOutputUsdPerMillion: number | undefined
  /** Winning source per field; dispatch sources are per dispatch field. */
  sources: EffectiveTaskSettingsSources
}

export interface TaskDefaultsLike {
  /** TaskConfig-declared defaults. Task definitions never pin a runtime:
   *  only timeout and dispatch are carried into the builtin layer. */
  timeoutMs?: number
  dispatch?: Partial<TaskDispatchRequirements>
}

export class TaskSettingsValidationError extends Error {
  override readonly name = 'TaskSettingsValidationError'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/* -------------------------------------------------------------------------- *
 * Normalization / validation of config layers
 * -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(scope: string, message: string): never {
  throw new TaskSettingsValidationError(`Invalid task settings${scope}: ${message}`)
}

/** Resolves the first present alias value. `null` is treated as an explicit
 *  unset (the field is deleted from that layer). */
function resolveAliased(
  raw: Record<string, unknown>,
  aliases: readonly string[],
): { value: unknown; key: string | undefined } {
  for (const alias of aliases) {
    const value = raw[alias]
    if (value !== undefined && value !== null) {
      return { value, key: alias }
    }
  }
  return { value: undefined, key: undefined }
}

function assertSafeIntegerTimeout(value: unknown, scope: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(scope, `timeoutMs must be a positive safe integer, got ${String(value)}`)
  }
  return value
}

function assertFiniteNonNegativeNumber(value: unknown, scope: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(scope, `maxAutoOutputUsdPerMillion must be a finite number >= 0, got ${String(value)}`)
  }
  return value
}

const EXPLICIT_RUNTIME_KEYS = {
  alias: ['kind', 'name'],
  target: ['kind', 'target'],
} as const

/**
 * Validates one explicit runtime reference. The reference must be exactly
 * `{ kind: 'alias', name }` or `{ kind: 'target', target }` with a non-empty
 * trimmed value; extra fields and mixed alias/target fields are rejected.
 */
function normalizeExplicitRuntime(raw: unknown, scope: string): TaskExplicitRuntime {
  if (!isPlainObject(raw)) {
    fail(scope, 'explicitRuntime must be an object reference')
  }
  const record = raw as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'alias' && kind !== 'target') {
    fail(scope, `explicitRuntime.kind must be "alias" or "target", got ${String(kind)}`)
  }
  const allowed: readonly string[] =
    kind === 'alias' ? EXPLICIT_RUNTIME_KEYS.alias : EXPLICIT_RUNTIME_KEYS.target
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(scope, `explicitRuntime ${kind} reference does not accept field "${key}"`)
    }
  }
  if (kind === 'alias') {
    const name = record.name
    if (typeof name !== 'string' || name.trim() === '') {
      fail(scope, 'explicitRuntime alias requires a non-empty trimmed name')
    }
    return { kind: 'alias', name: name.trim() }
  }
  const target = record.target
  if (typeof target !== 'string' || target.trim() === '') {
    fail(scope, 'explicitRuntime target requires a non-empty trimmed target')
  }
  return { kind: 'target', target: target.trim() }
}

function normalizeDispatch(raw: unknown, scope: string): Partial<TaskDispatchRequirements> {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) fail(scope, 'dispatch must be an object')

  const record = raw as Record<string, unknown>
  const out: Partial<TaskDispatchRequirements> = {}
  let intelligenceMin: IntelligenceTier | undefined
  let intelligenceMax: IntelligenceTier | undefined

  for (const field of TASK_DISPATCH_FIELDS) {
    const { value } = resolveAliased(record, DISPATCH_FIELD_ALIASES[field])
    if (value === undefined) continue

    if (POSITIVE_NUMBER_FIELDS.has(field)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        fail(scope, `dispatch.${field} must be a positive number`)
      }
      ;(out as Record<string, unknown>)[field] = value
      continue
    }

    if (INTELLIGENCE_FIELDS.has(field)) {
      if (typeof value !== 'string' || !INTELLIGENCE_TIERS.has(value)) {
        fail(scope, `dispatch.${field} must be low, mid, high, frontier, or premium`)
      }
      ;(out as Record<string, unknown>)[field] = value as IntelligenceTier
      if (field === 'intelligenceMin') intelligenceMin = value as IntelligenceTier
      if (field === 'intelligenceMax') intelligenceMax = value as IntelligenceTier
      continue
    }

    if (STRING_LIST_FIELDS.has(field)) {
      if (!Array.isArray(value)) fail(scope, `dispatch.${field} must be an array of strings`)
      const list: string[] = []
      for (const item of value) {
        if (typeof item !== 'string' || item.trim() === '') {
          fail(scope, `dispatch.${field} must contain only non-empty strings`)
        }
        list.push(item.trim())
      }
      if (field === 'requiredCapabilities' && list.some((item) => item !== 'text' && item !== 'image')) {
        fail(scope, 'dispatch.requiredCapabilities accepts only text or image')
      }
      ;(out as Record<string, unknown>)[field] = list
      continue
    }

    if (RUNTIME_OBJECT_FIELDS.has(field)) {
      if (!isPlainObject(value)) fail(scope, `dispatch.${field} must be an object`)
      const runtime = value as Record<string, unknown>
      const keys = ['client', 'provider', 'model'] as const
      if (keys.some((key) => typeof runtime[key] !== 'string' || !(runtime[key] as string).trim())) {
        fail(scope, `dispatch.${field} must contain non-empty client, provider, and model strings`)
      }
      out.preferredRuntime = {
        client: (runtime.client as string).trim(),
        provider: (runtime.provider as string).trim(),
        model: (runtime.model as string).trim(),
      }
    }
  }

  if (
    intelligenceMin !== undefined &&
    intelligenceMax !== undefined &&
    INTELLIGENCE_ORDER[intelligenceMin] > INTELLIGENCE_ORDER[intelligenceMax]
  ) {
    fail(scope, 'dispatch.intelligenceMin cannot exceed dispatch.intelligenceMax')
  }
  return out
}

const LAYER_FIELD_ALIASES = {
  selectionMode: ['selectionMode', 'selection_mode'],
  explicitRuntime: ['explicitRuntime', 'explicit_runtime'],
  timeoutMs: ['timeoutMs', 'timeout_ms'],
  maxAutoOutputUsdPerMillion: ['maxAutoOutputUsdPerMillion', 'max_auto_output_usd_per_million'],
  dispatch: ['dispatch'],
} as const

/**
 * Validates and normalizes one persisted/config layer. Unknown keys are
 * tolerated and dropped (so legacy `agentRuntime`/`agent_runtime` pins are
 * ignored, never honored); `null` values behave as unset fields. Returns a new
 * canonical layer; the input is never mutated.
 */
export function normalizeTaskSettingsLayer(
  raw: unknown,
  options?: { scope?: string },
): TaskSettingsLayer {
  const scope = options?.scope === undefined ? '' : ` (${options.scope})`
  const layer: TaskSettingsLayer = {}
  if (raw === undefined || raw === null) return layer
  if (!isPlainObject(raw)) fail(scope, 'a settings layer must be an object')

  const record = raw as Record<string, unknown>

  const mode = resolveAliased(record, LAYER_FIELD_ALIASES.selectionMode)
  if (mode.value !== undefined) {
    if (mode.value !== 'automatic' && mode.value !== 'explicit') {
      fail(scope, `selectionMode must be "automatic" or "explicit", got ${String(mode.value)}`)
    }
    layer.selectionMode = mode.value
  }

  const explicitRuntime = resolveAliased(record, LAYER_FIELD_ALIASES.explicitRuntime)
  if (explicitRuntime.value !== undefined) {
    layer.explicitRuntime = normalizeExplicitRuntime(explicitRuntime.value, scope)
  }

  const timeout = resolveAliased(record, LAYER_FIELD_ALIASES.timeoutMs)
  if (timeout.value !== undefined) {
    layer.timeoutMs = assertSafeIntegerTimeout(timeout.value, scope)
  }

  const maxAutoOutput = resolveAliased(record, LAYER_FIELD_ALIASES.maxAutoOutputUsdPerMillion)
  if (maxAutoOutput.value !== undefined) {
    layer.maxAutoOutputUsdPerMillion = assertFiniteNonNegativeNumber(maxAutoOutput.value, scope)
  }

  const dispatch = resolveAliased(record, LAYER_FIELD_ALIASES.dispatch)
  if (dispatch.value !== undefined) {
    const normalizedDispatch = normalizeDispatch(dispatch.value, scope)
    if (Object.keys(normalizedDispatch).length > 0) {
      layer.dispatch = normalizedDispatch
    }
  }

  return layer
}

/* -------------------------------------------------------------------------- *
 * TaskConfig defaults -> builtin layer
 * -------------------------------------------------------------------------- */

/**
 * Converts TaskConfig defaults into the builtin layer. Every Task defaults to
 * `automatic` selection: Task definitions never pin a runtime, and explicit
 * user selection belongs to user settings layers. Only timeout and dispatch
 * defaults are carried over.
 */
export function taskDefaultsToSettingsLayer(taskDefaults: TaskDefaultsLike): TaskSettingsLayer {
  const layer: TaskSettingsLayer = { selectionMode: 'automatic' }
  if (taskDefaults.timeoutMs !== undefined) {
    layer.timeoutMs = taskDefaults.timeoutMs
  }
  if (taskDefaults.dispatch !== undefined) {
    layer.dispatch = { ...taskDefaults.dispatch }
  }
  return layer
}

/* -------------------------------------------------------------------------- *
 * Reading persisted tasks.settings.global / byTask
 * -------------------------------------------------------------------------- */

/** Structural view over persisted TasksConfigData.task settings sections. */
export interface TasksConfigSettingsInput {
  settings?: {
    global?: unknown
    byTask?: Record<string, unknown>
  } | null
}

/** Reads and normalizes the user-global layer from `tasks.settings.global`. */
export function readGlobalTaskSettings(
  tasks?: TasksConfigSettingsInput | null,
): TaskSettingsLayer | undefined {
  const raw = tasks?.settings?.global
  if (raw === undefined || raw === null) return undefined
  return normalizeTaskSettingsLayer(raw, { scope: 'tasks.settings.global' })
}

/** Reads and normalizes the user-task layer for a stable definition identity
 *  from `tasks.settings.byTask`. Returns undefined when no entry exists.
 *  `byTask` is the only per-task user selection source. */
export function readPerTaskSettings(
  tasks?: TasksConfigSettingsInput | null,
  identity?: TaskSettingsIdentity,
): TaskSettingsLayer | undefined {
  const byTask = tasks?.settings?.byTask
  if (identity === undefined || byTask === undefined || byTask === null) return undefined
  if (!Object.prototype.hasOwnProperty.call(byTask, identity)) return undefined
  return normalizeTaskSettingsLayer(byTask[identity], {
    scope: `tasks.settings.byTask[${identity}]`,
  })
}

/* -------------------------------------------------------------------------- *
 * Effective-settings resolution
 * -------------------------------------------------------------------------- */

interface NormalizedLayerEntry {
  tag: TaskSettingsSourceTag
  layer: TaskSettingsLayer
}

const LAYER_SOURCE_ENTRIES: readonly {
  tag: TaskSettingsSourceTag
  key: keyof TaskSettingsLayersInput
}[] = [
  { tag: 'system_global', key: 'system' },
  { tag: 'builtin_task', key: 'builtin' },
  { tag: 'user_global', key: 'userGlobal' },
  { tag: 'user_task', key: 'userTask' },
  { tag: 'invocation', key: 'invocation' },
]

function rightmostDefined<T>(
  entries: ReadonlyArray<NormalizedLayerEntry>,
  pick: (layer: TaskSettingsLayer) => T | undefined,
): { value: T | undefined; source: TaskSettingsSourceTag | undefined } {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const value = pick(entries[i].layer)
    if (value !== undefined) {
      return { value, source: entries[i].tag }
    }
  }
  return { value: undefined, source: undefined }
}

function assertExplicitReference(
  explicitRuntime: TaskExplicitRuntime | undefined,
  scope: string,
): void {
  if (explicitRuntime === undefined) {
    fail(scope, 'explicit mode requires an explicit runtime reference (alias or target)')
  }
}

function assertEffectiveIntelligenceOrder(dispatch: TaskDispatchRequirements): void {
  const min = dispatch.intelligenceMin
  const max = dispatch.intelligenceMax
  if (
    typeof min === 'string' &&
    typeof max === 'string' &&
    INTELLIGENCE_TIERS.has(min) &&
    INTELLIGENCE_TIERS.has(max) &&
    INTELLIGENCE_ORDER[min as IntelligenceTier] > INTELLIGENCE_ORDER[max as IntelligenceTier]
  ) {
    fail(
      '',
      'effective dispatch.intelligenceMin cannot exceed dispatch.intelligenceMax',
    )
  }
}

/**
 * Resolves the effective task settings by merging the five layers field by
 * field in exact precedence order (system defaults -> builtin Task defaults ->
 * user global -> user task -> invocation); the rightmost defined value wins.
 * Inputs are normalized but never mutated.
 *
 * System defaults: mode `automatic`, total execution timeout 15 minutes.
 * Automatic mode ignores any inherited/stale explicit reference; explicit
 * mode requires one effective structural reference. References are never
 * resolved or compatibility-checked here.
 */
export function resolveEffectiveTaskSettings(
  layers: TaskSettingsLayersInput,
): EffectiveTaskSettings {
  const entries: NormalizedLayerEntry[] = LAYER_SOURCE_ENTRIES.map(({ tag, key }) => ({
    tag,
    layer: normalizeTaskSettingsLayer(layers[key], { scope: `layer:${tag}` }),
  }))

  const modeLeaf = rightmostDefined(entries, (layer) => layer.selectionMode)
  const mode = modeLeaf.value ?? SYSTEM_DEFAULT_MODE
  const modeSource = modeLeaf.source ?? 'system_global'

  const explicitRuntimeLeaf = rightmostDefined(entries, (layer) => layer.explicitRuntime)

  let effectiveExplicitRuntime: TaskExplicitRuntime | undefined
  let explicitRuntimeSource: TaskSettingsSourceTag | undefined
  if (mode === 'explicit') {
    assertExplicitReference(explicitRuntimeLeaf.value, '')
    effectiveExplicitRuntime = explicitRuntimeLeaf.value
    explicitRuntimeSource = explicitRuntimeLeaf.source
  }
  // automatic mode deliberately ignores any inherited explicit reference.

  const timeoutLeaf = rightmostDefined(entries, (layer) => layer.timeoutMs)
  const timeoutMs = timeoutLeaf.value ?? SYSTEM_DEFAULT_TIMEOUT_MS
  const timeoutSource = timeoutLeaf.source ?? 'system_global'

  // The user-global auto reference-price ceiling is global-only by design: it
  // is sourced exclusively from the normalized userGlobal layer. The same
  // field on system, builtin, user-task, or invocation layers is structurally
  // ignored so a stale lower-layer pin can never leak into automatic
  // admission, and an undefined value exposes "no ceiling set".
  const userGlobalEntry = entries.find((entry) => entry.tag === 'user_global')
  const maxAutoOutputUsdPerMillion = userGlobalEntry?.layer.maxAutoOutputUsdPerMillion

  const dispatch: TaskDispatchRequirements = {}
  const dispatchSources: Partial<Record<TaskDispatchField, TaskSettingsSourceTag>> = {}
  for (const field of TASK_DISPATCH_FIELDS) {
    const leaf = rightmostDefined(entries, (layer) => layer.dispatch?.[field])
    if (leaf.value !== undefined && leaf.source !== undefined) {
      ;(dispatch as Record<string, unknown>)[field] = leaf.value
      dispatchSources[field] = leaf.source
    }
  }
  assertEffectiveIntelligenceOrder(dispatch)

  const sources: EffectiveTaskSettingsSources = {
    selectionMode: modeSource,
    timeoutMs: timeoutSource,
  }
  if (explicitRuntimeSource !== undefined) sources.explicitRuntime = explicitRuntimeSource
  if (maxAutoOutputUsdPerMillion !== undefined) sources.maxAutoOutputUsdPerMillion = 'user_global'
  sources.dispatch = dispatchSources

  return {
    mode,
    explicitRuntime: effectiveExplicitRuntime,
    timeoutMs,
    dispatch,
    maxAutoOutputUsdPerMillion,
    sources,
  }
}
