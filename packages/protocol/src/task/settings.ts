import type { ReasoningEffort, TaskResolvedDispatch } from './run-metadata.ts'
import type { TaskInheritanceChainEntry } from './definitions.ts'

export type TaskSettingsIntelligence = 'low' | 'mid' | 'high' | 'premium'
export type TaskSettingsCapability = 'text' | 'image'
export type TaskSettingsReasoningEffort = ReasoningEffort

/** Source layer that supplied an effective settings field; higher index wins. */
export type TaskSettingsSourceLayer =
  | 'system'
  | 'builtin'
  | 'user_global'
  | 'user_task'
  | 'invocation'

/** One exact resolved runtime triple used only where automatic selection or
 *  resolved provider readiness genuinely needs client/provider/model. Never a
 *  user selection; execution resolves the automatic selection to a canonical
 *  run target. */
export interface TaskSettingsRuntimeTriple {
  client: string
  provider: string
  model: string
}

/** JSON-safe snake_case automatic dispatch fields mirroring TaskDispatchRequirements. */
export interface TaskSettingsAutomaticDispatch {
  expected_tps?: number
  minimum_tps?: number
  intelligence_min?: TaskSettingsIntelligence
  intelligence_expected?: TaskSettingsIntelligence
  max_output_usd_per_million?: number
  required_capabilities?: readonly TaskSettingsCapability[]
  exclude_model_ids?: readonly string[]
  exclude_profile_ids?: readonly string[]
  exclude_client_ids?: readonly string[]
  exclude_provider_ids?: readonly string[]
  /** Hidden web search requirement; mirrors TaskDispatchRequirements.requiresWebSearch. Not a UI control. */
  requires_web_search?: boolean
  /** Requests verified Fast mode; mirrors TaskDispatchRequirements.fast. */
  fast?: boolean
  /** Expected reasoning-effort level; mirrors TaskDispatchRequirements.expectedReasoningEffort.
   *  Every task declares one; inherited declarations may inherit it. */
  expected_reasoning_effort?: TaskSettingsReasoningEffort
}

export type TaskSettingsAutomaticPatch = {
  [K in keyof TaskSettingsAutomaticDispatch]?: TaskSettingsAutomaticDispatch[K] | null
}

/** JSON-safe view of one editable settings layer (user global, user per-task, or invocation). */
export interface TaskSettingsLayer {
  timeout_ms?: number | null
  automatic?: Partial<TaskSettingsAutomaticDispatch> | null
  /** Global-only automatic scoring weights; null clears them. All four numeric
   *  fields are required, bounded [0, 1], and must sum to 1. */
  routing_weights?: TaskSettingsRoutingWeights | null
}

/** Global-only automatic scoring weights, one finite number in [0, 1] per key;
 *  the four values must sum to 1. Mirrors the catalog scorer keys P/S/Q/I. */
export interface TaskSettingsRoutingWeights {
  price: number
  speed: number
  quota: number
  intelligence: number
}

/** Field-level save patch. `null` deletes that field only at the selected layer. */
export interface TaskSettingsPatch {
  timeout_ms?: number | null
  automatic?: TaskSettingsAutomaticPatch | null
  /** Global-only: set (full four-key object) or clear (null) routing weights. */
  routing_weights?: TaskSettingsRoutingWeights | null
}

/** An effective value plus the layer it came from. */
export interface TaskSettingsSourcedValue<T> {
  value: T
  source: TaskSettingsSourceLayer
}

export interface TaskSettingsEffectiveAutomatic {
  expected_tps: TaskSettingsSourcedValue<number | null>
  minimum_tps: TaskSettingsSourcedValue<number | null>
  intelligence_min: TaskSettingsSourcedValue<TaskSettingsIntelligence | null>
  intelligence_expected: TaskSettingsSourcedValue<TaskSettingsIntelligence | null>
  max_output_usd_per_million: TaskSettingsSourcedValue<number | null>
  required_capabilities: TaskSettingsSourcedValue<TaskSettingsCapability[] | null>
  exclude_model_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_profile_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_client_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_provider_ids: TaskSettingsSourcedValue<string[] | null>
  /** Hidden web search requirement; sourced from the same dispatch merge. Not a UI control. */
  requires_web_search?: TaskSettingsSourcedValue<boolean | null>
  /** Expected reasoning-effort level; sourced from the same dispatch merge.
   *  Every task declares one; inherited declarations may inherit it. */
  expected_reasoning_effort?: TaskSettingsSourcedValue<TaskSettingsReasoningEffort | null>
}

export interface TaskSettingsEffective {
  timeout_ms: TaskSettingsSourcedValue<number | null>
  automatic: TaskSettingsEffectiveAutomatic
  /** Global-only routing weights; sourced exclusively from the user_global
   *  layer; a null value means the scorer defaults apply. */
  routing_weights?: TaskSettingsSourcedValue<TaskSettingsRoutingWeights | null>
}

/** Wire-owned closed resolution-failure code. Mirrors the structurally
 *  compatible core value without importing core modules into the protocol. */
export type TaskResolutionFailureCode =
  | 'no_available_provider'
  | 'price_limit'
  | 'intelligence_requirement'
  | 'speed_requirement'
  | 'quota_unavailable'
  | 'quota_insufficient'
  | 'context_window'

/** Wire-owned closed resolution-failure detail carried on a validation issue. */
export interface TaskResolutionFailure {
  code: TaskResolutionFailureCode
  message: string
}

export interface TaskSettingsValidationIssue {
  code: string
  message: string
  field?: string
  resolutionFailure?: TaskResolutionFailure
}

/** One ordered, non-executing preview segment of a builtin prompt template. */
export type TaskSettingsInstructionSegment =
  /** Static instruction text carried verbatim; renderers escape before display. */
  | { kind: 'text'; source: string; text: string }
  /** A non-executed function instruction or the input-dependent prompt body. */
  | { kind: 'placeholder'; source: string; label: string }

/** Ordered safe preview of the builtin prompt template; never executes config. */
export type TaskSettingsInstructionTemplate = TaskSettingsInstructionSegment[]

export interface TaskSettingsBuiltinMetadata {
  identity: string
  name: string
  source: string
  description?: string
  project?: string
  /** Read-only builtin prompt template kind. The builtin prompt/required docs
   *  are never editable. */
  prompt_template: 'dynamic' | 'fixed'
  /** Ordered non-executing preview segments of the builtin prompt template. */
  instruction_template: TaskSettingsInstructionTemplate
  timeout_ms: number | null
  /** Read-only builtin automatic dispatch defaults. */
  dispatch: TaskSettingsAutomaticDispatch
}

/** Task-settings-resolved dispatch augmented with additive authoritative
 *  Catalog display labels. Canonical ids and every existing wire field are
 *  kept; the display labels are optional and always travel as a pair. */
export type TaskSettingsResolvedDispatch = TaskResolvedDispatch & {
  /** Authoritative Catalog provider display label; paired with `model_display_name`. */
  provider_display_name?: string
  /** Authoritative unified Catalog model display label; paired with `provider_display_name`. */
  model_display_name?: string
}

/**
 * Safe automatic-mode preview selection attached to an automatic row. The
 * resolved dispatch carries the optional privacy-safe auto_routing decision;
 * no raw quota/account/domain/credential/provider-error fields are exposed.
 */
export interface TaskSettingsAutomaticSelection {
  /** Canonical exact run target of the selected automatic dispatch. */
  exact_runtime: string
  /** Exact resolved automatic dispatch including the safe auto_routing decision
   *  and the additive authoritative Catalog display labels. */
  resolved: TaskSettingsResolvedDispatch
  /** Safe human-readable reason for the automatic selection. */
  reason: string
}

export interface TaskSettingsTaskRow {
  /** Stable identity: `builtin:<name>` or `project:<project>:<name>`. */
  identity: string
  name: string
  /** Authoritative display label; falls back to the exact task `name`. */
  display_name: string
  project?: string
  /** Authoritative project display label on project rows; falls back to the exact project id. */
  project_display_name?: string
  builtin: TaskSettingsBuiltinMetadata
  /** Persisted per-task user layer for this identity. */
  user_task: TaskSettingsLayer
  effective: TaskSettingsEffective
/** Present when a selection resolved; exposes the selected automatic
 *  dispatch and safe reason. */
  automatic_selection?: TaskSettingsAutomaticSelection
  /** Base→effective inheritance chain; present only when this row's effective
   *  definition was resolved from an inherited declaration. */
  inheritanceChain?: TaskInheritanceChainEntry[]
  issues: TaskSettingsValidationIssue[]
}

export interface TaskSettingsSnapshotParams {
  project?: string
  task_id?: string
}

/** One registry task definition load error surfaced out-of-band from executable
 *  settings rows (strict schema failures and duplicate definitions). Errors never
 *  double as executable settings rows. */
export interface TaskSettingsLoadError {
  /** Authoritative path to the definition file that failed to load. */
  source_path: string
  /** Stable raw filename (basename) of the offending definition file. */
  file_name: string
  /** Human-readable load error message. */
  message: string
  /** Registered project id owning the file's directory, when resolvable;
   *  absent when the file is outside any registered project. */
  project?: string
  /** Authoritative `.fmproj` display label for `project`, when known. */
  project_display_name?: string
}

export interface TaskSettingsSnapshotResult {
  config_path: string
  revision: string
  project?: string
  /** Persisted user-global settings layer. */
  user_global: TaskSettingsLayer
  rows: TaskSettingsTaskRow[]
  /** Optional registry task definition load errors (strict schema failures and
   *  duplicate definitions), surfaced separately from executable settings rows.
   *  Absent when the snapshot has no load errors. */
  load_errors?: TaskSettingsLoadError[]
}

export interface TaskSettingsSaveParams {
  scope: 'global' | 'task'
  task_id?: string
  project?: string
  expected_revision: string
  patch: TaskSettingsPatch
}

export type TaskSettingsSaveResult = TaskSettingsSnapshotResult

/** Simplified form-based routing diagnostics input: the caller submits the
 *  automatic dispatch form fields directly plus an optional timeout. No task
 *  identity, saved settings layer, or global layer is consulted. */
export interface TaskRoutingTestParams {
  automatic: TaskSettingsAutomaticDispatch
  timeout_ms?: number
}

/** One provider+model routing diagnostic row. Qualified rows carry the
 *  production rank and the actual weighted scorer contributions (which sum to
 *  `score`); a qualified confirmed-free row also carries a short Chinese
 *  free-tier note in `reason`, while a qualified paid row keeps `reason` null.
 *  Rejected rows carry null rank/score and a short Chinese rejection reason.
 *  No client, runtime identity, trace, or internal diagnostic is exposed. */
export interface TaskRoutingTestRow {
  provider: string
  provider_name: string
  model: string
  model_name: string
  effective_tps: number | null
  /** Measured median first-token latency used by scoring; null when rejected
   *  or when no local sample measured it. */
  first_token_ms?: number | null
  /** Actual weighted price contribution (`SCORE_WEIGHTS.P * priceFactor`). */
  price_score: number | null
  /** Actual weighted speed contribution (`SCORE_WEIGHTS.S * speedFactor`). */
  speed_score: number | null
  /** Actual weighted quota contribution (`SCORE_WEIGHTS.Q * quotaFactor`). */
  quota_score: number | null
  /** Actual weighted intelligence contribution (`SCORE_WEIGHTS.I * intelligenceFactor`). */
  intelligence_score: number | null
  /** Sum of the four weighted factor contributions; null when rejected. */
  score: number | null
  /** Production rank (1-based) for qualified rows; null when rejected. */
  rank: number | null
  /** Short Chinese reason: a free-tier note on a qualified confirmed-free row,
   *  null on a qualified paid row, and the rejection reason on a rejected row. */
  reason: string | null
}

export interface TaskRoutingTestResult {
  rows: TaskRoutingTestRow[]
}

/** One task importable into the routing form. `automatic`/`timeout_ms` are the
 *  raw definition configuration, never the effective user settings snapshot. */
export interface TaskRoutingTestTask {
  /** Stable identity: `builtin:<name>` or `project:<project>:<name>`. */
  identity: string
  name: string
  display_name: string
  project?: string
  automatic: TaskSettingsAutomaticDispatch
  timeout_ms?: number
}

export interface TaskRoutingTestTasksParams {}

export interface TaskRoutingTestTasksResult {
  tasks: TaskRoutingTestTask[]
}
