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
 * Runtime selection is mode-driven:
 *   - `automatic` ignores any runtime id found on lower/inherited layers
 *     (a stale pin is dropped, never validated).
 *   - `explicit` requires an effective, existing, non-policy runtime id and
 *     rejects policy/profile aliases.
 *
 * This module is dependency-light by design: it only consumes plain layer
 * shapes plus persisted `tasks.settings.global`/`tasks.settings.byTask` and
 * the legacy `tasks.agentRuntime` data. It never mutates configuration input.
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

/** Upper bound (in characters) for the additional-instructions override. */
export const ADDITIONAL_INSTRUCTIONS_MAX_LENGTH = 4000

export type TaskDefinitionKind = 'builtin' | 'project'

/** Stable key used for `tasks.settings.byTask` entries and legacy lookups. */
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

export interface TaskSettingsLayer {
  selectionMode?: TaskSelectionMode
  /** Exact runtime id, or a policy/profile alias when describing Task defaults.
   *  The effective runtime is honored only in explicit mode. */
  agentRuntime?: string
  dispatch?: Partial<TaskDispatchRequirements>
  /** Total execution timeout in milliseconds. */
  timeoutMs?: number
  /** Bounded plain-text instruction override (never replaces TaskConfig
   *  instructions or the builtin dynamic prompt). */
  additionalInstructions?: string
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
  agentRuntime?: TaskSettingsSourceTag
  timeoutMs?: TaskSettingsSourceTag
  additionalInstructions?: TaskSettingsSourceTag
  dispatch?: Partial<Record<TaskDispatchField, TaskSettingsSourceTag>>
}

export interface EffectiveTaskSettings {
  mode: TaskSelectionMode
  runtime: string | undefined
  timeoutMs: number
  additionalInstructions: string | undefined
  dispatch: TaskDispatchRequirements
  /** Winning source per field; dispatch sources are per dispatch field. */
  sources: EffectiveTaskSettingsSources
}

/** Runtime classification catalog. When `exactRuntimeIds` is provided it is
 *  the authoritative set of existing exact runtimes; `policyRuntimeIds` are
 *  aliases that are never valid in explicit mode. */
export interface TaskRuntimeCatalog {
  exactRuntimeIds?: readonly string[]
  policyRuntimeIds?: readonly string[]
}

export interface TaskDefaultsLike {
  /** TaskConfig-declared runtime selector (policy/profile or exact id). */
  runtime?: string
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
  agentRuntime: ['agentRuntime', 'agent_runtime'],
  timeoutMs: ['timeoutMs', 'timeout_ms'],
  additionalInstructions: ['additionalInstructions', 'additional_instructions'],
  dispatch: ['dispatch'],
} as const

/**
 * Validates and normalizes one persisted/config layer. Unknown keys are
 * tolerated and dropped; `null` values behave as unset fields. Returns a new
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

  const runtime = resolveAliased(record, LAYER_FIELD_ALIASES.agentRuntime)
  if (runtime.value !== undefined) {
    if (typeof runtime.value !== 'string') fail(scope, 'agentRuntime must be a string')
    const id = runtime.value.trim()
    if (id !== '') layer.agentRuntime = id
  }

  const timeout = resolveAliased(record, LAYER_FIELD_ALIASES.timeoutMs)
  if (timeout.value !== undefined) {
    layer.timeoutMs = assertSafeIntegerTimeout(timeout.value, scope)
  }

  const instruction = resolveAliased(record, LAYER_FIELD_ALIASES.additionalInstructions)
  if (instruction.value !== undefined) {
    if (typeof instruction.value !== 'string') {
      fail(scope, 'additionalInstructions must be a string')
    }
    if (instruction.value.length > ADDITIONAL_INSTRUCTIONS_MAX_LENGTH) {
      fail(
        scope,
        `additionalInstructions must be at most ${ADDITIONAL_INSTRUCTIONS_MAX_LENGTH} characters`,
      )
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(instruction.value)) {
      fail(scope, 'additionalInstructions must be plain text without control characters')
    }
    layer.additionalInstructions = instruction.value
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
 * Converts project/builtin TaskConfig-style defaults into the builtin layer:
 * a policy/profile runtime implies `automatic`, a recognized exact runtime
 * implies `explicit`; dispatch and timeout are carried over as defaults.
 */
export function taskDefaultsToSettingsLayer(
  taskDefaults: TaskDefaultsLike,
  catalog?: TaskRuntimeCatalog,
): TaskSettingsLayer {
  const layer: TaskSettingsLayer = {}
  const runtime = taskDefaults.runtime?.trim() || undefined

  if (
    runtime !== undefined &&
    (catalog?.exactRuntimeIds?.includes(runtime) ?? false)
  ) {
    layer.selectionMode = 'explicit'
    layer.agentRuntime = runtime
  } else {
    layer.selectionMode = 'automatic'
  }

  const merged: Record<string, unknown> = { ...layer }
  if (taskDefaults.timeoutMs !== undefined) {
    merged.timeoutMs = taskDefaults.timeoutMs
  }
  if (taskDefaults.dispatch !== undefined) {
    merged.dispatch = { ...taskDefaults.dispatch }
  }
  return normalizeTaskSettingsLayer(merged, { scope: 'taskDefaults' })
}

/* -------------------------------------------------------------------------- *
 * Reading persisted tasks.settings.global / byTask + legacy agentRuntime
 * -------------------------------------------------------------------------- */

/** Structural view over persisted TasksConfigData.task settings sections. */
export interface TasksConfigSettingsInput {
  settings?: {
    global?: unknown
    byTask?: Record<string, unknown>
  } | null
  agentRuntime?: Record<string, unknown> | null
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
 *  from `tasks.settings.byTask`. Returns undefined when no entry exists. */
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

/** Legacy `tasks.agentRuntime` bare builtin pin; undefined when absent. */
export function readLegacyRuntimePin(
  tasks?: TasksConfigSettingsInput | null,
  taskName?: string,
): string | undefined {
  const overrides = tasks?.agentRuntime
  if (taskName === undefined || overrides === undefined || overrides === null) {
    return undefined
  }
  const raw = overrides[taskName]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new TaskSettingsValidationError(
      `tasks.agentRuntime.${taskName} must be a runtime id string`,
    )
  }
  const id = raw.trim()
  return id === '' ? undefined : id
}

export interface BuiltinSettingsSelection {
  identity: TaskSettingsIdentity
  source: 'task' | 'legacy' | 'none'
  layer?: TaskSettingsLayer
}

/**
 * Resolves a builtin task's user selection: the new per-task layer wins when a
 * `settings.byTask` entry exists; otherwise a legacy `tasks.agentRuntime` pin
 * is used as an explicit fallback (bare builtin name only). Returns `none`
 * when neither exists. Never applies legacy pins to project tasks.
 */
export function readBuiltinSettingsSelection(
  tasks?: TasksConfigSettingsInput | null,
  taskName?: string,
): BuiltinSettingsSelection {
  if (taskName === undefined) return { identity: '', source: 'none' }
  const identity = taskSettingsIdentity({ kind: 'builtin', name: taskName })

  const byTask = tasks?.settings?.byTask
  if (
    byTask !== undefined &&
    byTask !== null &&
    Object.prototype.hasOwnProperty.call(byTask, identity)
  ) {
    return {
      identity,
      source: 'task',
      layer: normalizeTaskSettingsLayer(byTask[identity], {
        scope: `tasks.settings.byTask[${identity}]`,
      }),
    }
  }

  const legacyPin = readLegacyRuntimePin(tasks, taskName)
  if (legacyPin !== undefined) {
    return {
      identity,
      source: 'legacy',
      layer: { selectionMode: 'explicit', agentRuntime: legacyPin },
    }
  }

  return { identity, source: 'none' }
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

function assertExplicitRuntime(
  runtime: string | undefined,
  catalog: TaskRuntimeCatalog | undefined,
  scope: string,
): void {
  if (runtime === undefined) {
    fail(scope, 'explicit mode requires an exact runtime id')
  }
  if (catalog?.policyRuntimeIds?.includes(runtime) ?? false) {
    fail(scope, `runtime ${runtime} is a policy alias and cannot be used in explicit mode`)
  }
  if (
    catalog?.exactRuntimeIds !== undefined &&
    !catalog.exactRuntimeIds.includes(runtime)
  ) {
    fail(scope, `runtime ${runtime} is not a known exact runtime id`)
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
 * Automatic mode ignores any inherited/stale runtime pin; explicit mode
 * requires an effective existing non-policy runtime id.
 */
export function resolveEffectiveTaskSettings(
  layers: TaskSettingsLayersInput,
  catalog?: TaskRuntimeCatalog,
): EffectiveTaskSettings {
  const entries: NormalizedLayerEntry[] = LAYER_SOURCE_ENTRIES.map(({ tag, key }) => ({
    tag,
    layer: normalizeTaskSettingsLayer(layers[key], { scope: `layer:${tag}` }),
  }))

  const modeLeaf = rightmostDefined(entries, (layer) => layer.selectionMode)
  const mode = modeLeaf.value ?? SYSTEM_DEFAULT_MODE
  const modeSource = modeLeaf.source ?? 'system_global'

  const runtimeLeaf = rightmostDefined(entries, (layer) => layer.agentRuntime)

  let runtime: string | undefined
  let runtimeSource: TaskSettingsSourceTag | undefined
  if (mode === 'explicit') {
    assertExplicitRuntime(runtimeLeaf.value, catalog, '')
    runtime = runtimeLeaf.value
    runtimeSource = runtimeLeaf.source
  }
  // automatic mode deliberately ignores any inherited runtime pin.

  const timeoutLeaf = rightmostDefined(entries, (layer) => layer.timeoutMs)
  const timeoutMs = timeoutLeaf.value ?? SYSTEM_DEFAULT_TIMEOUT_MS
  const timeoutSource = timeoutLeaf.source ?? 'system_global'

  const instructionLeaf = rightmostDefined(entries, (layer) => layer.additionalInstructions)

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
  if (runtimeSource !== undefined) sources.agentRuntime = runtimeSource
  if (instructionLeaf.value !== undefined && instructionLeaf.source !== undefined) {
    sources.additionalInstructions = instructionLeaf.source
  }
  sources.dispatch = dispatchSources

  return {
    mode,
    runtime,
    timeoutMs,
    additionalInstructions: instructionLeaf.value,
    dispatch,
    sources,
  }
}
