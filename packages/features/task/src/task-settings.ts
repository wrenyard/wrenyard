import { INTELLIGENCE_ORDER, type IntelligenceTier, normalizeIntelligenceTier, normalizeReasoningEffort } from '@wrenyard/providers/catalog';
import { type TaskDispatchRequirements as AutoRoutingTaskDispatchRequirements, validateScoreWeights } from '@wrenyard/auto-routing';

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
 * Runtime selection is automatic: every Task resolves its runtime through the
 * automatic routing path. This module never resolves references nor checks
 * compatibility against a catalog; it only carries the structural dispatch
 * fields forward for the daemon to honor.
 *
 * Task definitions never pin a runtime; every Task defaults to automatic
 * selection. The only per-task user selection source is the persisted
 * `tasks.settings.byTask` map (plus the user-global and invocation layers).
 * This module is dependency-light by design: it only consumes plain layer
 * shapes plus persisted `tasks.settings.global`/`tasks.settings.byTask`. It
 * never mutates configuration input.
 */

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

/** System default global task run time limit: 60 minutes. */
export const SYSTEM_DEFAULT_RUN_TIME_LIMIT_MINUTES = 60
export const MIN_RUN_TIME_LIMIT_MINUTES = 5
export const MAX_RUN_TIME_LIMIT_MINUTES = 600
export const SYSTEM_DEFAULT_HEALTH_ERROR_RATE_THRESHOLD_PERCENT = 50
export const MIN_HEALTH_ERROR_RATE_THRESHOLD_PERCENT = 1
export const MAX_HEALTH_ERROR_RATE_THRESHOLD_PERCENT = 100

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
  'intelligenceExpected',
  'maxOutputUsdPerMillion',
  'excludeModelIds',
  'excludeProfileIds',
  'excludeClientIds',
  'excludeProviderIds',
  'requiredCapabilities',
  'requiresWebSearch',
  'fast',
  'expectedReasoningEffort',
] as const

export type TaskDispatchField = (typeof TASK_DISPATCH_FIELDS)[number]

export type TaskDispatchRequirements = Partial<AutoRoutingTaskDispatchRequirements>

const DISPATCH_FIELD_ALIASES: Record<TaskDispatchField, readonly string[]> = {
  expectedTps: ['expectedTps', 'expected_tps'],
  minimumTps: ['minimumTps', 'minimum_tps'],
  intelligenceMin: ['intelligenceMin', 'intelligence_min'],
  intelligenceExpected: ['intelligenceExpected', 'intelligence_expected'],
  maxOutputUsdPerMillion: ['maxOutputUsdPerMillion', 'max_output_usd_per_million'],
  excludeModelIds: ['excludeModelIds', 'exclude_model_ids'],
  excludeProfileIds: ['excludeProfileIds', 'exclude_profile_ids'],
  excludeClientIds: ['excludeClientIds', 'exclude_client_ids'],
  excludeProviderIds: ['excludeProviderIds', 'exclude_provider_ids'],
  requiredCapabilities: ['requiredCapabilities', 'required_capabilities'],
  requiresWebSearch: ['requiresWebSearch', 'requires_web_search'],
  fast: ['fast'],
  expectedReasoningEffort: ['expectedReasoningEffort', 'expected_reasoning_effort'],
}

const POSITIVE_NUMBER_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'expectedTps',
  'minimumTps',
  'maxOutputUsdPerMillion',
])

const INTELLIGENCE_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'intelligenceMin',
  'intelligenceExpected',
])

const STRING_LIST_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'excludeModelIds',
  'excludeProfileIds',
  'excludeClientIds',
  'excludeProviderIds',
  'requiredCapabilities',
])

const BOOLEAN_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'requiresWebSearch',
  'fast',
])

const REASONING_EFFORT_FIELDS: ReadonlySet<TaskDispatchField> = new Set(['expectedReasoningEffort'])

/**
 * Dispatch fields the user-global layer no longer owns: the global model and
 * provider exclusions live at the config root `routing.exclude`, so a legacy
 * `tasks.settings.global.dispatch` copy is ignored rather than honored.
 * Per-task layers keep accepting exactly the same field names.
 */
const GLOBAL_IGNORED_DISPATCH_FIELDS: ReadonlySet<TaskDispatchField> = new Set([
  'excludeModelIds',
  'excludeProviderIds',
])

/* -------------------------------------------------------------------------- *
 * Layer model
 * -------------------------------------------------------------------------- */

export interface TaskSettingsLayer {
  dispatch?: Partial<TaskDispatchRequirements>
  /** Global-scope task run time limit in minutes. */
  runTimeLimitMinutes?: number
  /**
   * Optional user-global-only scoring weights for automatic routing, mapped to
   * the catalog scorer keys P/S/Q/I. All four keys are required finite numbers
   * in [0, 1] summing to 1 (validated against the catalog SSOT). `null` is an
   * explicit unset; during effective resolution the field is sourced
   * exclusively from the normalized user-global layer.
   */
  routingWeights?: TaskRoutingWeights
  /**
   * Optional user-global-only health-avoidance error-rate threshold (percent,
   * 1–100). Absent values inherit the system default during effective resolution.
   */
  healthErrorRateThreshold?: number
  /**
   * Optional user-global-only declaration of execution tools the environment
   * provides beyond the built-in operation components — for example a named MCP
   * server. Accepts an array of unique non-empty ids and defaults to absent. It
   * is read exclusively from `tasks.settings.global`; the per-task `byTask`
   * layer drops it like an unknown key.
   */
  environmentTools?: readonly string[]
  /**
   * Neutral model/provider exclusions, read exclusively from the config root
   * `routing.exclude`. They are also projected into `dispatch` so downstream
   * resolution keeps consuming `excludeModelIds` / `excludeProviderIds`.
   */
  exclude?: RoutingExcludeSettings
}

/** Routing score weights keyed for config, mapped to scorer P/S/Q/I. */
export interface TaskRoutingWeights {
  price: number
  speed: number
  quota: number
  intelligence: number
}

/**
 * Neutral model/provider exclusions. Their only persisted home is the config
 * root `routing.exclude`; a settings layer carries them as a read projection
 * alongside `dispatch`. Per-task exclusions keep their
 * `dispatch.excludeModelIds` / `dispatch.excludeProviderIds` names. Per-role
 * entries use the same formats, keyed by an opaque role name.
 */
export interface RoutingExcludeSettings {
  /** Bare model ids or unified `provider/model` ids no automatic route may use. */
  models?: readonly string[]
  providers?: readonly string[]
  /**
   * Exclusions applied only when the selector runs for a given role, keyed by
   * an opaque role name. They are additive to the global lists.
   */
  roles?: Readonly<Record<string, RoutingRoleExcludeSettings>>
}

/**
 * Per-role exclusion entry, with the same formats as the global lists. Role
 * names are opaque operator strings; there is no built-in role list.
 */
export interface RoutingRoleExcludeSettings {
  /** Bare model ids or unified `provider/model` ids this role may not use. */
  models?: readonly string[]
  providers?: readonly string[]
}

/** Root-level routing section of a foreman config document. */
export interface RoutingConfigSection {
  exclude?: RoutingExcludeSettings
}

/** Structural view over a config document root carrying `routing`. */
export interface RoutingConfigRootInput {
  routing?: unknown
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
  runTimeLimitMinutes?: TaskSettingsSourceTag
  routingWeights?: TaskSettingsSourceTag
  healthErrorRateThreshold?: TaskSettingsSourceTag
  dispatch?: Partial<Record<TaskDispatchField, TaskSettingsSourceTag>>
}

export interface EffectiveTaskSettings {
  runTimeLimitMinutes: number
  dispatch: TaskDispatchRequirements
  /** User-global routing score weights; undefined falls back to scorer defaults. */
  routingWeights?: TaskRoutingWeights
  healthErrorRateThreshold: number
  /** Winning source per field; dispatch sources are per dispatch field. */
  sources: EffectiveTaskSettingsSources
}

export interface TaskDefaultsLike {
  /** TaskConfig-declared defaults. Task definitions never pin a runtime:
   *  only dispatch is carried into the builtin layer. */
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

function assertSafeIntegerRunTimeLimitMinutes(value: unknown, scope: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_RUN_TIME_LIMIT_MINUTES ||
    value > MAX_RUN_TIME_LIMIT_MINUTES
  ) {
    fail(
      scope,
      `runTimeLimitMinutes must be a safe integer between ${MIN_RUN_TIME_LIMIT_MINUTES} and ${MAX_RUN_TIME_LIMIT_MINUTES}, got ${String(value)}`,
    )
  }
  return value
}

/** True when a raw persisted/config record still carries a legacy per-task timeout field. */
export function rawLayerDeclaresLegacyTimeout(record: unknown): boolean {
  if (!isPlainObject(record)) return false
  return Object.prototype.hasOwnProperty.call(record, 'timeoutMs') ||
    Object.prototype.hasOwnProperty.call(record, 'timeout_ms')
}

/**
 * Validates one array-of-non-empty-strings field, returning the trimmed values.
 * Shared by the dispatch string-list fields and the global `environmentTools`
 * declaration so both reject non-arrays and blank entries identically.
 */
function normalizeNonEmptyStringList(value: unknown, scope: string, label: string): string[] {
  if (!Array.isArray(value)) fail(scope, `${label} must be an array of strings`)
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(scope, `${label} must contain only non-empty strings`)
    }
    list.push(item.trim())
  }
  return list
}

function normalizeDispatch(
  raw: unknown,
  scope: string,
  ignored?: ReadonlySet<TaskDispatchField>,
): Partial<TaskDispatchRequirements> {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) fail(scope, 'dispatch must be an object')

  const record = raw as Record<string, unknown>
  const out: Partial<TaskDispatchRequirements> = {}
  let intelligenceMin: IntelligenceTier | undefined
  let intelligenceExpected: IntelligenceTier | undefined

  for (const field of TASK_DISPATCH_FIELDS) {
    if (ignored?.has(field)) continue
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
      if (typeof value !== 'string') {
        fail(scope, `dispatch.${field} must be one of: low, mid, high, premium`)
      }
      const normalized = normalizeIntelligenceTier(value)
      if (normalized === undefined) {
        fail(scope, `dispatch.${field} must be one of: low, mid, high, premium`)
      }
      ;(out as Record<string, unknown>)[field] = normalized
      if (field === 'intelligenceMin') intelligenceMin = normalized
      if (field === 'intelligenceExpected') intelligenceExpected = normalized
      continue
    }

    if (STRING_LIST_FIELDS.has(field)) {
      const list = normalizeNonEmptyStringList(value, scope, `dispatch.${field}`)
      if (field === 'requiredCapabilities' && list.some((item) => item !== 'text' && item !== 'image')) {
        fail(scope, 'dispatch.requiredCapabilities accepts only text or image')
      }
      ;(out as Record<string, unknown>)[field] = list
      continue
    }

    if (BOOLEAN_FIELDS.has(field)) {
      if (typeof value !== 'boolean') {
        fail(scope, `dispatch.${field} must be a boolean`)
      }
      ;(out as Record<string, unknown>)[field] = value
      continue
    }

    if (REASONING_EFFORT_FIELDS.has(field)) {
      if (typeof value !== 'string') {
        fail(scope, `dispatch.${field} must be one of: none, low, medium, high, xhigh, max`)
      }
      const normalized = normalizeReasoningEffort(value)
      if (normalized === undefined) {
        fail(scope, `dispatch.${field} must be one of: none, low, medium, high, xhigh, max`)
      }
      ;(out as Record<string, unknown>)[field] = normalized
      continue
    }

  }

  // Validate the optional target against the available intelligence minimum.
  // The target must be at or above the minimum; absent target stays absent.
  if (
    intelligenceExpected !== undefined &&
    intelligenceMin !== undefined &&
    INTELLIGENCE_ORDER[intelligenceExpected] < INTELLIGENCE_ORDER[intelligenceMin]
  ) {
    fail(scope, 'dispatch.intelligenceExpected cannot be below dispatch.intelligenceMin')
  }
  return out
}

/**
 * Validates and canonicalizes one routing weight set against the catalog
 * scorer SSOT (keys price/speed/quota/intelligence map to P/S/Q/I). All four
 * keys are required, unknown keys are rejected, and every value must be a
 * finite number in [0, 1] with the four summing to 1. Invalid config throws;
 * it is never silently replaced by scorer defaults.
 */
export function assertHealthErrorRateThresholdPercent(value: unknown, scope: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(scope, 'healthErrorRateThreshold must be a finite number')
  }
  const rounded = Math.round(value)
  if (rounded < MIN_HEALTH_ERROR_RATE_THRESHOLD_PERCENT || rounded > MAX_HEALTH_ERROR_RATE_THRESHOLD_PERCENT) {
    fail(
      scope,
      `healthErrorRateThreshold must be an integer from ${MIN_HEALTH_ERROR_RATE_THRESHOLD_PERCENT} to ${MAX_HEALTH_ERROR_RATE_THRESHOLD_PERCENT}`,
    )
  }
  return rounded
}

export function normalizeRoutingWeights(raw: unknown, scope: string): TaskRoutingWeights {
  if (!isPlainObject(raw)) {
    fail(scope, 'routingWeights must be an object with keys price, speed, quota, intelligence')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'price' && key !== 'speed' && key !== 'quota' && key !== 'intelligence') {
      fail(scope, `routingWeights has unknown key ${key}`)
    }
  }
  const canonical: Record<string, number> = {}
  for (const key of ['price', 'speed', 'quota', 'intelligence'] as const) {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(scope, `routingWeights.${key} must be a finite number, got ${String(value)}`)
    }
    canonical[key] = value
  }
  try {
    validateScoreWeights({ P: canonical.price, S: canonical.speed, Q: canonical.quota, I: canonical.intelligence })
  } catch (error) {
    fail(scope, `invalid routingWeights: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    price: canonical.price,
    speed: canonical.speed,
    quota: canonical.quota,
    intelligence: canonical.intelligence,
  }
}

const LAYER_FIELD_ALIASES = {
  runTimeLimitMinutes: ['runTimeLimitMinutes', 'run_time_limit_minutes'],
  routingWeights: ['routingWeights', 'routing_weights'],
  healthErrorRateThreshold: ['healthErrorRateThreshold', 'health_error_rate_threshold'],
  environmentTools: ['environmentTools', 'environment_tools'],
  dispatch: ['dispatch'],
} as const

/**
 * Validates and normalizes one persisted/config layer. Unknown keys are
 * tolerated and dropped (so legacy `agentRuntime`/`agent_runtime` pins are
 * ignored, never honored); `null` values behave as unset fields. The
 * user-global-only keys (`routingWeights`, `environmentTools`) are only
 * accepted when `globalLayer` is set, so a
 * per-task `byTask` entry drops them like any unknown key. Returns a new
 * canonical layer; the input is never mutated.
 */
export function normalizeTaskSettingsLayer(
  raw: unknown,
  options?: { scope?: string; globalLayer?: boolean },
): TaskSettingsLayer {
  const scope = options?.scope === undefined ? '' : ` (${options.scope})`
  const layer: TaskSettingsLayer = {}
  if (raw === undefined || raw === null) return layer
  if (!isPlainObject(raw)) fail(scope, 'a settings layer must be an object')

  const record = raw as Record<string, unknown>

  // Legacy `selectionMode`/`selection_mode` and `explicitRuntime`/`explicit_runtime`
  // keys are unknown fields here: they are dropped like any other ignored key,
  // never migrated, rewritten, or honored.

  const runTimeLimit = resolveAliased(record, LAYER_FIELD_ALIASES.runTimeLimitMinutes)
  if (runTimeLimit.value !== undefined) {
    layer.runTimeLimitMinutes = assertSafeIntegerRunTimeLimitMinutes(runTimeLimit.value, scope)
  }

  const routingWeights = resolveAliased(record, LAYER_FIELD_ALIASES.routingWeights)
  if (routingWeights.value !== undefined) {
    layer.routingWeights = normalizeRoutingWeights(routingWeights.value, scope)
  }

  const healthErrorRateThreshold = resolveAliased(record, LAYER_FIELD_ALIASES.healthErrorRateThreshold)
  if (healthErrorRateThreshold.value !== undefined) {
    layer.healthErrorRateThreshold = assertHealthErrorRateThresholdPercent(healthErrorRateThreshold.value, scope)
  }

  // `environmentTools` is a user-global-only declaration: it is validated only
  // when normalizing the global layer and dropped from every other layer.
  if (options?.globalLayer === true) {
    const environmentTools = resolveAliased(record, LAYER_FIELD_ALIASES.environmentTools)
    if (environmentTools.value !== undefined) {
      const list = normalizeNonEmptyStringList(environmentTools.value, scope, 'environmentTools')
      if (new Set(list).size !== list.length) {
        fail(scope, 'environmentTools must not contain duplicate ids')
      }
      layer.environmentTools = list
    }
  }

  const dispatch = resolveAliased(record, LAYER_FIELD_ALIASES.dispatch)
  if (dispatch.value !== undefined) {
    // The user-global layer drops the model/provider exclusions: those are
    // sourced from the neutral root `routing.exclude` only.
    const normalizedDispatch = normalizeDispatch(
      dispatch.value,
      scope,
      options?.globalLayer === true ? GLOBAL_IGNORED_DISPATCH_FIELDS : undefined,
    )
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
 * Converts TaskConfig defaults into the builtin layer. Every Task resolves
 * automatically: Task definitions never pin a runtime. Only timeout and
 * dispatch defaults are carried over.
 */
export function taskDefaultsToSettingsLayer(taskDefaults: TaskDefaultsLike): TaskSettingsLayer {
  const layer: TaskSettingsLayer = {}
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

/**
 * Strict reader for the neutral global model/provider exclusions at the config
 * root `routing.exclude`. Only `models`, `providers` and `roles` are read;
 * unknown keys under `routing.exclude` and under each role entry fail. The
 * lists must be arrays of non-empty strings when present, and every role entry
 * must be an object whose own lists pass the same validation. A missing section
 * yields `undefined`; a malformed one fails instead of being silently dropped.
 */
export function readRoutingExclusions(
  root?: RoutingConfigRootInput | null,
  scope?: string,
): RoutingExcludeSettings | undefined {
  if (root === undefined || root === null) return undefined
  if (!isPlainObject(root)) fail(scopeOf('config', scope), 'config root must be an object')
  const routing = (root as Record<string, unknown>).routing
  if (routing === undefined || routing === null) return undefined
  if (!isPlainObject(routing)) fail(scopeOf('routing', scope), 'routing must be an object')
  const exclude = (routing as Record<string, unknown>).exclude
  if (exclude === undefined || exclude === null) return undefined
  if (!isPlainObject(exclude)) fail(scopeOf('routing.exclude', scope), 'routing.exclude must be an object')
  for (const key of Object.keys(exclude)) {
    if (key !== 'models' && key !== 'providers' && key !== 'roles') {
      fail(scopeOf('routing.exclude', scope), `routing.exclude has unknown key ${key}`)
    }
  }
  const listScope = ` (${scope ?? 'routing.exclude'})`
  const out: RoutingExcludeSettings = {}
  const models = (exclude as Record<string, unknown>).models
  if (models !== undefined && models !== null) {
    out.models = normalizeNonEmptyStringList(models, listScope, 'routing.exclude.models')
  }
  const providers = (exclude as Record<string, unknown>).providers
  if (providers !== undefined && providers !== null) {
    out.providers = normalizeNonEmptyStringList(providers, listScope, 'routing.exclude.providers')
  }
  const roles = (exclude as Record<string, unknown>).roles
  if (roles !== undefined && roles !== null) {
    if (!isPlainObject(roles)) {
      fail(scopeOf('routing.exclude.roles', scope), 'routing.exclude.roles must be an object')
    }
    const parsedRoles: Record<string, RoutingRoleExcludeSettings> = {}
    for (const [role, value] of Object.entries(roles)) {
      if (value === undefined || value === null) continue
      if (!isPlainObject(value)) {
        fail(listScope, `routing.exclude.roles.${role} must be an object`)
      }
      const roleRecord = value as Record<string, unknown>
      for (const key of Object.keys(roleRecord)) {
        if (key !== 'models' && key !== 'providers') {
          fail(scopeOf(`routing.exclude.roles.${role}`, scope), `routing.exclude.roles.${role} has unknown key ${key}`)
        }
      }
      const entry: RoutingRoleExcludeSettings = {}
      const roleModels = roleRecord.models
      if (roleModels !== undefined && roleModels !== null) {
        entry.models = normalizeNonEmptyStringList(roleModels, listScope, `routing.exclude.roles.${role}.models`)
      }
      const roleProviders = roleRecord.providers
      if (roleProviders !== undefined && roleProviders !== null) {
        entry.providers = normalizeNonEmptyStringList(roleProviders, listScope, `routing.exclude.roles.${role}.providers`)
      }
      parsedRoles[role] = entry
    }
    if (Object.keys(parsedRoles).length > 0) out.roles = parsedRoles
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function scopeOf(label: string, scope: string | undefined): string {
  return scope === undefined ? ` (${label})` : ` (${scope})`
}

/**
 * Reads and normalizes the user-global layer from `tasks.settings.global`,
 * sourcing the model/provider exclusions exclusively from the neutral config
 * root `routing.exclude`. Legacy global `dispatch` exclusion keys (camelCase or
 * snake_case) are ignored; the neutral exclusions are projected back into
 * `dispatch` so downstream resolution keeps consuming `excludeModelIds` /
 * `excludeProviderIds`. Layer precedence is unchanged.
 */
export function readGlobalTaskSettings(
  tasks?: TasksConfigSettingsInput | null,
  root?: RoutingConfigRootInput | null,
): TaskSettingsLayer | undefined {
  const raw = tasks?.settings?.global
  const layer = raw === undefined || raw === null
    ? undefined
    : normalizeTaskSettingsLayer(raw, { scope: 'tasks.settings.global', globalLayer: true })
  const exclusions = readRoutingExclusions(root)
  if (exclusions === undefined) return layer
  const merged: TaskSettingsLayer = layer ?? {}
  merged.exclude = exclusions
  const dispatch: Partial<TaskDispatchRequirements> = { ...merged.dispatch }
  if (exclusions.models !== undefined) dispatch.excludeModelIds = [...exclusions.models]
  if (exclusions.providers !== undefined) dispatch.excludeProviderIds = [...exclusions.providers]
  merged.dispatch = dispatch
  return merged
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

function assertEffectiveIntelligenceOrder(dispatch: TaskDispatchRequirements): void {
  // Compare the normalized tiers so a rejected `frontier` alias (already
  // dropped by the reader) never participates in the order check.
  const min =
    dispatch.intelligenceMin === undefined ? undefined : normalizeIntelligenceTier(dispatch.intelligenceMin)
  const expected =
    dispatch.intelligenceExpected === undefined ? undefined : normalizeIntelligenceTier(dispatch.intelligenceExpected)
  if (
    expected !== undefined &&
    min !== undefined &&
    INTELLIGENCE_ORDER[expected] < INTELLIGENCE_ORDER[min]
  ) {
    fail('', 'effective dispatch.intelligenceExpected cannot be below dispatch.intelligenceMin')
  }
}

/**
 * Resolves the effective task settings by merging the five layers field by
 * field in exact precedence order (system defaults -> builtin Task defaults ->
 * user global -> user task -> invocation); the rightmost defined value wins.
 * Inputs are normalized but never mutated.
 *
 * `requiredCapabilities` is the single documented exception to pure
 * rightmost-wins. A task definition's declared capabilities (the builtin Task
 * layer) form a *hard minimum*: no user layer — global, task, or invocation,
 * including an explicit empty array — may strip a capability the task itself
 * requires. The effective set is the union of the task-definition minimum
 * with the single normal rightmost winner (never every historical override),
 * deduplicated in stable text,image order. Other fields keep exact
 * precedence. Source provenance for `requiredCapabilities` is `builtin_task`
 * when the declaration alone contributes (no nonempty normal winner),
 * otherwise the highest contributing layer (the normal winner's source).
 *
 * System default: global task run time limit 60 minutes.
 */
export function resolveEffectiveTaskSettings(
  layers: TaskSettingsLayersInput,
): EffectiveTaskSettings {
  const entries: NormalizedLayerEntry[] = LAYER_SOURCE_ENTRIES.map(({ tag, key }) => ({
    tag,
    layer: normalizeTaskSettingsLayer(layers[key], { scope: `layer:${tag}` }),
  }))

  const runTimeLimitLeaf = rightmostDefined(entries, (layer) => layer.runTimeLimitMinutes)
  const runTimeLimitMinutes = runTimeLimitLeaf.value ?? SYSTEM_DEFAULT_RUN_TIME_LIMIT_MINUTES
  const runTimeLimitSource = runTimeLimitLeaf.source ?? 'system_global'

  // Routing score weights are global-only: sourced exclusively from the
  // normalized userGlobal layer. Absence lets the catalog scorer use its own
  // defaults.
  const userGlobalEntry = entries.find((entry) => entry.tag === 'user_global')
  const routingWeights = userGlobalEntry?.layer.routingWeights
  const healthThresholdLeaf = rightmostDefined(entries, (layer) => layer.healthErrorRateThreshold)
  const healthErrorRateThreshold =
    healthThresholdLeaf.value ?? SYSTEM_DEFAULT_HEALTH_ERROR_RATE_THRESHOLD_PERCENT
  const healthErrorRateThresholdSource = healthThresholdLeaf.source ?? 'system_global'

  const dispatch: TaskDispatchRequirements = {}
  const dispatchSources: Partial<Record<TaskDispatchField, TaskSettingsSourceTag>> = {}
  for (const field of TASK_DISPATCH_FIELDS) {
    const leaf = rightmostDefined(entries, (layer) => layer.dispatch?.[field])

    // `requiredCapabilities` hard-minimum exception: the task-definition
    // declaration (builtin Task layer) can never be stripped by a user layer,
    // including an explicit []. Union only the task minimum with the single
    // normal rightmost winner; dedupe in stable text,image order. Source is
    // `builtin_task` when the declaration alone contributes, otherwise the
    // highest contributing layer (the normal winner's source).
    if (field === 'requiredCapabilities') {
      const taskMinimum = entries.find((entry) => entry.tag === 'builtin_task')?.layer.dispatch?.requiredCapabilities ?? []
      const normalWinner = (leaf.value ?? []) as readonly ('text' | 'image')[]
      const merged = (['text', 'image'] as const).filter((capability) => taskMinimum.includes(capability) || normalWinner.includes(capability))
      if (merged.length > 0 || leaf.value !== undefined) {
        dispatch.requiredCapabilities = merged
        dispatchSources.requiredCapabilities = normalWinner.length === 0 && taskMinimum.length > 0
          ? 'builtin_task'
          : leaf.source ?? 'builtin_task'
      }
      continue
    }

    // `requiresWebSearch` hard-minimum exception: a task-definition declaration
    // (the builtin Task layer) of `requiresWebSearch: true` is mandatory — no
    // user layer, including an explicit `false` or a reset to undefined, may
    // erase it. A builtin `false`/absent leaves normal rightmost boolean
    // precedence intact. Source is `builtin_task` whenever the declaration alone
    // forces the value.
    if (field === 'requiresWebSearch') {
      const taskMinimum = entries.find((entry) => entry.tag === 'builtin_task')?.layer.dispatch?.requiresWebSearch ?? false
      const normalWinner = (leaf.value ?? false) as boolean
      if (taskMinimum === true || normalWinner === true) {
        dispatch.requiresWebSearch = true
        dispatchSources.requiresWebSearch = taskMinimum === true
          ? 'builtin_task'
          : leaf.source ?? 'builtin_task'
      } else if (leaf.value !== undefined) {
        dispatch.requiresWebSearch = false
        dispatchSources.requiresWebSearch = leaf.source ?? 'system_global'
      }
      continue
    }

    if (leaf.value !== undefined && leaf.source !== undefined) {
      ;(dispatch as Record<string, unknown>)[field] = leaf.value
      dispatchSources[field] = leaf.source
    }
  }

  // Implicit default expectation: when no layer defines `intelligenceExpected`,
  // the system default expectation is `mid`. The implicit default is clamped
  // upward to the effective hard minimum only (e.g. a `high` minimum lifts the
  // default to `high`) so it never violates the ordering; there is no
  // configurable ceiling. An explicitly configured expectation below the
  // minimum still fails via assertEffectiveIntelligenceOrder.
  if (dispatch.intelligenceExpected === undefined) {
    let expectedTier: IntelligenceTier = 'mid'
    const minTier = dispatch.intelligenceMin
    if (minTier !== undefined && INTELLIGENCE_ORDER.mid < INTELLIGENCE_ORDER[minTier]) {
      expectedTier = minTier
    }
    dispatch.intelligenceExpected = expectedTier
    dispatchSources.intelligenceExpected = 'system_global'
  }

  assertEffectiveIntelligenceOrder(dispatch)

  const sources: EffectiveTaskSettingsSources = {
    runTimeLimitMinutes: runTimeLimitSource,
  }
  if (routingWeights !== undefined) sources.routingWeights = 'user_global'
  sources.healthErrorRateThreshold = healthErrorRateThresholdSource
  sources.dispatch = dispatchSources

  return {
    runTimeLimitMinutes,
    dispatch,
    routingWeights,
    healthErrorRateThreshold,
    sources,
  }
}
