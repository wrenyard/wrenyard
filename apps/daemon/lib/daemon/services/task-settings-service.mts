import { quotaStateOf, deepSeekAutomaticPricingOf, rankAutomaticTaskCandidates, type DeepSeekAutomaticPricing } from '@wrenyard/auto-routing';
import { createHash } from 'node:crypto'
import { INTELLIGENCE_ORDER, type ReasoningEffort } from '@wrenyard/providers/catalog';
import type { GatewayRouteStatus } from '@wrenyard/providers/base';
import { type RankedCandidate } from '@wrenyard/auto-routing';
import {
  NoEligiblePlanError,
  type TaskDispatchChoice,
  type TaskDispatchDiagnosticChoice,
  type TaskDispatchDisplayLabels,
  type TaskDispatchResolver,
} from '@wrenyard/task'
import {
  codeFromCatalogExclusion,
  selectTaskResolutionFailure,
  taskResolutionFailure,
  taskResolutionFailureDetailMessage,
  type TaskResolutionElimination,
  type TaskResolutionFailureCode,
  type TaskResolutionFailureDetail,
} from '@wrenyard/task'
import { TaskService } from '../../core/task/service.mts'
import { getTaskPromptTemplates } from '@wrenyard/task'
import { resolveTaskTarget, getLoadErrors } from '../../workspace/definition-registry.mts'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { discoverProjects } from '../../core/project/loader.mts'
import type { ForemanConfigStore } from '../../config/manager.mts'
import { JsonForemanConfigStore } from '../../config/manager.mts'
import {
  TASK_DISPATCH_FIELDS,
  taskDefaultsToSettingsLayer,
  taskSettingsIdentity,
  readGlobalTaskSettings,
  readPerTaskSettings,
  readRoutingExclusions,
  normalizeTaskSettingsLayer,
  resolveEffectiveTaskSettings,
  rawLayerDeclaresLegacyTimeout,
  type TaskDispatchField,
  type TaskSettingsDispatch as ConfigTaskDispatchRequirements,
  type TaskSettingsLayer as ConfigTaskSettingsLayer,
  type TaskSettingsSourceTag,
  type TaskRoutingWeights,
  type TasksConfigSettingsInput,
} from '@wrenyard/task'
import type {
  TaskAutoRoutingDecision,
  TaskResolvedDispatch,
} from '@wrenyard/protocol'
import {
  AutoRoutingQuotaSnapshotService,
  type AutoRoutingBoundQuotaSnapshot,
  type AutoRoutingQuotaSnapshot,
  type CodeBuddyActiveSnapshotView,
} from './auto-routing-snapshot-service.mts'
import type {
  TaskRoutingTestParams,
  TaskRoutingTestResult,
  TaskRoutingTestRow,
  TaskRoutingTestTask,
  TaskRoutingTestTasksParams,
  TaskRoutingTestTasksResult,
  TaskSettingsAutomaticDispatch,
  TaskSettingsAutomaticSelection,
  TaskSettingsInstructionSegment,
  TaskSettingsLayer as TaskSettingsLayerDto,
  TaskSettingsLoadError,
  TaskSettingsPatch,
  TaskSettingsRuntimeTriple,
  TaskSettingsSaveParams,
  TaskSettingsSnapshotParams,
  TaskSettingsSnapshotResult,
  TaskSettingsSourceLayer,
  TaskSettingsTaskRow,
  TaskSettingsValidationIssue,
  TaskInheritanceChainEntry,
} from '../../protocol/methods/task.mts'
import type {
  TaskRunSettingsParams,
  TaskRunSettingsResolution,
} from '../../types.mts'
import type { CodeBuddyExecutionBinding } from '../../core/operations/types.mts'
import type { NativeProviderReadinessSnapshot } from '../execution/native-provider-readiness.mts'

export type {
  TaskRunSettingsLayerName,
  TaskRunSettingsParams,
  TaskRunSettingsResolution,
  TaskRunSettingsResolver,
} from '../../types.mts'

/**
 * Daemon-owned TaskSettingsService backing `task.settings.snapshot` /
 * `task.settings.save`.
 *
 * Persistence is restricted to `tasks.settings.global` (user-global layer) and
 * `tasks.settings.byTask[<stable identity>]` (per-task user layer). The legacy
 * `tasks.agentRuntime` map is neither read nor written.
 *
 * Runtime selection is automatic only: persisted `selection_mode`/`explicit_runtime`
 * keys are ignored by the layer reader and never reach the resolver.
 *
 * Effective settings resolve through config/task-settings.mts, merging the
 * system defaults, builtin task defaults, user global, user per-task, and (for
 * runs) invocation layers right-wins. Snapshot/preflight never performs a paid
 * model call: selection validates via `TaskDispatchResolver.resolve`/`eligible`,
 * with daemon admission and live provider credential/availability supplied by
 * injected non-billable callbacks.
 */
const ROUTING_TEST_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

const MS_PER_MINUTE = 60_000

export interface TaskSettingsDefinitionSummary {
  name: string
  /** Authoritative human-facing task label; consumers fall back to the exact `name`. */
  displayName?: string
  /** Authoritative project display label for project rows; fallback to project id. */
  projectDisplayName?: string
  kind?: 'builtin' | 'project'
  project?: string
  source?: string
  description?: string
  dispatch?: unknown
  promptTemplate?: 'dynamic' | 'fixed'
  /** Ordered safe preview segments of the builtin prompt template; never
   *  produced by executing definition functions. */
  instructionTemplate?: TaskSettingsInstructionSegment[]
  /** Base→effective inheritance chain; present only when the effective
   *  definition was resolved from an inherited declaration. */
  inheritanceChain?: TaskInheritanceChainEntry[]
}

export interface TaskSettingsDefinitionDetail extends TaskSettingsDefinitionSummary {
  input_schema?: unknown
  output_schema?: unknown
}

/** One registered project known to project discovery: id plus the optional
 *  authoritative `.fmproj` display label. */
export interface TaskSettingsProjectSummary {
  id: string
  displayName?: string
}

export interface TaskSettingsDefinitionSource {
  list(project?: string): TaskSettingsDefinitionSummary[] | Promise<TaskSettingsDefinitionSummary[]>
  describe(taskId: string, project?: string): TaskSettingsDefinitionDetail | Promise<TaskSettingsDefinitionDetail>
  /** Optional discovery-only view of registered projects (id + `.fmproj`
   *  displayName). Never touches host paths, clones, sync, or remotes. */
  listProjects?(): TaskSettingsProjectSummary[] | Promise<TaskSettingsProjectSummary[]>
  /** Optional registry task definition load errors (strict schema failures and
   *  duplicate definitions) surfaced separately from executable settings rows.
   *  Absent sources contribute no load errors to a snapshot. */
  listLoadErrors?(): TaskSettingsLoadError[] | Promise<TaskSettingsLoadError[]>
}

export interface TaskSettingsProviderAvailability {
  providerCredential: 'available' | 'missing' | 'unknown'
  providerLive: 'available' | 'unavailable' | 'unknown'
  quota: 'available' | 'unavailable' | 'unknown'
  available: boolean
  reason?: string
  /** Privacy-safe confirmed-free routing supply fact for the already-read
   *  credential (current CodeBuddy internal/ioa environments only). Never
   *  carries a token, domain, or internal upstream suffix. Absent means the
   *  account/environment is not confirmed free (external/cloudhosted/unknown/
   *  missing credential/other providers). */
  freeSupply?: { confirmedFree: true; source: string; ruleId: string }
  /** Private execution admission tuple derived from the same current
   * CodeBuddy snapshot as readiness/free supply. Never serialized into task
   * settings previews, routing decisions, or persisted dispatch metadata. */
  codeBuddyExecution?: CodeBuddyExecutionBinding
}

/** Request-bound private availability context. Presence is significant: an
 * explicit undefined snapshot means current-login resolution failed and the
 * callback must fail closed instead of loading a different credential. */
export interface TaskSettingsRuntimeAvailabilityContext {
  readonly codeBuddySnapshot: CodeBuddyActiveSnapshotView | undefined
  /** One request/evaluation-bound native provider status sample.
   *  Null means the bounded status read failed and callers must stay unknown;
   *  absence of the context means callers may load one fresh. */
  readonly nativeProviderReadiness: NativeProviderReadinessSnapshot | null
}

/** Internal resolved target for a readiness probe. Mode is required so a
 * native login can never be promoted into Gateway route availability. */
export interface TaskSettingsRuntimeAvailabilityTarget extends TaskSettingsRuntimeTriple {
  mode: 'native' | 'gateway'
}

/** Non-billable live provider credential/route availability probe input: the
 *  resolved client/provider/model/mode target of an already-selected canonical
 *  target. Never carries user config or alias state. */
export type TaskSettingsRuntimeAvailabilityCallback = (
  runtime: TaskSettingsRuntimeAvailabilityTarget,
  context?: TaskSettingsRuntimeAvailabilityContext,
) => Promise<TaskSettingsProviderAvailability> | TaskSettingsProviderAvailability

/** One bounded native provider status read. No credentials cross this
 * boundary; TaskSettings only binds the immutable result to one evaluation. */
export type TaskSettingsNativeProviderReadinessCallback =
  () => Promise<NativeProviderReadinessSnapshot>

/** Authoritative per-client config/installation state. */
export interface ClientReadiness {
  readonly enabled: boolean
  readonly installed: boolean
}

export interface ClientReadinessSnapshot {
  /** Completion time of the authoritative non-inference client read. */
  readonly sampledAtMs: number
  /** Exact client id -> authoritative config/installation state. */
  readonly clientsById: Readonly<Record<string, ClientReadiness>>
}

/** One bounded authoritative client readiness read backed by each AgentClient's
 *  inspect result. It carries ALL registered clients with their enabled/installed
 *  facts and no credentials, paths, or raw stderr. */
export type TaskSettingsClientReadinessCallback =
  () => Promise<ClientReadinessSnapshot>

export interface TaskSettingsDaemonStatus {
  accepting: boolean
  /** When false, acceptance could not be verified from a real daemon source. */
  known?: boolean
}

export type TaskSettingsDaemonAvailabilityCallback =
  () => Promise<TaskSettingsDaemonStatus> | TaskSettingsDaemonStatus

export interface TaskSettingsServiceOptions {
  workspaceRoot: string
  /** Authoritative resolved config file the daemon is running against. */
  configPath: string
  /** Shared daemon dispatch resolver; eligibility comes from this instance only. */
  resolver: TaskDispatchResolver
  store?: ForemanConfigStore
  definitions?: TaskSettingsDefinitionSource
  /** Optional non-billable daemon admission availability (accepting/frozen). */
  daemonAvailability?: TaskSettingsDaemonAvailabilityCallback
  /** Optional non-billable live provider credential/route availability probe. */
  runtimeAvailability?: TaskSettingsRuntimeAvailabilityCallback
  /** Optional authoritative non-inference native provider status source. It is
   * sampled once only when an evaluation contains native Codex/Cursor choices. */
  nativeProviderReadiness?: TaskSettingsNativeProviderReadinessCallback
  /** Optional authoritative client readiness source backed by each AgentClient
   *  inspect result. When configured, a client must be enabled AND installed to
   *  be admitted; a failed query or a missing client state fails closed. */
  clientReadiness?: TaskSettingsClientReadinessCallback
  /** Daemon-owned immutable automatic-routing quota snapshot service shared by
   *  every automatic selection (run and snapshot row preview). Snapshot row
   *  preview takes one immutable snapshot per request; every other selection
   *  call takes its own. */
  quotaSnapshots?: AutoRoutingQuotaSnapshotService
  /** Optional in-memory Gateway route circuit status keyed by a route key:
   *  `provider/model` for the shared free-supply gate, plus the client-qualified
   *  `provider/model:client` task target for the additional exact task-client
   *  gate. It is the same shared Gateway instance and callable semantics already
   *  consumed by session and auxiliary routing, so no second circuit exists. An
   *  open route, or a half-open route whose next recovery probe is still in the
   *  future, is not admitted, while a due half-open route is (the Gateway owns
   *  the bounded probe/lease). */
  routeStatus?: (model: string) => GatewayRouteStatus | undefined
  /** Injectable request clock for deterministic pricing snapshots. */
  now?: () => number
}

/** Typed CAS failure: the caller's expected_revision no longer matches the file. */
export class TaskSettingsContentConflictError extends Error {
  readonly code = 'content_conflict' as const
  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(
      `task settings content conflict: expected revision ${expectedRevision}, found ${actualRevision}`,
    )
    this.name = 'TaskSettingsContentConflictError'
  }
}

export class TaskSettingsTaskNotFoundError extends Error {
  readonly code = 'task_not_found' as const
  constructor(taskId: string) {
    super(`task '${taskId}' not found`)
    this.name = 'TaskSettingsTaskNotFoundError'
  }
}

export class TaskSettingsInvalidSettingsError extends Error {
  readonly code = 'invalid_settings' as const
  constructor(
    readonly detail?: string,
    message?: string,
  ) {
    super(message ?? (detail !== undefined ? `invalid task settings: ${detail}` : 'invalid task settings'))
    this.name = 'TaskSettingsInvalidSettingsError'
  }
}

export class TaskSettingsRuntimeUnavailableError extends Error {
  readonly code = 'runtime_unavailable' as const
  constructor(
    readonly taskId: string,
    readonly runtime: string,
    readonly reason: string,
  ) {
    super(`runtime '${runtime}' is unavailable for task '${taskId}': ${reason}`)
    this.name = 'TaskSettingsRuntimeUnavailableError'
  }
}

const SOURCE_MAP: Record<TaskSettingsSourceTag, TaskSettingsSourceLayer> = {
  system_global: 'system',
  builtin_task: 'builtin',
  user_global: 'user_global',
  user_task: 'user_task',
  invocation: 'invocation',
}

function toSourceLayer(tag: TaskSettingsSourceTag | undefined): TaskSettingsSourceLayer {
  return tag === undefined ? 'system' : SOURCE_MAP[tag]
}

function snakeKey(field: TaskDispatchField): string {
  return field.replace(/[A-Z]/gu, (ch) => `_${ch.toLowerCase()}`)
}

function camelKey(snake: string): string {
  return snake.replace(/_([a-z])/gu, (_whole, ch: string) => ch.toUpperCase())
}

function isDispatchField(value: string): boolean {
  return (TASK_DISPATCH_FIELDS as readonly string[]).includes(value)
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as unknown as T
  return value
}

/** Canonical camel-case dispatch object -> JSON-safe snake_case DTO object. */
function toSnakeDispatch(dispatch: ConfigTaskDispatchRequirements): TaskSettingsAutomaticDispatch {
  const out: Record<string, unknown> = {}
  for (const field of TASK_DISPATCH_FIELDS) {
    const value = dispatch[field]
    if (value === undefined) continue
    out[snakeKey(field)] = cloneValue(value)
  }
  return out as TaskSettingsAutomaticDispatch
}

/** TaskConfig/catalog-style dispatch already uses canonical camel-case keys. */
function rawDefinitionDispatch(value: unknown): ConfigTaskDispatchRequirements {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as ConfigTaskDispatchRequirements
  }
  return {}
}

/**
 * Inputs that actually mount computer-use are routed to models of high-or-above
 * intelligence; declared-but-unmounted features do not trigger this.
 */
export function applyMountedFeatureRoutingPreferences(
  dispatch: ConfigTaskDispatchRequirements | undefined,
  mountedFeatures: readonly string[] | undefined,
): ConfigTaskDispatchRequirements {
  const base = dispatch ?? {}
  // Feature id mounted for desktop control; no shared exported constant exists.
  if (!mountedFeatures?.includes('computer-use')) return base
  if (base.intelligenceMin !== undefined && INTELLIGENCE_ORDER[base.intelligenceMin] >= INTELLIGENCE_ORDER.high) {
    return base
  }
  return { ...base, intelligenceMin: 'high' }
}

/** Synthetic task name used only to key the read-only routing form; it never
 *  identifies a real definition and never reaches a resolver error message. */
const ROUTING_FORM_TASK_NAME = 'routing-form'

/**
 * Normalizes the SUBMITTED routing form into the canonical camel-case dispatch
 * requirements. Only the submitted form participates: no saved task/global
 * layer is read or inherited. The recommended intelligence expectation defaults
 * to `mid` (clamped up to an explicit hard minimum) and no hard minimum is
 * imposed unless submitted.
 */
function routingFormRequirements(automatic: TaskSettingsAutomaticDispatch): ConfigTaskDispatchRequirements {
  return resolveEffectiveTaskSettings({ invocation: normalizeTaskSettingsLayer({ dispatch: automatic }) }).dispatch
}

/**
 * Unions the global routing exclusions (config root `routing.exclude`, read
 * through the user-global layer's `dispatch`) into a routing-form requirement
 * set, deduplicated against any exclusion the submitted form already carries.
 * Only the model/provider exclusion axes are merged: every other global
 * dispatch field stays out of the form-only diagnostic.
 */
function mergeRoutingExclusions(
  requirements: ConfigTaskDispatchRequirements,
  globalDispatch: ConfigTaskDispatchRequirements | undefined,
): ConfigTaskDispatchRequirements {
  const models = globalDispatch?.excludeModelIds
  const providers = globalDispatch?.excludeProviderIds
  if (models === undefined && providers === undefined) return requirements
  const merged: ConfigTaskDispatchRequirements = { ...requirements }
  if (models !== undefined) {
    merged.excludeModelIds = [...new Set([...(requirements.excludeModelIds ?? []), ...models])]
  }
  if (providers !== undefined) {
    merged.excludeProviderIds = [...new Set([...(requirements.excludeProviderIds ?? []), ...providers])]
  }
  return merged
}

/** One provider+model routing form row being assembled before final ordering. */
interface RoutingFormPair {
  provider: string
  model: string
  providerName: string
  modelName: string
  effectiveTps: number | null
  /** A ready supporting client's exact identity; any ready client admits the pair. */
  exactAgentRuntime: string
  /** Present when the pair is admitted by the submitted form. */
  admitted: boolean
  /** Closed code of the first submitted gate that rejected every ready client. */
  rejectionCode?: TaskResolutionFailureCode
  /** Closed specific cause behind `rejectionCode` when it is a qualitative gate
   *  (exclusion, unresolvable runtime, unsupported search/input capability). */
  rejectionDetail?: TaskResolutionFailureDetail
}

/** Collapses baseline diagnostic choices at provider+model, preferring native,
 *  then grok, then the stable other client (alphabetical tie-break). Any ready
 *  supporting client can admit the pair; a client admitted by the submitted
 *  form wins so qualified pairs are never lost to a rejected sibling client. */
function collapseRoutingFormPairs(
  choices: readonly TaskDispatchDiagnosticChoice[],
): Map<string, RoutingFormPair> {
  const groups = new Map<string, TaskDispatchDiagnosticChoice[]>()
  for (const choice of choices) {
    const parsed = splitRuntimeIdentity(choice.exactAgentRuntime)
    if (parsed === undefined) continue
    const key = `${parsed.provider}/${parsed.model}`
    const group = groups.get(key)
    if (group) group.push(choice)
    else groups.set(key, [choice])
  }
  const pairs = new Map<string, RoutingFormPair>()
  for (const [key, group] of groups) {
    group.sort((a, b) => {
      // Prefer an admitted client, then the production client preference.
      const aAdmitted = a.admitted !== undefined ? 0 : 1
      const bAdmitted = b.admitted !== undefined ? 0 : 1
      if (aAdmitted !== bAdmitted) return aAdmitted - bAdmitted
      return a.exactAgentRuntime.localeCompare(b.exactAgentRuntime)
    })
    const chosen = group[0]!
    const parsed = splitRuntimeIdentity(chosen.exactAgentRuntime)!
    const admittedEntry = group.find((entry) => entry.admitted !== undefined)
    const admitted = admittedEntry !== undefined
    const tpsSource = admittedEntry ?? chosen
    const rejectionEntry = admitted ? undefined : group.find((entry) => entry.rejectionCode !== undefined)
    pairs.set(key, {
      provider: parsed.provider,
      model: parsed.model,
      providerName: parsed.provider,
      modelName: parsed.model,
      effectiveTps: tpsSource.baseline?.speed.effective_tps ?? tpsSource.admitted?.speed.effective_tps ?? null,
      exactAgentRuntime: chosen.exactAgentRuntime,
      admitted,
      ...(rejectionEntry?.rejectionCode !== undefined ? { rejectionCode: rejectionEntry.rejectionCode } : {}),
      ...(rejectionEntry?.rejectionDetail !== undefined ? { rejectionDetail: rejectionEntry.rejectionDetail } : {}),
    })
  }
  return pairs
}

/** Splits a canonical `provider/model:client` runtime identity. */
function splitRuntimeIdentity(exactAgentRuntime: string): { provider: string; model: string } | undefined {
  const colon = exactAgentRuntime.lastIndexOf(':')
  const head = colon >= 0 ? exactAgentRuntime.slice(0, colon) : exactAgentRuntime
  const slash = head.indexOf('/')
  if (slash <= 0 || slash >= head.length - 1) return undefined
  return { provider: head.slice(0, slash), model: head.slice(slash + 1) }
}

/**
 * Builds the final provider+model routing form rows from the baseline-available
 * pairs and the shared automatic-selection trace. Qualified pairs keep the
 * production rank and the actual weighted scorer contributions (each a
 * `ranked.weights` term that sums to `score`); rejected pairs carry null
 * rank/score and a short Chinese reason from the closed failure message set.
 */
function buildRoutingFormRows(
  baselineChoices: readonly TaskDispatchDiagnosticChoice[],
  trace: AutomaticSelectionTrace,
  resolver: TaskDispatchResolver,
  requirements: ConfigTaskDispatchRequirements,
): TaskRoutingTestRow[] {
  const pairs = collapseRoutingFormPairs(baselineChoices)
  const rankedByRuntime = new Map(trace.ranked.map((entry) => [entry.canonicalId, entry]))
  const rankedByPair = new Map<string, (typeof trace.ranked)[number]>()
  for (const entry of trace.ranked) {
    const parsed = splitRuntimeIdentity(entry.canonicalId)
    if (parsed === undefined) continue
    const key = `${parsed.provider}/${parsed.model}`
    if (!rankedByPair.has(key)) rankedByPair.set(key, entry)
  }
  const collapsedByRuntime = new Map(trace.collapsedChoices.map((choice) => [choice.exactAgentRuntime, choice]))
  const readinessRejected = new Set(trace.readinessRejectedIds)
  const quotaBlocked = new Set(trace.quotaBlockedIds)
  const circuitBlocked = new Set(trace.circuitBlockedIds)
  const unscorable = new Map(trace.unscorable.map((entry) => [entry.id, entry.code]))
  const catalogExcluded = new Map(trace.catalogExcluded.map((entry) => [entry.id, entry.reason]))

  const rows: TaskRoutingTestRow[] = []
  for (const pair of pairs.values()) {
    const runtime = pair.exactAgentRuntime

    const pairKey = `${pair.provider}/${pair.model}`
    const ranked = rankedByRuntime.get(runtime) ?? (pair.admitted ? rankedByPair.get(pairKey) : undefined)
    const choice = collapsedByRuntime.get(runtime)
    const labels = resolver.displayLabels({ provider: pair.provider, model: pair.model })
    const providerName = labels?.providerDisplayName ?? pair.providerName
    const modelName = labels?.modelDisplayName ?? pair.modelName

    if (ranked !== undefined) {
      const rankedChoice = collapsedByRuntime.get(ranked.canonicalId) ?? choice
      const effectiveTps = rankedChoice?.speed.effective_tps ?? pair.effectiveTps
      rows.push({
        provider: pair.provider,
        provider_name: providerName,
        model: pair.model,
        model_name: modelName,
        effective_tps: effectiveTps ?? null,
        price_score: ranked.weights.P * ranked.priceFactor,
        speed_score: ranked.weights.S * ranked.speedFactor,
        quota_score: ranked.weights.Q * ranked.quotaQuality,
        intelligence_score: ranked.weights.I * ranked.intelligenceFactor,
        score: ranked.score,
        rank: ranked.rank,
        reason: ranked.tier === 'abundant' ? '额度充足，优先于受限路线' : null,
      })
      continue
    }

    // Rejected: closed Chinese reason, never raw resolver/quota detail. The
    // submitted-gate rejection code (baseline availability already confirmed)
    // takes priority, then the live quota/unscorable/catalog gates. The
    // submitted gate's closed specific detail, when present, is the truthful
    // reason (e.g. 不支持图片输入 / 不支持联网搜索 / 模型已排除); otherwise the
    // generic per-code message applies.
    const code: TaskResolutionFailureCode = quotaBlocked.has(runtime)
      ? 'quota_unavailable'
      : pair.rejectionCode
        ?? unscorable.get(runtime)
        ?? (catalogExcluded.has(runtime)
          ? codeFromCatalogExclusion(catalogExcluded.get(runtime)!) ?? 'no_available_provider'
          : 'no_available_provider')
    // The closed specific detail is used only when the reason itself came from
    // the submitted gate (a quota/unscorable/catalog reason has no detail).
    const detail: TaskResolutionFailureDetail | undefined =
      quotaBlocked.has(runtime) ? undefined : pair.rejectionDetail
    // A route the exact task-client circuit refuses is reported as exactly
    // that, before any other closed reason, so the elimination is never misread
    // as a submitted gate failure.
    const reason = circuitBlocked.has(runtime)
      ? '路由熔断，暂不可用'
      : detail !== undefined
        ? detail === 'model_excluded'
          ? `排除模型：${modelName}`
          : detail === 'provider_excluded'
            ? `排除供应商：${providerName}`
            : detail === 'profile_excluded'
              ? '排除运行配置'
              : detail === 'client_excluded'
                ? '排除客户端'
                : taskResolutionFailureDetailMessage(detail)
        : code === 'intelligence_requirement'
          ? `最低智能：${requirements.intelligenceMin ?? requirements.intelligenceExpected ?? 'mid'}`
          : code === 'speed_requirement'
            ? `最低速度：${requirements.minimumTps ?? requirements.expectedTps ?? 0} TPS`
            : code === 'price_limit'
              ? `输出单价上限：$${requirements.maxOutputUsdPerMillion ?? 0}/Mtok`
              : ({
                context_window: '上下文窗口不足',
                quota_unavailable: '额度不足',
                quota_insufficient: '额度不足',
                no_available_provider: '不满足任务要求',
              } as Record<'context_window' | 'quota_unavailable' | 'quota_insufficient' | 'no_available_provider', string>)[code]
    rows.push({
      provider: pair.provider,
      provider_name: providerName,
      model: pair.model,
      model_name: modelName,
      effective_tps: pair.effectiveTps,
      price_score: null,
      speed_score: null,
      quota_score: null,
      intelligence_score: null,
      score: null,
      rank: null,
      reason,
    })
  }
  rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  let position = 0
  for (const row of rows) if (row.rank !== null) row.rank = ++position
  return rows
}

/** Canonical config layer -> a raw alias object the normalizer accepts. */
function canonicalLayerToRaw(layer?: ConfigTaskSettingsLayer): Record<string, unknown> {
  if (!layer) return {}
  const raw: Record<string, unknown> = {}
  if (layer.runTimeLimitMinutes !== undefined) raw.run_time_limit_minutes = layer.runTimeLimitMinutes
  if (layer.routingWeights !== undefined) {
    raw.routing_weights = layer.routingWeights
  }
  if (layer.dispatch !== undefined && Object.keys(layer.dispatch).length > 0) {
    raw.dispatch = toSnakeDispatch(layer.dispatch)
  }
  return raw
}

/**
 * Copies a persisted user-global layer without the model/provider exclusions:
 * those belong to the config root `routing.exclude` and are never recreated
 * under the legacy `tasks.settings.global.dispatch` keys. Every other field,
 * and every per-task layer, is untouched.
 */
function globalLayerWithoutRoutingExclusions(
  layer: ConfigTaskSettingsLayer,
): ConfigTaskSettingsLayer {
  if (layer.dispatch === undefined) return layer
  const { excludeModelIds: _models, excludeProviderIds: _providers, ...dispatch } = layer.dispatch
  const next: ConfigTaskSettingsLayer = { ...layer }
  if (Object.keys(dispatch).length > 0) next.dispatch = dispatch
  else delete next.dispatch
  return next
}

/** Persists the global model/provider exclusions under the neutral root
 *  `routing.exclude.models` / `routing.exclude.providers`. An absent value
 *  removes the key; an empty section is removed entirely. */
function writeRootRoutingExclusions(
  root: Record<string, unknown>,
  layer: ConfigTaskSettingsLayer | undefined,
): void {
  const models = layer?.dispatch?.excludeModelIds
  const providers = layer?.dispatch?.excludeProviderIds
  const routing: Record<string, unknown> = isRecord(root.routing) ? { ...root.routing } : {}
  const exclude: Record<string, unknown> = isRecord(routing.exclude) ? { ...routing.exclude } : {}
  if (models === undefined) delete exclude.models
  else exclude.models = [...models]
  if (providers === undefined) delete exclude.providers
  else exclude.providers = [...providers]
  if (Object.keys(exclude).length > 0) {
    routing.exclude = exclude
    root.routing = routing
    return
  }
  delete routing.exclude
  if (Object.keys(routing).length === 0) delete root.routing
  else root.routing = routing
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The authoritative origin of a definition: its registered project id, or
 *  undefined when the definition is builtin/workspace-scoped. */
function authoritativeProjectOf(summary: TaskSettingsDefinitionSummary): string | undefined {
  return summary.project !== undefined || summary.kind === 'project' ? summary.project : undefined
}

/** Stable identity of a definition independent of any snapshot project filter. */
function summaryStableIdentity(summary: TaskSettingsDefinitionSummary): string {
  const kind: 'builtin' | 'project' = summary.kind ?? (summary.project !== undefined ? 'project' : 'builtin')
  return taskSettingsIdentity({
    kind,
    name: summary.name,
    ...(kind === 'project' && summary.project !== undefined ? { project: summary.project } : {}),
  })
}

/** Read declared static fragments without invoking instruction/prompt functions.
 * Template-backed prompts share these fragments with actual execution; arbitrary
 * dynamic project prompts retain an explicit placeholder. */
export function taskInstructionTemplate(
  config: { instructions?: unknown; prompt?: unknown } | undefined,
): TaskSettingsInstructionSegment[] {
  const segments: TaskSettingsInstructionSegment[] = []
  const instructions = Array.isArray(config?.instructions) ? config.instructions : []
  for (const [index, instruction] of instructions.entries()) {
    if (typeof instruction === 'string') {
      if (instruction.trim()) {
        segments.push({ kind: 'text', source: `task.instructions[${index}]`, text: instruction })
      }
    } else if (typeof instruction === 'function') {
      segments.push({ kind: 'placeholder', source: `task.instructions[${index}]`, label: '运行时填入任务输入' })
    }
  }
  const templates = getTaskPromptTemplates(config?.prompt)
  for (const [templateIndex, template] of templates.entries()) {
    const source = `task.prompt[${templateIndex}]`
    if (template.label) segments.push({ kind: 'text', source, text: `## ${template.label}` })
    for (const [index, text] of template.strings.entries()) {
      if (text.trim()) segments.push({ kind: 'text', source: `${source}.text[${index}]`, text })
      if (index < template.strings.length - 1) {
        segments.push({ kind: 'placeholder', source: `${source}.input[${index}]`, label: template.labels?.[index] ?? '运行时填入任务输入' })
      }
    }
  }
  if (templates.length === 0) {
    segments.push({ kind: 'placeholder', source: 'task.prompt', label: '运行时根据任务输入生成任务提示' })
  }
  return segments
}

export class TaskSettingsService {
  private readonly configPath: string
  private readonly resolver: TaskDispatchResolver
  private readonly store: ForemanConfigStore
  private readonly definitions: TaskSettingsDefinitionSource
  private readonly daemonAvailability?: TaskSettingsDaemonAvailabilityCallback
  private readonly runtimeAvailability?: TaskSettingsRuntimeAvailabilityCallback
  private readonly nativeProviderReadiness?: TaskSettingsNativeProviderReadinessCallback
  private readonly clientReadiness?: TaskSettingsClientReadinessCallback
  private readonly quotaSnapshots?: AutoRoutingQuotaSnapshotService
  private readonly routeStatus?: (model: string) => GatewayRouteStatus | undefined
  private readonly now: () => number
  private readonly warnedLegacyStoredTimeouts = new Set<string>()
  /** Preview-only last-usable quota bundle and native readiness sample;
   *  scoped detail and preflight never consult them. */
  private lastQuotaPreview: AutoRoutingBoundQuotaSnapshot | undefined
  private lastNativePreview: { value: NativeProviderReadinessSnapshot; atMs: number } | undefined

  constructor(options: TaskSettingsServiceOptions) {
    this.configPath = options.configPath
    this.resolver = options.resolver
    this.store = options.store ?? new JsonForemanConfigStore()
    this.definitions = options.definitions ?? createWorkspaceDefinitionSource(options.workspaceRoot)
    this.daemonAvailability = options.daemonAvailability
    this.runtimeAvailability = options.runtimeAvailability
    this.nativeProviderReadiness = options.nativeProviderReadiness
    this.clientReadiness = options.clientReadiness
    this.quotaSnapshots = options.quotaSnapshots
    this.routeStatus = options.routeStatus
    this.now = options.now ?? (() => Date.now())
  }

  private maybeWarnStoredLegacyTimeout(identity: string, raw: unknown): void {
    if (!rawLayerDeclaresLegacyTimeout(raw)) return
    if (this.warnedLegacyStoredTimeouts.has(identity)) return
    this.warnedLegacyStoredTimeouts.add(identity)
    console.warn(
      `task-settings: ignoring stored per-task timeout for ${identity}; the global task run time limit applies`,
    )
  }

  /** The authoritative config path this daemon-owned service reads and writes. */
  get authoritativeConfigPath(): string {
    return this.configPath
  }

  /** Live provider/model metadata for selector surfaces. A pair is advertised
   *  as active only when it is dispatchable right now: the same authoritative
   *  non-billable admission the routingTest baseline applies (Wrenyard client gate
   *  plus the live runtimeAvailability probe binding the request's single quota
   *  and native-provider samples) is consulted before collapsing. Any ready
   *  supporting client admits the pair and an admin-denied native model/client
   *  is omitted; no scoring or extra price/TPS/task gate is imposed here. */
  async modelStatus(): Promise<Map<string, { effectiveTps: number | null; quotaState: 'abundant' | 'sufficient' | 'insufficient' | 'exhausted'; quotaEvidence: 'measured' | 'unknown_by_design' | 'not_obtained' }>> {
    const status = new Map<string, { effectiveTps: number | null; quotaState: 'abundant' | 'sufficient' | 'insufficient' | 'exhausted'; quotaEvidence: 'measured' | 'unknown_by_design' | 'not_obtained' }>()
    try {
      const baseline = await this.resolver.diagnose({ taskName: 'model-status', requirements: {} })
      const baselineChoices: TaskDispatchDiagnosticChoice[] = baseline.ok
        ? baseline.choices.filter((choice) => choice.available)
        : []
      const previewMemo: AutomaticPreviewMemo = { availability: new Map() }
      previewMemo.quota = this.quotaSnapshots?.routingSnapshot() ?? Promise.resolve(null)
      const needsNative = needsNativeProviderReadiness(baselineChoices.flatMap((choice) =>
        choice.baseline ? [{ ...choice.baseline, exactAgentRuntime: choice.exactAgentRuntime }] : []))
      previewMemo.nativeProviderReadiness = needsNative && this.nativeProviderReadiness
        ? Promise.resolve().then(() => this.nativeProviderReadiness!()).catch(() => null)
        : Promise.resolve(null)
      const [bound, native, clientSample] = await Promise.all([
        previewMemo.quota, previewMemo.nativeProviderReadiness, this.clientReadinessSample(previewMemo),
      ])
      const admittedChoices: TaskDispatchDiagnosticChoice[] = []
      for (const choice of baselineChoices) {
        const dispatch = choice.baseline ?? choice.admitted
        if (!dispatch) continue
        // A client that is disabled/not-installed is omitted before collapsing so
        // it can never advertise a pair as active; a ready sibling still admits
        // the same provider+model pair.
        if (!this.clientAdmitted(dispatch.client, clientSample)) continue
        const availability = await this.previewRuntimeAvailability(
          TaskSettingsService.tripleOf(dispatch),
          previewMemo,
          { codeBuddySnapshot: bound?.codeBuddySnapshot, nativeProviderReadiness: native ?? null },
        )
        if (availability?.available !== false) admittedChoices.push(choice)
      }
      for (const pair of collapseRoutingFormPairs(admittedChoices).values()) {
        status.set(`${pair.provider}/${pair.model}`, { effectiveTps: pair.effectiveTps, quotaState: 'sufficient', quotaEvidence: 'measured' })
      }
      // The shared snapshot is reused (never re-read); quota evidence remains
      // fail-closed when it cannot establish a fresh, complete constraint set.
      const snapshot = bound?.snapshot
      const now = this.now()
      if (snapshot && now <= snapshot.validUntilMs) {
        for (const [key, value] of status) {
          const slash = key.indexOf('/')
          const provider = key.slice(0, slash)
          const model = key.slice(slash + 1)
          const entry = snapshot.entries.find((entry) => entry.providerId === provider && entry.modelId === model)
            ?? snapshot.entries.find((entry) => entry.providerId === provider && entry.modelId === '*')
          const constraints = entry?.requiredQuota ?? []
          // The shared snapshot is reused (never re-read): the unified state
          // function is the only place that maps constraints to a state and how
          // it was obtained.
          const assessment = quotaStateOf(constraints, now)
          value.quotaState = assessment.state
          value.quotaEvidence = assessment.evidence
        }
      }
    } catch {
      return new Map()
    }
    return status
  }

  /** Client/provider/model/mode target of an already-resolved dispatch snapshot,
   *  used only for the non-billable live readiness probes. */
  private static tripleOf(resolved: {
    client: string
    provider: string
    model: string
    mode: 'native' | 'gateway'
  }): TaskSettingsRuntimeAvailabilityTarget {
    return {
      client: resolved.client,
      provider: resolved.provider,
      model: resolved.model,
      mode: resolved.mode,
    }
  }

  /** Authoritative Catalog display labels of an already-resolved dispatch pair;
   *  undefined when the provider/model is not in the Catalog. */
  private displayLabelsOf(resolved: { provider: string; model: string }): TaskDispatchDisplayLabels | undefined {
    return this.resolver.displayLabels({ provider: resolved.provider, model: resolved.model })
  }

  /** Maps a non-persistent public snake_case invocation layer into the canonical
   *  config layer. The invocation layer is never written to config. */
  private invocationLayerToCanonical(
    invocation: TaskSettingsLayerDto,
  ): ConfigTaskSettingsLayer {
    const raw: Record<string, unknown> = {}
    if (invocation.automatic !== undefined && invocation.automatic !== null) {
      raw.dispatch = invocation.automatic
    }
    return normalizeTaskSettingsLayer(raw, { scope: 'invocation settings' })
  }

  /** Resolves the authoritative settings for one task run at execution time.
   *  The authoritative config is read here at call time and the five layers
   *  (system defaults -> builtin Task defaults supplied by the kernel ->
   *  user global -> stable per-task identity -> invocation) merge right-wins
   *  through the config/task-settings.mts resolver — no second merge
   *  algorithm. The invocation layer is non-persistent.
   *
   *  Selection is automatic only; it resolves with the effective dispatch
   *  through `resolver.eligible` plus live availability, quota/free/cap policy
   *  and immutable ranking, and runs the same non-billable live
   *  daemon/provider readiness checks exactly once against the selected
   *  canonical target with no fallback. */
  async resolveForRun(params: TaskRunSettingsParams): Promise<TaskRunSettingsResolution> {
    const { record } = this.readConfigRecord()
    const tasks = tasksSectionOf(record)
    const kind: 'builtin' | 'project' = params.kind ?? 'builtin'
    const project = kind === 'project' ? params.project : undefined
    const identity = taskSettingsIdentity({
      kind,
      name: params.taskName,
      ...(project !== undefined ? { project } : {}),
    })

    const settingsSection = tasks?.settings
    this.maybeWarnStoredLegacyTimeout('global', settingsSection?.global)
    const byTask = settingsSection?.byTask
    if (byTask !== undefined && byTask !== null && Object.prototype.hasOwnProperty.call(byTask, identity)) {
      this.maybeWarnStoredLegacyTimeout(identity, byTask[identity])
    }

    const builtinLayer = taskDefaultsToSettingsLayer({
      dispatch: rawDefinitionDispatch(params.defaults?.dispatch),
    })

    const userTaskLayer = readPerTaskSettings(tasks, identity)

    const invocationLayer = params.invocation === undefined
      ? undefined
      : this.invocationLayerToCanonical(params.invocation)

    let effective: ReturnType<typeof resolveEffectiveTaskSettings>
    try {
      effective = resolveEffectiveTaskSettings({
        builtin: builtinLayer,
        userGlobal: readGlobalTaskSettings(tasks, record) ?? undefined,
        userTask: userTaskLayer,
        ...(invocationLayer !== undefined ? { invocation: invocationLayer } : {}),
      })
    } catch (error) {
      throw new TaskSettingsInvalidSettingsError(undefined, messageOf(error))
    }

    // Automatic selection only: the effective dispatch is forwarded to the
    // shared automatic-selection path (resolver.eligible + live availability +
    // quota/free/cap policy + immutable ranking). Readiness already ran for
    // every exact choice before ranking, so there is NO second post-selection
    // runtimeAvailability call and no fallback after selection.
    const routingRequirements = applyMountedFeatureRoutingPreferences(effective.dispatch, params.mountedFeatures)
    const selection = await this.resolveAutomaticSelection({
      taskName: params.taskName,
      requirements: this.withRoleRoutingExclusions(
        { ...routingRequirements, inputTokens: params.inputTokens },
        params.taskName,
        readRoutingExclusions(record),
      ),
      timeoutMs: effective.runTimeLimitMinutes * MS_PER_MINUTE,
      routingWeights: effective.routingWeights,
    })
    if (!selection.ok) throw selection.error
    return {
      exactAgentRuntime: selection.exactAgentRuntime,
      dispatch: selection.dispatch,
      ...(selection.codeBuddyExecution
        ? { codeBuddyExecution: selection.codeBuddyExecution }
        : {}),
      runTimeLimitMinutes: effective.runTimeLimitMinutes,
      sources: toRunSources(effective.sources),
    }
  }

  async snapshot(params: TaskSettingsSnapshotParams = {}): Promise<TaskSettingsSnapshotResult> {
    const { record, revision } = this.readConfigRecord()
    const tasks = tasksSectionOf(record)
    const snapshotSettingsSection = tasks?.settings
    this.maybeWarnStoredLegacyTimeout('global', snapshotSettingsSection?.global)
    const snapshotByTask = snapshotSettingsSection?.byTask
    if (
      snapshotByTask !== undefined &&
      snapshotByTask !== null &&
      typeof snapshotByTask === 'object' &&
      !Array.isArray(snapshotByTask)
    ) {
      for (const storedIdentity of Object.keys(snapshotByTask)) {
        if (Object.prototype.hasOwnProperty.call(snapshotByTask, storedIdentity)) {
          this.maybeWarnStoredLegacyTimeout(
            storedIdentity,
            (snapshotByTask as Record<string, unknown>)[storedIdentity],
          )
        }
      }
    }
    const userGlobal = readGlobalTaskSettings(tasks, record)

    const summaries = await this.collectSnapshotSummaries(params)
    // Request-scoped preview memo for this snapshot request only: automatic
    // rows reuse one immutable quota snapshot and one readiness probe per
    // canonical runtime, so the list never repeats quota/credential reads. Rows
    // build concurrently and Promise.all keeps the exact summary order.
    const previewMemo: AutomaticPreviewMemo = { availability: new Map() }
    const filteredSummaries = summaries.filter((summary) => {
      if (params.task_id === undefined) return true
      const kind: 'builtin' | 'project' = summary.kind
        ?? (summary.project !== undefined || params.project !== undefined ? 'project' : 'builtin')
      const identity = taskSettingsIdentity({
        kind,
        name: summary.name,
        ...(kind === 'project' ? { project: summary.project ?? params.project } : {}),
      })
      return summary.name === params.task_id || identity === params.task_id
    })
    // Read the routing exclusions/config once per snapshot; row construction
    // and automatic preview consume the same immutable parse.
    const routingExclusions = readRoutingExclusions(record)
    // Builtin definition metadata (prompt payload) is rendered only on the
    // scoped task detail; unscoped list rows omit it entirely.
    const includeBuiltinMetadata = params.task_id !== undefined
    const rows = await Promise.all(
      filteredSummaries.map((summary) => this.buildRow(
        summary,
        params.project,
        tasks,
        userGlobal,
        previewMemo,
        routingExclusions,
        includeBuiltinMetadata,
      )),
    )

    const loadErrors = this.definitions.listLoadErrors !== undefined
      ? await this.definitions.listLoadErrors()
      : undefined
    // Load errors stay separate from executable rows; a project-scoped snapshot
    // keeps only the errors whose owning project matches the request.
    const scopedLoadErrors = loadErrors === undefined
      ? undefined
      : params.project === undefined
        ? loadErrors
        : loadErrors.filter((error) => error.project === params.project)

    return {
      config_path: this.configPath,
      revision,
      ...(params.project !== undefined ? { project: params.project } : {}),
      user_global: this.toLayerDto(userGlobal),
      rows,
      ...(scopedLoadErrors !== undefined && scopedLoadErrors.length > 0
        ? { load_errors: scopedLoadErrors }
        : {}),
    }
  }

  /** Collects the definitions backing one snapshot.
   *
   *  Scoped snapshots (a project filter) keep the historic behavior: the
   *  source's project listing is used as-is. Unscoped snapshots enumerate the
   *  builtin list exactly once and then, for every project registered in
   *  project discovery, only the definitions whose authoritative source is
   *  that exact project — inherited builtins are never duplicated under a
   *  project. Results are deduplicated by stable identity and project rows are
   *  decorated with their authoritative `.fmproj` display label. */
  private async collectSnapshotSummaries(
    params: TaskSettingsSnapshotParams,
  ): Promise<TaskSettingsDefinitionSummary[]> {
    if (params.project === undefined && this.definitions.listProjects !== undefined) {
      const [unscoped, projects] = await Promise.all([
        this.definitions.list(undefined),
        this.definitions.listProjects(),
      ])
      const builtins = unscoped.filter((summary) => authoritativeProjectOf(summary) === undefined)
      const grouped: TaskSettingsDefinitionSummary[] = [...builtins]
      const seen = new Set(builtins.map((summary) => summaryStableIdentity(summary)))
      for (const project of projects) {
        let projectDefs: TaskSettingsDefinitionSummary[]
        try {
          projectDefs = (await this.definitions.list(project.id)).filter(
            (summary) => authoritativeProjectOf(summary) === project.id,
          )
        } catch {
          // A discovered project without resolvable task metadata contributes
          // nothing; it never fails the whole snapshot.
          projectDefs = []
        }
        for (const summary of projectDefs) {
          const identity = summaryStableIdentity(summary)
          if (seen.has(identity)) continue
          seen.add(identity)
          grouped.push(
            project.displayName !== undefined && summary.projectDisplayName === undefined
              ? { ...summary, projectDisplayName: project.displayName }
              : summary,
          )
        }
      }
      return grouped
    }

    const summaries = await this.definitions.list(params.project)
    if (params.project !== undefined && this.definitions.listProjects !== undefined) {
      const label = (await this.definitions.listProjects()).find(
        (project) => project.id === params.project,
      )?.displayName
      if (label !== undefined) {
        return summaries.map((summary) =>
          authoritativeProjectOf(summary) === params.project && summary.projectDisplayName === undefined
            ? { ...summary, projectDisplayName: label }
            : summary,
        )
      }
    }
    return summaries
  }

  /**
   * Read-only FORM-BASED routing diagnostic. The caller submits the automatic
   * dispatch form fields directly (`params.automatic`) plus an optional
   * timeout; the diagnostic NEVER enumerates task definitions and NEVER reads
   * global/per-task saved settings, with one weights-and-exclusions exception:
   * the current global routing weights and the current global routing
   * exclusions (config root `routing.exclude`, projected onto the global
   * layer's `dispatch`) are read once per request and passed identically to
   * the baseline and form passes, so scoring always matches the configured
   * (or default) weights and globally excluded providers/models are never
   * ranked as selectable. Global exclusions are unioned and deduplicated with
   * the form-submitted exclusion ids; no other global dispatch field is
   * merged. All other saved global/per-task settings stay ignored here. Only
   * the submitted form is normalized
   * (recommended intelligence expectation defaulting to `mid`, no hard minimum,
   * timeout defaulting to the system default).
   *
   * Baseline provider availability is established FIRST with no submitted
   * requirements, so a provider-ready pair rejected by a submitted task gate
   * still surfaces as a rejected row. Qualified pairs reuse the exact
   * production automatic-selection path (`resolveAutomaticSelection`) and keep
   * the production ranks/weights; rejected pairs carry a short Chinese reason.
   * Clients are never projected: rows collapse at provider+model and any ready
   * supporting client can admit the pair. No inference, save, reserve, or
   * model call happens here — only fresh non-billable readonly quota/readiness
   * sampling.
   */
  async routingTest(params: TaskRoutingTestParams): Promise<TaskRoutingTestResult> {
    // Weights-and-exclusions exception: read the current global layer once per
    // request; both passes below use this identical weight set and this
    // identical global routing exclusion set.
    const currentRecord = this.readConfigRecord().record
    const routingTestSettingsSection = tasksSectionOf(currentRecord)?.settings
    this.maybeWarnStoredLegacyTimeout('global', routingTestSettingsSection?.global)
    const globalSettings = readGlobalTaskSettings(tasksSectionOf(currentRecord), currentRecord)
    const routingWeights = globalSettings?.routingWeights
    const requirements = mergeRoutingExclusions(routingFormRequirements(params.automatic), globalSettings?.dispatch)
    const timeoutMs = typeof params.timeout_ms === 'number' && params.timeout_ms >= 1
      ? params.timeout_ms
      : ROUTING_TEST_DEFAULT_TIMEOUT_MS

    // Baseline availability with NO submitted gates: `diagnose` evaluates each
    // exact pair's availability against empty requirements (so a pair rejected
    // by a submitted gate still reports available) and independently replays
    // the submitted form to attach its first closed rejection code.
    const baseline = await this.resolver.diagnose({ taskName: ROUTING_FORM_TASK_NAME, requirements })
    const baselineChoices: TaskDispatchDiagnosticChoice[] = baseline.ok ? baseline.choices.filter((choice) => choice.available) : []

    // Production automatic selection over the submitted form, instrumented with
    // the shared trace so ranks/factors are the real scorer output. Preview
    // memo shares one immutable quota snapshot for the single request.
    const previewMemo: AutomaticPreviewMemo = { availability: new Map() }
    // Bind availability for the unconstrained pool before applying the form.
    // Both passes share quota/readiness snapshots and memoized non-billable probes.
    await this.resolveAutomaticSelection({ taskName: ROUTING_FORM_TASK_NAME, requirements: {}, timeoutMs, routingWeights }, previewMemo)
    const bound = await previewMemo.quota
    const native = await previewMemo.nativeProviderReadiness
    const clientSample = await this.clientReadinessSample(previewMemo)
    const availableChoices: TaskDispatchDiagnosticChoice[] = []
    for (const choice of baselineChoices) {
      const dispatch = choice.baseline ?? choice.admitted
      if (!dispatch) continue
      // The authoritative client gate applies to the routingTest baseline too,
      // so a pair whose only client is disabled/not-installed is omitted
      // before the rows are assembled (never hidden by a missing sibling).
      if (!this.clientAdmitted(dispatch.client, clientSample)) continue
      const availability = await this.previewRuntimeAvailability(TaskSettingsService.tripleOf(dispatch), previewMemo, {
        codeBuddySnapshot: bound?.codeBuddySnapshot,
        nativeProviderReadiness: native ?? null,
      })
      if (availability?.available !== false) availableChoices.push(choice)
    }
    const trace: AutomaticSelectionTrace = {
      capUsdPerMillion: null,
      eligibleIds: [],
      quotaBlockedIds: [],
      readinessRejectedIds: [],
      circuitBlockedIds: [],
      collapsedChoices: [],
      unscorable: [],
      catalogExcluded: [],
      ranked: [],
      scored: 0,
      snapshotId: null,
      nowMs: this.now(),
    }
    await this.resolveAutomaticSelection({
      taskName: ROUTING_FORM_TASK_NAME,
      requirements,
      timeoutMs,
      routingWeights,
    }, previewMemo, trace)

    return { rows: buildRoutingFormRows(availableChoices, trace, this.resolver, requirements) }
  }

  /** Lists the EFFECTIVE automatic configuration of ALL valid builtin and
   *  project tasks for the routing form import combobox. This is a separate,
   *  lazy, read-only endpoint: it enumerates definitions through the same
   *  `collectSnapshotSummaries` path the snapshot uses and layers this
   *  machine's user-global and per-task settings over each definition, so an
   *  imported task carries the constraints it would really dispatch under —
   *  a locally excluded provider reaches the form instead of being silently
   *  dropped. It resolves no runtime and performs no inference, save, or
   *  reserve. */
  async routingTestTasks(_params: TaskRoutingTestTasksParams = {}): Promise<TaskRoutingTestTasksResult> {
    const currentRecord = this.readConfigRecord().record
    const settings = tasksSectionOf(currentRecord)
    const routingTestTasksSettingsSection = settings?.settings
    this.maybeWarnStoredLegacyTimeout('global', routingTestTasksSettingsSection?.global)
    const routingTestTasksByTask = routingTestTasksSettingsSection?.byTask
    if (
      routingTestTasksByTask !== undefined &&
      routingTestTasksByTask !== null &&
      typeof routingTestTasksByTask === 'object' &&
      !Array.isArray(routingTestTasksByTask)
    ) {
      for (const storedIdentity of Object.keys(routingTestTasksByTask)) {
        if (Object.prototype.hasOwnProperty.call(routingTestTasksByTask, storedIdentity)) {
          this.maybeWarnStoredLegacyTimeout(
            storedIdentity,
            (routingTestTasksByTask as Record<string, unknown>)[storedIdentity],
          )
        }
      }
    }
    const userGlobal = readGlobalTaskSettings(settings, currentRecord) ?? undefined
    const summaries = await this.collectSnapshotSummaries({})
    const tasks: TaskRoutingTestTask[] = summaries.map((summary) => {
      const kind: 'builtin' | 'project' = summary.kind
        ?? (summary.project !== undefined ? 'project' : 'builtin')
      const identity = taskSettingsIdentity({
        kind,
        name: summary.name,
        ...(kind === 'project' && summary.project !== undefined ? { project: summary.project } : {}),
      })
      const builtin = taskDefaultsToSettingsLayer(this.summaryDefaults(summary))
      // One unreadable stored layer must not fail the whole import list; that
      // task falls back to its definition and the snapshot reports the issue.
      let effective: ReturnType<typeof resolveEffectiveTaskSettings>
      try {
        effective = resolveEffectiveTaskSettings({
          builtin,
          userGlobal,
          userTask: readPerTaskSettings(settings, identity),
        })
      } catch {
        effective = resolveEffectiveTaskSettings({ builtin })
      }
      return {
        identity,
        name: summary.name,
        display_name: summary.displayName ?? summary.name,
        ...(summary.project !== undefined ? { project: summary.project } : {}),
        automatic: toSnakeDispatch(effective.dispatch),
        // The system fallback timeout is not a declared constraint, so it stays
        // out of the form and leaves the field blank.
      }
    })
    return { tasks }
  }

  /** Precise client-gate rejection message for one client from the shared
   *  readiness sample; undefined when the client is admitted. Mirrors the
   *  disabled/not-installed/unknown wording `assertLiveRuntimeAvailability`
   *  throws, so discovery and run admission never disagree. */
  private clientRejectionReason(
    client: string,
    sample: ClientReadinessSnapshot | null,
  ): string | undefined {
    if (this.clientReadiness === undefined) return undefined
    if (sample === null) return `client '${client}' readiness could not be determined`
    const state = sample.clientsById[client]
    if (state === undefined) return `client '${client}' is unknown to Wrenyard`
    if (!state.enabled) return `client '${client}' is disabled in config`
    if (!state.installed) return `client '${client}' is not installed`
    return undefined
  }

  private async definitionDetailOrUndefined(
    summary: TaskSettingsDefinitionSummary,
    project: string | undefined,
  ): Promise<TaskSettingsDefinitionDetail | undefined> {
    const kind: 'builtin' | 'project' = summary.kind
      ?? (summary.project !== undefined || project !== undefined ? 'project' : 'builtin')
    try {
      return await this.definitions.describe(
        summary.name,
        kind === 'project' ? summary.project ?? project : project,
      )
    } catch {
      return undefined
    }
  }

  async save(params: TaskSettingsSaveParams): Promise<TaskSettingsSnapshotResult> {
    if (params.scope === 'task') {
      const taskId = params.task_id?.trim() ?? ''
      if (!taskId) throw new TaskSettingsTaskNotFoundError(params.task_id ?? '')
      const summaries = await this.definitions.list(params.project)
      const summary = summaries.find((entry) => {
        if (entry.name === taskId) return true
        const kind: 'builtin' | 'project' = entry.kind
          ?? (entry.project !== undefined || params.project !== undefined ? 'project' : 'builtin')
        return taskSettingsIdentity({
          kind,
          name: entry.name,
          ...(kind === 'project' ? { project: entry.project ?? params.project } : {}),
        }) === taskId
      })
      if (!summary) throw new TaskSettingsTaskNotFoundError(params.task_id ?? '')
      return this.saveTask(params, summary)
    }
    return this.saveGlobal(params)
  }

  private async saveGlobal(params: TaskSettingsSaveParams): Promise<TaskSettingsSnapshotResult> {
    const current = this.readConfigRecord()
    if (current.revision !== params.expected_revision) {
      throw new TaskSettingsContentConflictError(params.expected_revision, current.revision)
    }

    const tasks = tasksSectionOf(current.record)
    const saveGlobalSettingsSection = tasks?.settings
    this.maybeWarnStoredLegacyTimeout('global', saveGlobalSettingsSection?.global)
    const existingGlobal = readGlobalTaskSettings(tasks, current.record)
    const nextGlobal = this.applyPatchToLayer(existingGlobal, params.patch)

    this.writeRecordMutation(current.record, (settings, root) => {
      // The global model/provider exclusions live only at the config root
      // `routing.exclude`; the legacy global `dispatch` keys are never
      // written back.
      writeRootRoutingExclusions(root, nextGlobal)
      if (nextGlobal === undefined) {
        delete settings.global
      } else {
        settings.global = globalLayerWithoutRoutingExclusions(nextGlobal)
      }
    })
    return this.snapshot({ project: params.project })
  }

  private async saveTask(
    params: TaskSettingsSaveParams,
    summary: TaskSettingsDefinitionSummary,
  ): Promise<TaskSettingsSnapshotResult> {
    if (params.patch.routing_weights !== undefined) {
      throw new TaskSettingsInvalidSettingsError(
        'routing_weights is global-only and cannot be applied at task scope',
      )
    }
    if (params.patch.run_time_limit_minutes !== undefined) {
      throw new TaskSettingsInvalidSettingsError(
        'run_time_limit_minutes is global-only and cannot be applied at task scope',
      )
    }
    const taskName = summary.name
    const current = this.readConfigRecord()
    if (current.revision !== params.expected_revision) {
      throw new TaskSettingsContentConflictError(params.expected_revision, current.revision)
    }

    const kind: 'builtin' | 'project' = summary.kind
      ?? (summary.project !== undefined || params.project !== undefined ? 'project' : 'builtin')
    const identity = taskSettingsIdentity({
      kind,
      name: taskName,
      ...(kind === 'project' ? { project: summary.project ?? params.project } : {}),
    })

    const tasks = tasksSectionOf(current.record)
    const saveTaskSettingsSection = tasks?.settings
    const saveTaskByTask = saveTaskSettingsSection?.byTask
    if (
      saveTaskByTask !== undefined &&
      saveTaskByTask !== null &&
      Object.prototype.hasOwnProperty.call(saveTaskByTask, identity)
    ) {
      this.maybeWarnStoredLegacyTimeout(identity, (saveTaskByTask as Record<string, unknown>)[identity])
    }
    const baselineLayer = readPerTaskSettings(tasks, identity)
    const nextLayer = this.applyPatchToLayer(baselineLayer, params.patch)

    if (nextLayer !== undefined) {
      const builtinLayer = taskDefaultsToSettingsLayer({
        dispatch: rawDefinitionDispatch(summary.dispatch),
      })
      try {
        resolveEffectiveTaskSettings({
          builtin: builtinLayer,
          userGlobal: readGlobalTaskSettings(tasks, current.record) ?? undefined,
          userTask: nextLayer,
        })
      } catch (error) {
        throw new TaskSettingsInvalidSettingsError(undefined, messageOf(error))
      }
    }

    this.writeRecordMutation(current.record, (settings, root) => {
      const byTask = ensureByTaskMap(settings)
      if (nextLayer === undefined) {
        delete byTask[identity]
      } else {
        byTask[identity] = nextLayer
      }
      cleanupEmptyByTask(settings, byTask, root)
    })
    return this.snapshot({ project: params.project, task_id: identity })
  }

  private summaryDefaults(summary: TaskSettingsDefinitionSummary, detail?: TaskSettingsDefinitionDetail): {
    dispatch: ConfigTaskDispatchRequirements
  } {
    return {
      dispatch: rawDefinitionDispatch(summary.dispatch ?? detail?.dispatch),
    }
  }

  private async buildRow(
    summary: TaskSettingsDefinitionSummary,
    project: string | undefined,
    tasks: TasksConfigSettingsInput | undefined,
    userGlobal: ConfigTaskSettingsLayer | undefined,
    previewMemo: AutomaticPreviewMemo | undefined,
    routingExclusions: ReturnType<typeof readRoutingExclusions> | undefined,
    includeBuiltinMetadata: boolean,
  ): Promise<TaskSettingsTaskRow> {
    const issues: TaskSettingsValidationIssue[] = []
    const kind: 'builtin' | 'project' = summary.kind
      ?? (summary.project !== undefined || project !== undefined ? 'project' : 'builtin')
    const identity = taskSettingsIdentity({
      kind,
      name: summary.name,
      ...(kind === 'project' ? { project: summary.project ?? project } : {}),
    })

    // Rows run on the list summary the source already produced; an extra
    // per-row describe is reserved for the scoped detail below.
    const builtinLayer = taskDefaultsToSettingsLayer(this.summaryDefaults(summary))

    const userTaskLayer = readPerTaskSettings(tasks, identity)

    let effective: ReturnType<typeof resolveEffectiveTaskSettings>
    try {
      effective = resolveEffectiveTaskSettings({
        builtin: builtinLayer,
        userGlobal: userGlobal ?? undefined,
        userTask: userTaskLayer,
      })
    } catch (error) {
      issues.push({ code: 'invalid_settings', message: messageOf(error) })
      effective = resolveEffectiveTaskSettings({})
    }

    const projectName = kind === 'project' ? summary.project ?? project : undefined
    const automatic = toEffectiveAutomatic(effective.dispatch, effective.sources.dispatch)

    let automaticSelection: TaskSettingsAutomaticSelection | undefined
    let builtin: TaskSettingsTaskRow['builtin'] | undefined
    let inheritanceChain = summary.inheritanceChain
    if (includeBuiltinMetadata) {
      // Scoped detail rows only: automatic-selection preview and builtin payload.
      try {
        const selection = await this.previewAutomaticSelection(previewMemo, {
          taskName: summary.name,
          requirements: this.withRoleRoutingExclusions(effective.dispatch, summary.name, routingExclusions),
          timeoutMs: effective.runTimeLimitMinutes * MS_PER_MINUTE,
          routingWeights: effective.routingWeights,
        })
        if (selection.ok) {
          const labels = this.displayLabelsOf(selection.dispatch)
          automaticSelection = {
            exact_runtime: selection.exactAgentRuntime,
            resolved: labels
              ? {
                  ...selection.dispatch,
                  provider_display_name: labels.providerDisplayName,
                  model_display_name: labels.modelDisplayName,
                }
              : selection.dispatch,
            reason: selection.reason,
          }
        } else {
          const failure = taskResolutionFailure(selection.error.resolutionFailureCode)
          issues.push({
            code: 'automatic_dispatch_unavailable',
            message: failure.message,
            resolutionFailure: failure,
          })
        }
      } catch {
        const failure = taskResolutionFailure('no_available_provider')
        issues.push({
          code: 'automatic_dispatch_unavailable',
          message: failure.message,
          resolutionFailure: failure,
        })
      }

      const detail = await this.definitionDetailOrUndefined(summary, project)
      const source = summary.source ?? detail?.source ?? ''
      const description = summary.description ?? detail?.description
      const instructionTemplate = summary.instructionTemplate ?? detail?.instructionTemplate ?? []
      inheritanceChain = summary.inheritanceChain ?? detail?.inheritanceChain
      builtin = {
        identity,
        name: summary.name,
        source,
        ...(description !== undefined ? { description } : {}),
        ...(projectName !== undefined ? { project: projectName } : {}),
        prompt_template: summary.promptTemplate ?? detail?.promptTemplate ?? 'dynamic',
        instruction_template: instructionTemplate,
        dispatch: toSnakeDispatch(builtinLayer.dispatch ?? {}),
      }
    }

    return {
      identity,
      name: summary.name,
      display_name: summary.displayName ?? summary.name,
      ...(projectName !== undefined ? { project: projectName } : {}),
      ...(kind === 'project'
        ? { project_display_name: summary.projectDisplayName ?? projectName ?? '' }
        : {}),
      ...(builtin !== undefined ? { builtin } : {}),
      user_task: this.toLayerDto(userTaskLayer),
      effective: {
        run_time_limit_minutes: { value: effective.runTimeLimitMinutes, source: toSourceLayer(effective.sources.runTimeLimitMinutes) },
        ...(effective.routingWeights !== undefined
          ? {
              routing_weights: {
                value: effective.routingWeights,
                source: toSourceLayer(effective.sources.routingWeights),
              },
            }
          : {}),
        automatic,
      },
      ...(automaticSelection !== undefined ? { automatic_selection: automaticSelection } : {}),
      ...(inheritanceChain !== undefined ? { inheritanceChain } : {}),
      issues,
    }
  }

  /** Non-billable live daemon admission, authoritative client readiness, and
   *  provider credential/route availability check against an already-selected
   *  runtime. No paid probe is ever issued, an unknown quota is never treated
   *  as available (or zero), and failure never falls back to another candidate.
   *  A client that is not admitted reports a precise disabled/not-installed/
   *  query-unavailable message instead of an opaque provider-unavailable one. */
  private async assertLiveRuntimeAvailability(
    taskId: string,
    runtimeId: string,
    triple: TaskSettingsRuntimeAvailabilityTarget,
  ): Promise<TaskSettingsProviderAvailability | undefined> {
    if (this.daemonAvailability) {
      const daemon = await this.daemonAvailability()
      if (!daemon.accepting && daemon.known !== false) {
        throw new TaskSettingsRuntimeUnavailableError(taskId, runtimeId, 'daemon is not accepting new task runs')
      }
    }
    if (this.clientReadiness !== undefined) {
      const sample = await this.clientReadinessSample()
      if (sample === null) {
        throw new TaskSettingsRuntimeUnavailableError(
          taskId,
          runtimeId,
          `client '${triple.client}' readiness could not be determined`,
        )
      }
      const state = sample.clientsById[triple.client]
      if (state === undefined) {
        throw new TaskSettingsRuntimeUnavailableError(
          taskId,
          runtimeId,
          `client '${triple.client}' is unknown to Wrenyard`,
        )
      }
      if (!state.enabled) {
        throw new TaskSettingsRuntimeUnavailableError(
          taskId,
          runtimeId,
          `client '${triple.client}' is disabled in config`,
        )
      }
      if (!state.installed) {
        throw new TaskSettingsRuntimeUnavailableError(
          taskId,
          runtimeId,
          `client '${triple.client}' is not installed`,
        )
      }
    }
    // Explicit execution availability observes the shared Gateway route circuit
    // for Gateway-backed targets: an open route, or a half-open route whose
    // recovery probe is not yet due, is unavailable. A native target never
    // consults Gateway faults, and a due half-open route remains available so
    // the Gateway's own bounded probe can recover it.
    if (triple.mode === 'gateway' && !this.gatewayRouteAdmitted(triple.provider, triple.model, this.now())) {
      throw new TaskSettingsRuntimeUnavailableError(
        taskId,
        runtimeId,
        `gateway route '${triple.provider}/${triple.model}' is not currently available`,
      )
    }
    if (this.runtimeAvailability) {
      const availability = await this.runtimeAvailability(triple)
      if (!availability.available) {
        throw new TaskSettingsRuntimeUnavailableError(
          taskId,
          runtimeId,
          availability.reason ?? `provider '${triple.provider}' is not currently available`,
        )
      }
      return availability
    }
    return undefined
  }

  /** One authoritative client-readiness sample bound to a single
   *  evaluation. When a request-scoped preview memo is supplied (automatic
   *  snapshot rows), the same immutable sample is shared by every relevant row
   *  in the request; runs/save preflight pass no memo and sample fresh. A
   *  rejected query resolves to null so callers fail closed. */
  private async clientReadinessSample(
    previewMemo?: AutomaticPreviewMemo,
  ): Promise<ClientReadinessSnapshot | null> {
    if (this.clientReadiness === undefined) return null
    if (previewMemo === undefined) return this.loadClientReadiness()
    const pending = previewMemo.clientReadiness
      ?? (previewMemo.clientReadiness = this.loadClientReadiness())
    return await pending
  }

  private async loadClientReadiness(): Promise<ClientReadinessSnapshot | null> {
    try {
      return await this.clientReadiness!()
    } catch {
      return null
    }
  }

  /** Authoritative admission for one client: enabled AND installed, per the
   *  client-readiness sample. When the callback is configured, a null
   *  sample (failed query) and an unknown client both fail closed. When no
   *  callback is configured the gate is inert for isolation. */
  private clientAdmitted(
    client: string,
    sample: ClientReadinessSnapshot | null,
  ): boolean {
    if (this.clientReadiness === undefined) return true
    if (sample === null) return false
    const state = sample.clientsById[client]
    if (state === undefined) return false
    return state.enabled && state.installed
  }

  /** Gateway route circuit admission for one public shared `provider/model`.
   *  Only Gateway-backed candidates consult this; native routes never do. */
  private gatewayRouteAdmitted(provider: string, model: string, nowMs: number): boolean {
    return this.taskRouteAdmitted(this.routeStatus?.(`${provider}/${model}`))
  }

  /** Shared-route admission for a native candidate, mirroring the launch guard:
   *  any shared route that is not closed refuses a native attempt. */
  private nativeSharedRouteAdmitted(provider: string, model: string): boolean {
    const status = this.routeStatus?.(`${provider}/${model}`)
    return status === undefined || status.phase === 'closed'
  }

  /** Route admission for one route status: a route an open fault blocks is rejected. */
  private taskRouteAdmitted(status: GatewayRouteStatus | undefined): boolean {
    return status?.phase !== 'open'
  }

  /** Non-billable live provider credential/route readiness for one canonical
   *  runtime triple. When a request-scoped preview memo is supplied (automatic
   *  snapshot rows only), each runtime is probed at most once and the same
   *  resolved evidence is shared by every automatic row in the request. The
   *  run/save-preflight paths pass no memo and keep probing fresh per call. */
  private async previewRuntimeAvailability(
    runtime: TaskSettingsRuntimeAvailabilityTarget,
    previewMemo?: AutomaticPreviewMemo,
    context?: TaskSettingsRuntimeAvailabilityContext,
  ): Promise<TaskSettingsProviderAvailability | undefined> {
    if (!this.runtimeAvailability) return undefined
    if (previewMemo === undefined) return await this.runtimeAvailability(runtime, context)
    const key = runtimeTripleKey(runtime)
    let memoized = previewMemo.availability.get(key)
    if (memoized === undefined) {
      memoized = Promise.resolve(this.runtimeAvailability(runtime, context))
      previewMemo.availability.set(key, memoized)
    }
    return await memoized
  }

  /** One immutable automatic selection: the shared quota/free/cap/client
   *  policy path used by both resolveForRun and automatic snapshot row preview.
   *
   *  Exactly one AutoRoutingQuotaSnapshot is obtained per call. When eligible
   *  native Codex/Cursor choices exist, exactly one bounded Wrenyard provider
   *  readiness snapshot is also obtained; both immutable samples are bound to
   *  the same evaluation. With a request-scoped preview memo (snapshot rows),
   *  those samples are shared by every relevant automatic row. Static hard gates
   *  come from `resolver.eligible`; every exact choice is then filtered through
   *  the live runtimeAvailability callback before ranking (absent callback
   *  stays backward-compatible available; `available: false` is excluded) and
   *  through the snapshot's hard-blocked providers. Preview memoization keys
   *  that probe by canonical runtime so identical credential reads are never
   *  repeated across automatic rows; runs/save preflight pass no memo and probe
   *  fresh each call. Only variants sharing the same canonical provider+model
   *  AND the same reference pricing identity collapse (native then grok then
   *  stable other client). The effective cap is the min of the defined
   *  task/global caps; when neither is defined the maximum admitted finite
   *  reference output price is used only as non-rejecting score normalization.
   *  rankAutomaticTaskCandidates runs once and the matching exact choice is
   *  selected with no fallback. */
  /** Adds the per-role exclusions of `routing.exclude.roles.<role>` to the
   *  requirements handed to automatic selection. The lists are read from the
   *  neutral config root in memory only and are never written back into any
   *  settings layer; they extend whatever the requirements already carry, and
   *  an absent role entry leaves them unchanged. */
  private withRoleRoutingExclusions(
    requirements: ConfigTaskDispatchRequirements,
    role: string,
    exclusions?: ReturnType<typeof readRoutingExclusions>,
  ): ConfigTaskDispatchRequirements {
    const roleEntry = (exclusions ?? readRoutingExclusions(this.readConfigRecord().record))?.roles?.[role]
    if (roleEntry === undefined) return requirements
    const models = roleEntry.models
    const providers = roleEntry.providers
    if (models === undefined && providers === undefined) return requirements
    return {
      ...requirements,
      ...(models !== undefined
        ? { excludeModelIds: [...(requirements.excludeModelIds ?? []), ...models] }
        : {}),
      ...(providers !== undefined
        ? { excludeProviderIds: [...(requirements.excludeProviderIds ?? []), ...providers] }
        : {}),
    }
  }

  /** Preview-only quota read: an expired shared snapshot is served stale when
   *  a prior value exists while a single background refresh is started for the
   *  next request; absent the service or prior value it reads fresh. */
  private previewQuotaSnapshot(
    previewMemo: AutomaticPreviewMemo,
  ): Promise<AutoRoutingBoundQuotaSnapshot | null> {
    if (this.quotaSnapshots === undefined) return Promise.resolve(null)
    const refresh = (): Promise<AutoRoutingBoundQuotaSnapshot | null> =>
      this.quotaSnapshots!.routingSnapshot()
        .then((bound) => {
          this.lastQuotaPreview = bound
          return bound
        })
        .catch(() => null)
    const last = this.lastQuotaPreview
    if (last !== undefined) {
      if (last.snapshot.validUntilMs > this.now()) return Promise.resolve(last)
      // Expired preview: serve the prior value and re-validate in the
      // background; one request shares one in-flight refresh.
      const pending = previewMemo.refresh ?? (previewMemo.refresh = refresh())
      void pending
      return Promise.resolve(last)
    }
    const pending = previewMemo.refresh ?? (previewMemo.refresh = refresh())
    return pending
  }

  /** Preview-only native readiness read: the last usable sample is served
   *  stale while a background refresh re-arms the memo promise. */
  private previewNativeProviderReadiness(
    previewMemo: AutomaticPreviewMemo,
  ): Promise<NativeProviderReadinessSnapshot | null> {
    const started = Promise.resolve()
      .then(() => this.nativeProviderReadiness!())
      .then((value) => {
        this.lastNativePreview = { value, atMs: this.now() }
        return value
      })
      .catch(() => null)
    const last = this.lastNativePreview
    if (last !== undefined && this.now() - last.atMs > 60_000) {
      // Stale preview sample: serve it and refresh in the background so the
      // next preview observes the re-armed value.
      void started
      return Promise.resolve(last.value)
    }
    return started
  }

  /** Snapshot-row entry point into automatic selection: identical effective
   *  inputs share one resolver run inside the request. Shared results are
   *  never mutated here. */
  private previewAutomaticSelection(
    previewMemo: AutomaticPreviewMemo | undefined,
    params: AutomaticSelectionParams,
    trace?: AutomaticSelectionTrace,
  ): Promise<AutomaticSelectionResult> {
    if (previewMemo === undefined) return this.resolveAutomaticSelection(params, previewMemo, trace)
    const key = automaticSelectionKey(params)
    const selections = previewMemo.selections ?? (previewMemo.selections = new Map())
    let pending = selections.get(key)
    if (pending === undefined) {
      pending = this.resolveAutomaticSelection(params, previewMemo, trace)
      selections.set(key, pending)
    }
    return pending
  }

  private async resolveAutomaticSelection(
    params: AutomaticSelectionParams,
    previewMemo?: AutomaticPreviewMemo,
    trace?: AutomaticSelectionTrace,
  ): Promise<AutomaticSelectionResult> {
    // Automatic price admission is finalized below from the request-time
    // horizon snapshot. Omitting only the price ceiling here lets a scheduled
    // DeepSeek tariff replace stale Catalog metadata; every non-DeepSeek
    // candidate is still checked against the same static reference by policy.
    const { maxOutputUsdPerMillion: _catalogPriceCeiling, ...intrinsicRequirements } = params.requirements
    const eligible = await this.resolver.eligible({ taskName: params.taskName, requirements: intrinsicRequirements })
    if (!eligible.ok) {
      if (trace !== undefined) {
        trace.eligibleFailure = {
          code: eligible.error.resolutionFailureCode,
          message: eligible.error.message,
          candidateCount: eligible.error.candidates.length,
        }
      }
      return { ok: false, error: eligible.error }
    }
    if (trace !== undefined) trace.eligibleIds = eligible.choices.map((choice) => choice.exactAgentRuntime)

    const quotaPromise = previewMemo?.quota
      ?? (previewMemo !== undefined
        ? this.previewQuotaSnapshot(previewMemo)
        : this.quotaSnapshots
          ? this.quotaSnapshots.routingSnapshot()
          : Promise.resolve(null))
    if (previewMemo !== undefined) previewMemo.quota = quotaPromise

    const needsNative = needsNativeProviderReadiness(eligible.choices)
    let nativeReadinessPromise: Promise<NativeProviderReadinessSnapshot | null> = Promise.resolve(null)
    if (needsNative && this.nativeProviderReadiness !== undefined) {
      nativeReadinessPromise = previewMemo?.nativeProviderReadiness
        ?? (previewMemo !== undefined
          ? this.previewNativeProviderReadiness(previewMemo)
          : Promise.resolve()
            .then(() => this.nativeProviderReadiness!())
            .catch(() => null))
      if (previewMemo !== undefined) previewMemo.nativeProviderReadiness = nativeReadinessPromise
    }

    // Start the independent non-inference samples together and bind all
    // completed immutable results to every readiness decision in this
    // selection. A failed sample remains explicit null/unknown and is never
    // retried or replaced inside the evaluation. The client-readiness sample is
    // warmed concurrently with the quota/native samples so the independent
    // reads are not serialized.
    const clientSamplePromise = this.clientReadinessSample(previewMemo)
    const [boundSnapshot, nativeProviderReadiness, clientSample]: [
      AutoRoutingBoundQuotaSnapshot | null,
      NativeProviderReadinessSnapshot | null,
      ClientReadinessSnapshot | null,
    ] = await Promise.all([quotaPromise, nativeReadinessPromise, clientSamplePromise])
    const snapshot: AutoRoutingQuotaSnapshot | null = boundSnapshot?.snapshot ?? null
    const availabilityContext: TaskSettingsRuntimeAvailabilityContext = {
      codeBuddySnapshot: boundSnapshot?.codeBuddySnapshot,
      nativeProviderReadiness,
    }
    const nowMs = snapshot ? snapshot.nowMs : this.now()
    const blocked = new Set(snapshot ? snapshot.hardBlockedProviderIds : [])
    if (trace !== undefined) {
      trace.snapshotId = snapshot ? snapshot.snapshotId : null
      trace.nowMs = nowMs
    }

    // The authoritative client-readiness sample bound above is consulted
    // for every exact choice BEFORE the provider readiness probe and BEFORE
    // collapseAutomaticChoices, so a client that is disabled or not installed
    // can never admit a pair and an unavailable client (e.g. grok) cannot hide
    // a ready sibling client.

    // Structured actual eliminations, recorded at the exact stage that empties
    // the surviving pool; deterministic selection never parses error text.
    const eliminations: TaskResolutionElimination[] = []
    const probed: AutomaticProbeEntry[] = []
    // Every independent eligible runtime probe starts before any is awaited, so
    // concurrent probes are not serialized; the request-scoped memo still runs
    // each canonical triple at most once. Candidate ordering and rejection
    // details are preserved by consuming the results in the original eligible
    // order below.
    type ProbePlanEntry =
      | { choice: TaskDispatchChoice; availability: Promise<TaskSettingsProviderAvailability | undefined> }
      | { choice: TaskDispatchChoice; eliminated: 'client' | 'blocked' | 'route' | 'circuit' }
    const probePlan: ProbePlanEntry[] = []
    for (const choice of eligible.choices) {
      // Authoritative client gate: disabled or not-installed clients are
      // eliminated before provider readiness, so an unavailable client never
      // hides a ready sibling client sharing the same provider+model.
      if (!this.clientAdmitted(choice.client, clientSample)) {
        probePlan.push({ choice, eliminated: 'client' })
        continue
      }
      if (blocked.has(choice.provider)) {
        // A determinate hard-blocked provider is a real quota gate.
        probePlan.push({ choice, eliminated: 'blocked' })
        continue
      }
      // Gateway-backed candidates observe the shared route circuit: an open
      // route, or a half-open route whose recovery probe is not yet due, is
      // eliminated here. Native (non-Gateway) routes never consult Gateway
      // faults, and a due half-open route stays admitted so the Gateway's own
      // bounded probe can recover it.
      if (choice.mode === 'gateway' && !this.gatewayRouteAdmitted(choice.provider, choice.model, nowMs)) {
        probePlan.push({ choice, eliminated: 'route' })
        continue
      }
      // A native attempt cannot run the Gateway's HTTP recovery probe, so launch
      // admission refuses it while the shared `provider/model` route is open or
      // half-open. Apply the same rule here so selection never picks a route the
      // launch will refuse, and the next candidate is chosen instead.
      if (choice.mode !== 'gateway' && !this.nativeSharedRouteAdmitted(choice.provider, choice.model)) {
        probePlan.push({ choice, eliminated: 'route' })
        continue
      }
      // Additional exact task-client gate: the canonical target's own
      // client-qualified route key, which is the circuit a launched task
      // attempt faults, so a target that keeps failing is not auto-selected.
      if (!this.taskRouteAdmitted(this.routeStatus?.(choice.exactAgentRuntime))) {
        probePlan.push({ choice, eliminated: 'circuit' })
        continue
      }
      const availability = this.previewRuntimeAvailability(
        TaskSettingsService.tripleOf(choice),
        previewMemo,
        availabilityContext,
      )
      // Keep later-started probes handled when an earlier probe rejects and
      // aborts the ordered consume; the rejection itself still propagates
      // unchanged from the await below.
      void availability.catch(() => undefined)
      probePlan.push({ choice, availability })
    }
    for (const entry of probePlan) {
      if ('eliminated' in entry) {
        if (entry.eliminated === 'client' || entry.eliminated === 'route') {
          eliminations.push({ code: 'no_available_provider' })
          if (trace !== undefined) trace.readinessRejectedIds.push(entry.choice.exactAgentRuntime)
        } else if (entry.eliminated === 'circuit') {
          // The exact task-client circuit refuses this route: no available
          // provider here.
          eliminations.push({ code: 'no_available_provider' })
          if (trace !== undefined) trace.circuitBlockedIds.push(entry.choice.exactAgentRuntime)
        } else {
          eliminations.push(eliminationOf('quota_unavailable', boundedReferenceOutputUsdPerM(entry.choice)))
          if (trace !== undefined) trace.quotaBlockedIds.push(entry.choice.exactAgentRuntime)
        }
        continue
      }
      const availability = await entry.availability
      if (availability !== undefined && !availability.available) {
        // The live readiness probe rejected the exact choice: no available provider.
        eliminations.push({ code: 'no_available_provider' })
        if (trace !== undefined) trace.readinessRejectedIds.push(entry.choice.exactAgentRuntime)
        continue
      }
      probed.push({ choice: entry.choice, availability })
    }
    const collapsed = collapseAutomaticChoices(probed)
    if (trace !== undefined) trace.collapsedChoices = collapsed.map((entry) => entry.choice)
    if (collapsed.length === 0) {
      return { ok: false, error: automaticSelectionFailure(params, eliminations) }
    }

    const deepSeekPricing = new Map<string, DeepSeekAutomaticPricing>()
    for (const entry of collapsed) {
      const pricing = deepSeekAutomaticPricingOf(entry.choice, nowMs, params.timeoutMs)
      if (pricing !== undefined) deepSeekPricing.set(entry.choice.exactAgentRuntime, pricing)
    }

    const ranking = rankAutomaticTaskCandidates(
      collapsed,
      {
        snapshotId: snapshot ? snapshot.snapshotId : 'settings-no-quota-snapshot',
        snapshot,
        nowMs,
        timeoutMs: params.timeoutMs,
        requirements: params.requirements,
      },
      params.routingWeights,
      deepSeekPricing,
    )

    if (trace !== undefined) trace.capUsdPerMillion = ranking.capUsdPerM

    for (const entry of collapsed) {
      if (!ranking.unscorableIds.includes(entry.choice.exactAgentRuntime)) continue
      const pricing = deepSeekPricing.get(entry.choice.exactAgentRuntime)
      const referenceUsdPerM = pricing?.safetyOutputUsdPerM
        ?? entry.choice.reference_pricing.output_usd_per_million
      eliminations.push(eliminationOf('intelligence_requirement', referenceUsdPerM))
      if (trace !== undefined) {
        trace.unscorable.push({ id: entry.choice.exactAgentRuntime, code: 'intelligence_requirement' })
      }
    }
    if (ranking.inputs.length === 0) {
      return { ok: false, error: automaticSelectionFailure(params, eliminations) }
    }
    if (trace !== undefined) {
      trace.scored = ranking.inputs.length
      trace.ranked = ranking.ranked.ranked
      trace.catalogExcluded = ranking.ranked.excluded.map((entry) => ({
        id: entry.canonicalId, reason: entry.reason, detail: entry.detail,
      }))
    }
    const best = ranking.ranked.ranked[0]
    if (!best) {
      // Every routed candidate was excluded by a real Catalog gate; each
      // exclusion reason maps to its closed code. Unknown reasons are not a
      // hard elimination, so they surface as no_available_provider.
      for (const exclusion of ranking.ranked.excluded) {
        const code = codeFromCatalogExclusion(exclusion.reason)
        if (code === undefined) {
          eliminations.push({ code: 'no_available_provider' })
          continue
        }
        const entry = collapsed.find((candidate) => candidate.choice.exactAgentRuntime === exclusion.canonicalId)
        eliminations.push(eliminationOf(code, boundedReferenceOutputUsdPerM(entry?.choice)))
      }
      return { ok: false, error: automaticSelectionFailure(params, eliminations) }
    }
    const chosen = collapsed.find((entry) => entry.choice.exactAgentRuntime === best.canonicalId)
    if (!chosen) {
      return { ok: false, error: automaticSelectionFailure(params, eliminations) }
    }

    const decision: TaskAutoRoutingDecision = {
      snapshot_id: best.snapshotId,
      selected_rank: best.rank,
      supply_class: best.supplyClass,
      quota_state: best.tier,
      quota_coverage_complete: best.coverageComplete,
      reference_output_usd_per_million: best.referenceUsdPerM,
      routing_output_usd_per_million: best.routingPriceUsdPerM,
      effective_cap_usd_per_million: ranking.capUsdPerM,
      score: best.score,
      scoring: {
        version: 'normalized-v1',
        price: best.priceFactor,
        speed: best.speedFactor,
        quota: best.quotaQuality,
        intelligence: best.intelligenceFactor,
      },
      reasons: [...best.notes],
    }
    const { exactAgentRuntime: _exact, ...resolvedFields } = chosen.choice
    const selectedPricing = deepSeekPricing.get(chosen.choice.exactAgentRuntime)
    const dispatch: TaskResolvedDispatch = {
      ...resolvedFields,
      ...(selectedPricing !== undefined ? { reference_pricing: selectedPricing.attemptReferencePricing } : {}),
      auto_routing: decision,
    }
    const reason = `automatic selection rank ${best.rank}/${ranking.ranked.ranked.length} (${best.supplyClass}, quota tier ${best.tier})`
    return {
      ok: true,
      exactAgentRuntime: chosen.choice.exactAgentRuntime,
      dispatch,
      decision,
      reason,
      ...(chosen.availability?.codeBuddyExecution
        ? { codeBuddyExecution: chosen.availability.codeBuddyExecution }
        : {}),
    }
  }

  private applyPatchToLayer(
    layer: ConfigTaskSettingsLayer | undefined,
    patch: TaskSettingsPatch,
  ): ConfigTaskSettingsLayer | undefined {
    const raw = canonicalLayerToRaw(layer)

    if (patch.run_time_limit_minutes !== undefined) {
      if (patch.run_time_limit_minutes === null) {
        delete raw.run_time_limit_minutes
      } else {
        raw.run_time_limit_minutes = patch.run_time_limit_minutes
      }
    }

    if (patch.routing_weights !== undefined) {
      if (patch.routing_weights === null) {
        delete raw.routing_weights
      } else {
        raw.routing_weights = patch.routing_weights
      }
    }

    if (patch.automatic !== undefined) {
      if (patch.automatic === null) {
        delete raw.dispatch
      } else {
        const mergedDispatch: Record<string, unknown> = {
          ...(raw.dispatch && typeof raw.dispatch === 'object' && !Array.isArray(raw.dispatch)
            ? (raw.dispatch as Record<string, unknown>)
            : {}),
        }
        for (const [key, value] of Object.entries(patch.automatic)) {
          if (value === undefined) continue
          if (!isDispatchField(camelKey(key))) {
            throw new TaskSettingsInvalidSettingsError(`unknown automatic dispatch field '${key}'`)
          }
          if (value === null) {
            delete mergedDispatch[key]
          } else {
            mergedDispatch[key] = value
          }
        }
        raw.dispatch = mergedDispatch
      }
    }

    const normalized = normalizeTaskSettingsLayer(raw, { scope: 'save patch' })
    return Object.keys(normalized).length > 0 ? normalized : undefined
  }

  private readConfigRecord(): { record: import('../../config/data.mts').ConfigRecord; revision: string } {
    const parsed = this.store.read(this.configPath)
    const record: import('../../config/data.mts').ConfigRecord = parsed ?? {}
    return { record, revision: contentRevision(record) }
  }

  /** Converts a canonical config layer into the JSON-safe snake_case layer DTO. */
  private toLayerDto(layer?: ConfigTaskSettingsLayer): TaskSettingsLayerDto {
    if (!layer) return {}
    return {
      ...(layer.runTimeLimitMinutes !== undefined ? { run_time_limit_minutes: layer.runTimeLimitMinutes } : {}),
      ...(layer.dispatch !== undefined && Object.keys(layer.dispatch).length > 0
        ? { automatic: toSnakeDispatch(layer.dispatch) }
        : {}),
      ...(layer.routingWeights !== undefined
        ? { routing_weights: layer.routingWeights }
        : {}),
    }
  }

  private writeRecordMutation(
    record: import('../../config/data.mts').ConfigRecord,
    mutate: (settings: Record<string, unknown>, root: Record<string, unknown>, byTask: Record<string, unknown>) => void,
  ): void {
    const root = record as Record<string, unknown>
    const existingTasks = root.tasks
    if (existingTasks === undefined) {
      root.tasks = {}
    } else if (typeof existingTasks !== 'object' || Array.isArray(existingTasks)) {
      throw new Error('tasks must be an object')
    }
    const tasks = root.tasks as Record<string, unknown>
    const existingSettings = tasks.settings
    if (existingSettings === undefined || existingSettings === null) {
      tasks.settings = {}
    } else if (typeof existingSettings !== 'object' || Array.isArray(existingSettings)) {
      throw new Error('tasks.settings must be an object')
    }
    const settings = tasks.settings as Record<string, unknown>
    const byTask = ensureByTaskMap(settings)

    mutate(settings, root, byTask)

    cleanupEmptyByTask(settings, byTask, root)
    if (Object.keys(settings).length === 0) delete tasks.settings
    if (Object.keys(tasks).length === 0) delete root.tasks
    this.store.write(this.configPath, root as import('../../config/data.mts').ConfigRecord)
  }
}

// ---------------------------------------------------------------------------
// Automatic selection policy plumbing (quota/free/cap/client)
// ---------------------------------------------------------------------------

interface AutomaticSelectionParams {
  taskName: string
  requirements: ConfigTaskDispatchRequirements
  timeoutMs: number
  /** Global routing weights; undefined uses the scorer defaults. */
  routingWeights?: TaskRoutingWeights | undefined
}

/** Request-scoped optional trace collector instrumenting the exact automatic
 *  selection path. Ordinary callers pass no trace and are entirely unaffected:
 *  the resolver records nothing extra and its return value is identical. Used
 *  only by the read-only routingTest diagnostic surface. */
interface AutomaticSelectionTrace {
  capUsdPerMillion: number | null
  /** Populated when the initial static eligibility gate rejects everything. */
  eligibleFailure?: { code: TaskResolutionFailureCode; message: string; candidateCount: number }
  eligibleIds: string[]
  quotaBlockedIds: string[]
  readinessRejectedIds: string[]
  /** Choices eliminated because their exact task-client circuit is open, or
   *  half-open with its recovery probe not yet due. A due probe route is never
   *  listed here. */
  circuitBlockedIds: string[]
  collapsedChoices: TaskDispatchChoice[]
  /** Collapsed candidates that could not build a truthful scored input. */
  unscorable: Array<{ id: string; code: TaskResolutionFailureCode }>
  /** Real Catalog gate exclusions with their raw reason. */
  catalogExcluded: Array<{ id: string; reason: string; detail: string | null }>
  ranked: RankedCandidate[]
  scored: number
  snapshotId: string | null
  nowMs: number
}

interface AutomaticProbeEntry {
  choice: TaskDispatchChoice
  availability?: TaskSettingsProviderAvailability
}

/** Request-scoped preview memo built per snapshot() request and passed
 *  through buildRow to resolveAutomaticSelection. It holds the request's single
 *  immutable quota snapshot (unknown/fail-closed results included) and one
 *  non-billable probe promise per canonical runtime triple, so N rows sharing
 *  the same eligible runtimes never repeat quota reads or identical credential
 *  reads. resolveForRun and save preflight never construct or pass a memo:
 *  they always probe fresh. */
interface AutomaticPreviewMemo {
  /** Immutable quota snapshot promise for this request, created on the first
   *  automatic row that needs one and reused by the rest of the rows. */
  quota?: Promise<AutoRoutingBoundQuotaSnapshot | null>
  /** Prior in-flight refresh of the same quota snapshot, consumed when the
   *  shared service returned a stale preview. */
  refresh?: Promise<AutoRoutingBoundQuotaSnapshot | null>
  /** One immutable authoritative native-provider status sample shared by all
   * relevant automatic rows in this snapshot request. Null is a sampled
   * failure and must never trigger a second query or optimistic fallback. */
  nativeProviderReadiness?: Promise<NativeProviderReadinessSnapshot | null>
  /** One immutable authoritative client readiness sample shared by all
   * relevant automatic rows in this snapshot request. Null is a sampled
   * failure and must never trigger a second query or optimistic fallback. */
  clientReadiness?: Promise<ClientReadinessSnapshot | null>
  /** Non-billable runtimeAvailability probe per canonical runtime triple. */
  availability: Map<string, Promise<TaskSettingsProviderAvailability>>
  /** One shared result per distinct automatic-selection input so identical
   *  effective settings never re-run the resolver inside one request. The
   *  resolver's own task-name argument never reaches a result value (it only
   *  formats NoEligiblePlanError text), so it stays out of the key. */
  selections?: Map<string, Promise<AutomaticSelectionResult>>
}

/** Canonical string key of a resolved runtime triple used to dedupe identical
 *  non-billable readiness probes within one snapshot request. */
function runtimeTripleKey(runtime: TaskSettingsRuntimeAvailabilityTarget): string {
  return `${runtime.provider}/${runtime.model}:${runtime.client}#${runtime.mode}`
}

/** Canonical string key of one automatic-selection input; JSON key order is
 *  fixed by construction so equal requirement sets collide. */
function automaticSelectionKey(params: AutomaticSelectionParams): string {
  const requirements = params.requirements as Record<string, unknown>
  const keys = Object.keys(requirements).sort()
  const ordered: Record<string, unknown> = {}
  for (const key of keys) ordered[key] = requirements[key]
  return JSON.stringify({
    requirements: ordered,
    timeoutMs: params.timeoutMs,
    routingWeights: params.routingWeights ?? null,
  })
}

type AutomaticSelectionResult =
  | {
      ok: true
      exactAgentRuntime: string
      dispatch: TaskResolvedDispatch
      decision: TaskAutoRoutingDecision
      reason: string
      codeBuddyExecution?: CodeBuddyExecutionBinding
    }
  | { ok: false; error: NoEligiblePlanError }


/** Collapse only variants sharing the same canonical provider+model AND the
 *  same reference pricing identity. Within a group prefer native, then grok,
 *  then the stable other client (alphabetical tie-break). Distinct canonical
 *  model ids / pricing variants always stay separate. */
function collapseAutomaticChoices(entries: readonly AutomaticProbeEntry[]): AutomaticProbeEntry[] {
  const groups = new Map<string, AutomaticProbeEntry[]>()
  for (const entry of entries) {
    const choice = entry.choice
    const pricing = choice.reference_pricing
    const referenceIdentity = pricing
      ? `${pricing.source}:${String(pricing.output_usd_per_million)}`
      : 'no-reference'
    const key = `${choice.provider}/${choice.model}#${referenceIdentity}`
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }
  const collapsed: AutomaticProbeEntry[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const aPreference = automaticClientPreference(a.choice)
      const bPreference = automaticClientPreference(b.choice)
      if (aPreference !== bPreference) return aPreference - bPreference
      return a.choice.client.localeCompare(b.choice.client)
    })
    collapsed.push(group[0]!)
  }
  return collapsed
}

function automaticClientPreference(choice: TaskDispatchChoice): number {
  if (choice.mode === 'native') return 0
  if (choice.client === 'grok') return 1
  return 2
}

/** Only exact native Codex/Cursor-client candidates require the authoritative
 * Wrenyard provider-status sample. This intentionally keys on the native client,
 * not the Catalog provider id: the single ChatGPT provider uses the codex
 * native client and credential resolver, while its quota pools stay scoped to
 * the ChatGPT provider row. Gateway variants never consume native login state. */
function needsNativeProviderReadiness(choices: readonly TaskDispatchChoice[]): boolean {
  return choices.some((choice) =>
    choice.mode === 'native' && (choice.client === 'codex' || choice.client === 'cursor'),
  )
}

/** Bounded candidate reference output price used only internally as the
 *  deterministic routing relevance comparator; never serialized. */
function boundedReferenceOutputUsdPerM(
  choice: { reference_pricing?: { output_usd_per_million?: number | null } } | undefined,
): number | undefined {
  const value = choice?.reference_pricing?.output_usd_per_million
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Closed elimination builder: no_available_provider never carries a routing
 *  price; every other gate keeps its bounded reference price. */
function eliminationOf(
  code: TaskResolutionFailureCode,
  priceUsdPerMillion?: number,
): TaskResolutionElimination {
  if (code === 'no_available_provider' || priceUsdPerMillion === undefined) return { code }
  return { code, priceUsdPerMillion }
}

/** One deterministic NoEligiblePlanError carrying the closed code of the gate
 *  that emptied the pool. Defaults to no_available_provider when no structured
 *  elimination was recorded (for example an empty eligible choice list). */
function automaticSelectionFailure(
  params: AutomaticSelectionParams,
  eliminations: ReadonlyArray<TaskResolutionElimination>,
): NoEligiblePlanError {
  const code = selectTaskResolutionFailure(eliminations)?.code ?? 'no_available_provider'
  return new NoEligiblePlanError(params.taskName, [], params.requirements, code)
}

interface TaskSettingsEffectiveAutomaticDto {
  requires_web_search?: { value: boolean | null; source: TaskSettingsSourceLayer }
  expected_tps: { value: number | null; source: TaskSettingsSourceLayer }
  minimum_tps: { value: number | null; source: TaskSettingsSourceLayer }
  intelligence_min: { value: 'low' | 'mid' | 'high' | 'premium' | null; source: TaskSettingsSourceLayer }
  intelligence_expected: { value: 'low' | 'mid' | 'high' | 'premium' | null; source: TaskSettingsSourceLayer }
  max_output_usd_per_million: { value: number | null; source: TaskSettingsSourceLayer }
  required_capabilities: { value: Array<'text' | 'image'> | null; source: TaskSettingsSourceLayer }
  exclude_model_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_profile_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_client_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_provider_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  expected_reasoning_effort?: { value: ReasoningEffort | null; source: TaskSettingsSourceLayer }
}

function toEffectiveAutomatic(
  dispatch: ConfigTaskDispatchRequirements,
  sources: Partial<Record<TaskDispatchField, TaskSettingsSourceTag>> | undefined,
): TaskSettingsEffectiveAutomaticDto {
  const out: Record<string, unknown> = {}
  for (const field of TASK_DISPATCH_FIELDS) {
    const value = dispatch[field]
    out[snakeKey(field)] = {
      value: value === undefined ? null : cloneValue(value),
      source: toSourceLayer(sources?.[field]),
    }
  }
  return out as unknown as TaskSettingsEffectiveAutomaticDto
}

/** Maps the config resolver's per-field source tags into the bounded run
 *  resolution source shape (JSON-safe layer names, snake dispatch keys). */
function toRunSources(
  sources: ReturnType<typeof resolveEffectiveTaskSettings>['sources'],
): TaskRunSettingsResolution['sources'] {
  const automatic: Record<string, TaskSettingsSourceLayer> = {}
  const dispatchSources = sources.dispatch
  if (dispatchSources !== undefined) {
    for (const field of TASK_DISPATCH_FIELDS) {
      const tag = dispatchSources[field]
      if (tag !== undefined) automatic[snakeKey(field)] = toSourceLayer(tag)
    }
  }
  return {
    runTimeLimitMinutes: toSourceLayer(sources.runTimeLimitMinutes),
    automatic,
  }
}

function ensureByTaskMap(settings: Record<string, unknown>): Record<string, unknown> {
  const existing = settings.byTask
  if (existing === undefined || existing === null) {
    const map: Record<string, unknown> = {}
    settings.byTask = map
    return map
  }
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('tasks.settings.byTask must be an object')
  }
  return existing as Record<string, unknown>
}

function cleanupEmptyByTask(
  settings: Record<string, unknown>,
  byTask: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (Object.keys(byTask).length === 0) delete settings.byTask
  const tasks = root.tasks
  if (tasks !== undefined && typeof tasks === 'object' && !Array.isArray(tasks)) {
    if (Object.keys(settings).length === 0) {
      delete (tasks as Record<string, unknown>).settings
    }
  }
}

function contentRevision(record: unknown): string {
  const text = JSON.stringify(record ?? {}) ?? '{}'
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tasksSectionOf(record: unknown): TasksConfigSettingsInput | undefined {
  const root = record as Record<string, unknown> | null
  const tasks = root?.tasks
  if (tasks === undefined || tasks === null) return undefined
  if (typeof tasks !== 'object' || Array.isArray(tasks)) {
    throw new Error('tasks must be an object')
  }
  return tasks as TasksConfigSettingsInput
}

/**
 * Default read-only definition source: `TaskService` scanning the daemon
 * workspace. Lazily constructed so constructing the settings service never
 * touches task loading; both accessors share one instance.
 */
function createWorkspaceDefinitionSource(workspaceRoot: string): TaskSettingsDefinitionSource {
  let service: TaskService | undefined
  const getService = (): TaskService => {
    service ??= new TaskService({ workspaceRoot })
    return service
  }
  /** Authoritative `.fmproj` display label for a registered project id, when
   *  the project is known to project discovery. */
  const projectLabel = (projectId: string | undefined): string | undefined => {
    if (projectId === undefined) return undefined
    return discoverProjects(workspaceRoot).get(projectId)?.config.displayName
  }
  return {
    async list(project) {
      const items = await getService().list(project)
      return Array.isArray(items)
        ? items.map((item) => {
          // Definitions never pin a runtime: only dispatch/prompt
          // metadata is projected; no agentRuntime/profile is derived.
          const target = resolveTaskTarget(item.name, workspaceRoot, project)
          const config = target?.definition.config
          const record = item as {
            project?: unknown
            source?: unknown
            description?: unknown
            dispatch?: unknown
            promptTemplate?: unknown
            inheritanceChain?: unknown
          }
          const projectName = record.project !== undefined ? String(record.project) : undefined
          const projectDisplayName = projectLabel(projectName)
          return {
            name: item.name,
            ...(projectName !== undefined
              ? { kind: 'project' as const, project: projectName }
              : { kind: 'builtin' as const }),
            ...(config?.displayName !== undefined ? { displayName: config.displayName } : {}),
            ...(projectDisplayName !== undefined ? { projectDisplayName } : {}),
            ...(record.source !== undefined ? { source: String(record.source) } : {}),
            ...(record.description !== undefined ? { description: String(record.description) } : {}),
            ...(record.dispatch !== undefined
              ? { dispatch: record.dispatch }
              : {}),
            ...(record.promptTemplate === 'dynamic' || record.promptTemplate === 'fixed'
              ? { promptTemplate: record.promptTemplate }
              : {}),
            ...(Array.isArray(record.inheritanceChain)
              ? { inheritanceChain: record.inheritanceChain as TaskInheritanceChainEntry[] }
              : {}),
            instructionTemplate: taskInstructionTemplate(config),
          }
        })
        : []
    },
    async listProjects() {
      return [...discoverProjects(workspaceRoot).values()].map((node) => ({
        id: node.id,
        ...(node.config.displayName !== undefined ? { displayName: node.config.displayName } : {}),
      }))
    },
    async listLoadErrors() {
      // Ensure normal task discovery has run so the registry load errors are
      // current, then project-group each error by registered project ownership
      // (longest containing registered project directory; never a fabricated
      // project). Only task definition errors are surfaced.
      await getService().list(undefined)
      const projects = discoverProjects(workspaceRoot)
      const projectNodes = [...projects.entries()].map(([id, node]) => ({
        id,
        dirPath: resolve(node.dirPath),
        displayName: node.config.displayName,
      }))
      return getLoadErrors(workspaceRoot).map((error) => {
        const absolute = resolve(error.sourcePath)
        let owner: { id: string; displayName?: string } | undefined
        let longest = -1
        for (const node of projectNodes) {
          const rel = relative(node.dirPath, absolute)
          const contained = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
          if (contained && node.dirPath.length > longest) {
            longest = node.dirPath.length
            owner = { id: node.id, displayName: node.displayName }
          }
        }
        return {
          source_path: error.sourcePath,
          file_name: basename(error.sourcePath),
          message: error.load_error,
          ...(owner !== undefined ? { project: owner.id } : {}),
          ...(owner?.displayName !== undefined ? { project_display_name: owner.displayName } : {}),
        } satisfies TaskSettingsLoadError
      })
    },
    async describe(taskId, project) {
      const detail = await getService().describe(taskId, project)
      const record = detail as unknown as Record<string, unknown>
      // Definitions never pin a runtime; only timeout/dispatch/prompt metadata
      // is projected, so no agentRuntime/profile is derived here.
      const target = resolveTaskTarget(taskId, workspaceRoot, project)
      const config = target?.definition.config
      const recordProject = record.project !== undefined ? String(record.project) : undefined
      const projectDisplayName = projectLabel(recordProject ?? project)
      const summary: TaskSettingsDefinitionSummary = {
        name: String(record.name ?? ''),
        ...(record.project !== undefined
          ? { kind: 'project' as const, project: String(record.project) }
          : { kind: 'builtin' as const }),
        ...(config?.displayName !== undefined ? { displayName: config.displayName } : {}),
        ...(projectDisplayName !== undefined ? { projectDisplayName } : {}),
        ...(record.source !== undefined ? { source: String(record.source) } : {}),
        ...(record.description !== undefined ? { description: String(record.description) } : {}),
                ...(record.dispatch !== undefined ? { dispatch: record.dispatch } : {}),
        ...(record.promptTemplate === 'dynamic' || record.promptTemplate === 'fixed'
          ? { promptTemplate: record.promptTemplate }
          : {}),
        ...(Array.isArray(record.inheritanceChain)
          ? { inheritanceChain: record.inheritanceChain as TaskInheritanceChainEntry[] }
          : {}),
        instructionTemplate: taskInstructionTemplate(config),
      }
      return {
        ...summary,
        ...(record.input_schema !== undefined ? { input_schema: record.input_schema } : {}),
        ...(record.output_schema !== undefined ? { output_schema: record.output_schema } : {}),
      } as TaskSettingsDefinitionDetail
    },
  }
}
