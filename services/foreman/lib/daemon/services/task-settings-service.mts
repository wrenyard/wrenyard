import { createHash } from 'node:crypto'
import { INTELLIGENCE_ORDER, rankAutoRoutingCandidates } from '@wrenyard/catalog'
import type { CandidateInput } from '@wrenyard/catalog'
import {
  resolveDeepSeekReferencePricing,
  type DeepSeekPricingModel,
  type DeepSeekReferencePricing,
} from '@wrenyard/providers'
import {
  NoEligiblePlanError,
  type TaskDispatchChoice,
  type TaskDispatchDisplayLabels,
  type TaskDispatchResolver,
} from '../../core/task/dispatch-resolver.mts'
import {
  codeFromCatalogExclusion,
  selectTaskResolutionFailure,
  taskResolutionFailure,
  type TaskResolutionElimination,
  type TaskResolutionFailureCode,
} from '../../core/task/task-resolution-failure.mts'
import { TaskService } from '../../core/task/service.mts'
import { getTaskPromptTemplates } from '../../core/task/prompt-template.mts'
import { resolveTaskTarget, getLoadErrors } from '../../workspace/definition-registry.mts'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { discoverProjects } from '../../core/project/loader.mts'
import type { ForemanConfigStore } from '../../config/manager.mts'
import { JsonForemanConfigStore } from '../../config/manager.mts'
import type { RuntimeAliasService } from './runtime-alias-service.mts'
import {
  TASK_DISPATCH_FIELDS,
  taskDefaultsToSettingsLayer,
  taskSettingsIdentity,
  readGlobalTaskSettings,
  readPerTaskSettings,
  normalizeTaskSettingsLayer,
  resolveEffectiveTaskSettings,
  type TaskDispatchField,
  type TaskDispatchRequirements as ConfigTaskDispatchRequirements,
  type TaskSettingsLayer as ConfigTaskSettingsLayer,
  type TaskSettingsSourceTag,
  type TasksConfigSettingsInput,
} from '../../config/task-settings.mts'
import type {
  TaskAutoRoutingDecision,
  TaskResolvedDispatch,
} from '../../task-run-metadata-types.mts'
import {
  AutoRoutingQuotaSnapshotService,
  type AutoRoutingBoundQuotaSnapshot,
  type AutoRoutingQuotaSnapshot,
  type CodeBuddyActiveSnapshotView,
} from './auto-routing-snapshot-service.mts'
import type {
  TaskSettingsAutomaticDispatch,
  TaskSettingsAutomaticSelection,
  TaskSettingsExplicitReference,
  TaskSettingsExplicitRow,
  TaskSettingsInstructionSegment,
  TaskSettingsLayer as TaskSettingsLayerDto,
  TaskSettingsLoadError,
  TaskSettingsMode,
  TaskSettingsPatch,
  TaskSettingsRuntimeReadiness,
  TaskSettingsRuntimeTriple,
  TaskSettingsSaveParams,
  TaskSettingsSnapshotParams,
  TaskSettingsSnapshotResult,
  TaskSettingsSourceLayer,
  TaskSettingsTaskRow,
  TaskSettingsValidationIssue,
} from '../../protocol/methods/task.mts'
import type {
  TaskRunSettingsParams,
  TaskRunSettingsResolution,
} from '../../types.mts'
import type { CodeBuddyExecutionBinding } from '../../core/operations/types.mts'
import type { ForgeProviderReadinessSnapshot } from '../execution/forge-provider-readiness-query.mts'

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
 * Explicit selection is structural only: persisted layers store an alias
 * reference or an inline target, never a copied client/provider/model triple.
 * Every snapshot/save preflight/run resolves aliases freshly through the
 * injected daemon-owned RuntimeAliasService and passes the canonical
 * `provider/model:client` target through `TaskDispatchResolver.resolveExplicit`
 * — the same path inline targets take. Unknown/deleted/unusable aliases and
 * unavailable inline targets fail without automatic fallback.
 *
 * Effective settings resolve through config/task-settings.mts, merging the
 * system defaults, builtin task defaults, user global, user per-task, and (for
 * runs) invocation layers right-wins. Snapshot/preflight never performs a paid
 * model call: automatic mode ignores aliases and validates via
 * `TaskDispatchResolver.resolve`; explicit mode validates via
 * `resolveExplicit`, with daemon admission and live provider
 * credential/availability supplied by injected non-billable callbacks.
 */
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
  timeoutMs?: number
  dispatch?: unknown
  promptTemplate?: 'dynamic' | 'fixed'
  /** Ordered safe preview segments of the builtin prompt template; never
   *  produced by executing definition functions. */
  instructionTemplate?: TaskSettingsInstructionSegment[]
}

export interface TaskSettingsDefinitionDetail extends TaskSettingsDefinitionSummary {
  permission?: 'readonly' | 'edit' | 'yolo'
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
  /** One request/evaluation-bound Forge status sample for native providers.
   *  Null means the bounded status read failed and callers must stay unknown;
   *  absence of the context means explicit-mode callers may load one fresh. */
  readonly nativeProviderReadiness: ForgeProviderReadinessSnapshot | null
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

/** One bounded Forge provider-list status read. No credentials cross this
 * boundary; TaskSettings only binds the immutable result to one evaluation. */
export type TaskSettingsNativeProviderReadinessCallback =
  () => Promise<ForgeProviderReadinessSnapshot>

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
  /** Daemon-owned runtime alias owner. Alias references are resolved freshly
   *  through this exact instance at every snapshot/save preflight/run call;
   *  the service never duplicates or caches alias targets. */
  aliases: RuntimeAliasService
  store?: ForemanConfigStore
  definitions?: TaskSettingsDefinitionSource
  /** Optional non-billable daemon admission availability (accepting/frozen). */
  daemonAvailability?: TaskSettingsDaemonAvailabilityCallback
  /** Optional non-billable live provider credential/route availability probe. */
  runtimeAvailability?: TaskSettingsRuntimeAvailabilityCallback
  /** Optional authoritative non-inference native provider status source. It is
   * sampled once only when an evaluation contains native Codex/Cursor choices. */
  nativeProviderReadiness?: TaskSettingsNativeProviderReadinessCallback
  /** Daemon-owned immutable automatic-routing quota snapshot service shared by
   *  every automatic selection (run and snapshot row preview). Snapshot row
   *  preview takes one immutable snapshot per request; every other selection
   *  call takes its own. */
  quotaSnapshots?: AutoRoutingQuotaSnapshotService
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
    super(`explicit runtime '${runtime}' is unavailable for task '${taskId}': ${reason}`)
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

/** Canonical config layer -> a raw alias object the normalizer accepts. */
function canonicalLayerToRaw(layer?: ConfigTaskSettingsLayer): Record<string, unknown> {
  if (!layer) return {}
  const raw: Record<string, unknown> = {}
  if (layer.selectionMode !== undefined) raw.selection_mode = layer.selectionMode
  if (layer.explicitRuntime !== undefined) raw.explicit_runtime = layer.explicitRuntime
  if (layer.timeoutMs !== undefined) raw.timeout_ms = layer.timeoutMs
  if (layer.maxAutoOutputUsdPerMillion !== undefined) {
    raw.max_auto_output_usd_per_million = layer.maxAutoOutputUsdPerMillion
  }
  if (layer.dispatch !== undefined && Object.keys(layer.dispatch).length > 0) {
    raw.dispatch = toSnakeDispatch(layer.dispatch)
  }
  return raw
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
  private readonly aliases: RuntimeAliasService
  private readonly store: ForemanConfigStore
  private readonly definitions: TaskSettingsDefinitionSource
  private readonly daemonAvailability?: TaskSettingsDaemonAvailabilityCallback
  private readonly runtimeAvailability?: TaskSettingsRuntimeAvailabilityCallback
  private readonly nativeProviderReadiness?: TaskSettingsNativeProviderReadinessCallback
  private readonly quotaSnapshots?: AutoRoutingQuotaSnapshotService
  private readonly now: () => number

  constructor(options: TaskSettingsServiceOptions) {
    this.configPath = options.configPath
    this.resolver = options.resolver
    this.aliases = options.aliases
    this.store = options.store ?? new JsonForemanConfigStore()
    this.definitions = options.definitions ?? createWorkspaceDefinitionSource(options.workspaceRoot)
    this.daemonAvailability = options.daemonAvailability
    this.runtimeAvailability = options.runtimeAvailability
    this.nativeProviderReadiness = options.nativeProviderReadiness
    this.quotaSnapshots = options.quotaSnapshots
    this.now = options.now ?? (() => Date.now())
  }

  /** The authoritative config path this daemon-owned service reads and writes. */
  get authoritativeConfigPath(): string {
    return this.configPath
  }

  /** Live alias entries `[{name,target}]` for the snapshot surface. Mirrors the
   *  runtime-alias protocol snapshot and is re-read at every call; never
   *  cached. */
  private async aliasEntries(): Promise<Array<{ name: string; target: string }>> {
    const snapshot = await this.aliases.snapshot()
    return snapshot.aliases
  }

  /** Resolves one stored structural reference freshly to its canonical
   *  `provider/model:client` run target. Alias references reload the daemon
   *  alias store at call time (never a stale cached target); inline targets are
   *  canonicalized through the same alias owner. Unresolvable references throw
   *  and callers never fall back to another runtime or to automatic mode. */
  private async resolveReference(reference: TaskSettingsExplicitReference): Promise<string> {
    const resolved = await this.aliases.resolve(reference)
    return resolved.target
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
   *  config layer. An explicit_runtime structural reference (alias or inline
   *  target) is carried verbatim and is never mapped to a resolved triple or
   *  runtime id here — alias resolution happens freshly at execution time. The
   *  invocation layer is never written to config. */
  private invocationLayerToCanonical(
    invocation: TaskSettingsLayerDto,
  ): ConfigTaskSettingsLayer {
    const raw: Record<string, unknown> = {}
    if (invocation.mode !== undefined && invocation.mode !== null) {
      raw.selectionMode = invocation.mode
    }
    if (invocation.explicit_runtime !== undefined && invocation.explicit_runtime !== null) {
      raw.explicitRuntime = invocation.explicit_runtime
    }
    if (invocation.timeout_ms !== undefined && invocation.timeout_ms !== null) {
      raw.timeoutMs = invocation.timeout_ms
    }
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
   *  Automatic mode ignores aliases and any inherited explicit reference; it
   *  resolves with the effective dispatch only through `resolver.resolve`.
   *  Explicit mode resolves the effective structural reference (alias or
   *  inline target) freshly through the injected RuntimeAliasService and calls
   *  `resolver.resolveExplicit` with only required capabilities; an
   *  unknown/deleted alias or an unavailable inline target fails the run with
   *  no automatic fallback. Both modes run the same non-billable live
   *  daemon/provider readiness checks exactly once against the selected
   *  canonical target and fail without fallback. */
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

    const builtinLayer = taskDefaultsToSettingsLayer({
      ...(params.defaults?.timeoutMs !== undefined ? { timeoutMs: params.defaults.timeoutMs } : {}),
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
        userGlobal: readGlobalTaskSettings(tasks) ?? undefined,
        userTask: userTaskLayer,
        ...(invocationLayer !== undefined ? { invocation: invocationLayer } : {}),
      })
    } catch (error) {
      throw new TaskSettingsInvalidSettingsError(undefined, messageOf(error))
    }

    if (effective.mode === 'explicit') {
      const reference = effective.explicitRuntime
      if (reference === undefined) {
        throw new TaskSettingsInvalidSettingsError('explicit mode requires an explicit runtime reference (alias or target)')
      }
      // Fresh alias resolution at call time; never a stale/cached target. An
      // unknown/deleted alias throws here and never falls back to automatic.
      const target = await this.resolveReference(reference)
      const capabilities = effective.dispatch.requiredCapabilities
      const explicitResolution = this.resolver.resolveExplicit({
        taskName: params.taskName,
        exactRuntime: target,
        ...(capabilities !== undefined && capabilities.length > 0 ? { requiredCapabilities: capabilities } : {}),
      })
      if (!explicitResolution.ok) {
        // Explicit mode bypasses automatic ranking and never falls back.
        throw explicitResolution.error
      }
      // Same non-billable live daemon admission and provider credential/route
      // readiness check shared by automatic runs and snapshot/save preflight,
      // run once against the canonical target resolveExplicit selected;
      // failure never falls back to another candidate.
      const availability = await this.assertLiveRuntimeAvailability(
        params.taskName,
        explicitResolution.exactAgentRuntime,
        TaskSettingsService.tripleOf(explicitResolution.resolved),
      )
      const dispatch = withDeepSeekAttemptPricing(
        explicitResolution.resolved,
        this.now(),
        effective.timeoutMs,
      )
      return {
        mode: 'explicit',
        exactAgentRuntime: explicitResolution.exactAgentRuntime,
        dispatch,
        ...(availability?.codeBuddyExecution
          ? { codeBuddyExecution: availability.codeBuddyExecution }
          : {}),
        timeoutMs: effective.timeoutMs,
        sources: toRunSources(effective.sources),
      }
    }

    // Automatic mode ignores aliases and any inherited/stale explicit
    // reference; only the effective dispatch is forwarded to the shared
    // automatic-selection path (resolver.eligible + live availability +
    // quota/free/cap policy + immutable ranking). Readiness already ran for
    // every exact choice before ranking, so there is NO second post-selection
    // runtimeAvailability call and no fallback after selection.
    const selection = await this.resolveAutomaticSelection({
      taskName: params.taskName,
      requirements: effective.dispatch,
      timeoutMs: effective.timeoutMs,
      maxAutoOutputUsdPerMillion: effective.maxAutoOutputUsdPerMillion,
    })
    if (!selection.ok) throw selection.error
    return {
      mode: 'automatic',
      exactAgentRuntime: selection.exactAgentRuntime,
      dispatch: selection.dispatch,
      ...(selection.codeBuddyExecution
        ? { codeBuddyExecution: selection.codeBuddyExecution }
        : {}),
      timeoutMs: effective.timeoutMs,
      sources: toRunSources(effective.sources),
    }
  }

  async snapshot(params: TaskSettingsSnapshotParams = {}): Promise<TaskSettingsSnapshotResult> {
    const { record, revision } = this.readConfigRecord()
    const tasks = tasksSectionOf(record)
    const userGlobal = readGlobalTaskSettings(tasks)

    const summaries = await this.collectSnapshotSummaries(params)
    const rows: TaskSettingsTaskRow[] = []
    // Request-scoped automatic preview memo for this snapshot request only:
    // automatic rows reuse one immutable quota snapshot and one readiness probe
    // per canonical runtime, so the list never repeats quota/credential reads.
    const previewMemo: AutomaticPreviewMemo = { availability: new Map() }
    for (const summary of summaries) {
      const kind: 'builtin' | 'project' = summary.kind
        ?? (summary.project !== undefined || params.project !== undefined ? 'project' : 'builtin')
      const identity = taskSettingsIdentity({
        kind,
        name: summary.name,
        ...(kind === 'project' ? { project: summary.project ?? params.project } : {}),
      })
      if (params.task_id !== undefined && summary.name !== params.task_id && identity !== params.task_id) continue
      rows.push(await this.buildRow(summary, params.project, tasks, userGlobal, previewMemo))
    }

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
      aliases: await this.aliasEntries(),
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
    const existingGlobal = readGlobalTaskSettings(tasks)
    const nextGlobal = this.applyPatchToLayer(existingGlobal, params.patch)
    if (nextGlobal?.selectionMode === 'explicit' && nextGlobal.explicitRuntime === undefined) {
      throw new TaskSettingsInvalidSettingsError('global explicit mode requires an explicit runtime reference (alias or target)')
    }

    this.writeRecordMutation(current.record, (settings) => {
      if (nextGlobal === undefined) {
        delete settings.global
      } else {
        settings.global = nextGlobal
      }
    })
    return this.snapshot({ project: params.project })
  }

  private async saveTask(
    params: TaskSettingsSaveParams,
    summary: TaskSettingsDefinitionSummary,
  ): Promise<TaskSettingsSnapshotResult> {
    if (params.patch.max_auto_output_usd_per_million !== undefined) {
      throw new TaskSettingsInvalidSettingsError(
        'max_auto_output_usd_per_million is global-only and cannot be applied at task scope',
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
    const baselineLayer = readPerTaskSettings(tasks, identity)
    const nextLayer = this.applyPatchToLayer(baselineLayer, params.patch)

    if (nextLayer !== undefined) {
      const builtinLayer = taskDefaultsToSettingsLayer({
        ...(summary.timeoutMs !== undefined ? { timeoutMs: summary.timeoutMs } : {}),
        dispatch: rawDefinitionDispatch(summary.dispatch),
      })
      let effective
      try {
        effective = resolveEffectiveTaskSettings({
          builtin: builtinLayer,
          userGlobal: readGlobalTaskSettings(tasks) ?? undefined,
          userTask: nextLayer,
        })
      } catch (error) {
        throw new TaskSettingsInvalidSettingsError(undefined, messageOf(error))
      }
      if (effective.mode === 'explicit') {
        const reference = effective.explicitRuntime
        if (reference === undefined) {
          throw new TaskSettingsInvalidSettingsError('explicit mode requires an explicit runtime reference (alias or target)')
        }
        // Preflight resolves the stored reference freshly (never a cached
        // target); an unknown/deleted alias or an unavailable inline target
        // fails the save with no automatic fallback.
        const target = await this.resolveReference(reference)
        const capabilities = effective.dispatch.requiredCapabilities
        const explicitResolution = this.resolver.resolveExplicit({
          taskName,
          exactRuntime: target,
          ...(capabilities !== undefined && capabilities.length > 0 ? { requiredCapabilities: capabilities } : {}),
        })
        if (!explicitResolution.ok) {
          throw new TaskSettingsInvalidSettingsError(explicitResolution.error.message)
        }
        await this.assertLiveRuntimeAvailability(
          taskName,
          explicitResolution.exactAgentRuntime,
          TaskSettingsService.tripleOf(explicitResolution.resolved),
        )
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
    timeoutMs?: number
    dispatch: ConfigTaskDispatchRequirements
  } {
    return {
      ...(summary.timeoutMs !== undefined
        ? { timeoutMs: summary.timeoutMs }
        : detail?.timeoutMs !== undefined
          ? { timeoutMs: detail.timeoutMs }
          : {}),
      dispatch: rawDefinitionDispatch(summary.dispatch ?? detail?.dispatch),
    }
  }

  private async buildRow(
    summary: TaskSettingsDefinitionSummary,
    project: string | undefined,
    tasks: TasksConfigSettingsInput | undefined,
    userGlobal: ConfigTaskSettingsLayer | undefined,
    previewMemo?: AutomaticPreviewMemo,
  ): Promise<TaskSettingsTaskRow> {
    const issues: TaskSettingsValidationIssue[] = []
    const kind: 'builtin' | 'project' = summary.kind
      ?? (summary.project !== undefined || project !== undefined ? 'project' : 'builtin')
    const identity = taskSettingsIdentity({
      kind,
      name: summary.name,
      ...(kind === 'project' ? { project: summary.project ?? project } : {}),
    })

    let detail: TaskSettingsDefinitionDetail | undefined
    try {
      // Project rows resolve their detail in the row's own project context so
      // unscoped snapshots still get authoritative project labels/templates.
      detail = await this.definitions.describe(
        summary.name,
        kind === 'project' ? summary.project ?? project : project,
      )
    } catch {
      detail = undefined
    }

    const builtinLayer = taskDefaultsToSettingsLayer(this.summaryDefaults(summary, detail))

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

    const source = summary.source ?? detail?.source ?? ''
    const description = summary.description ?? detail?.description
    const projectName = kind === 'project' ? summary.project ?? project : undefined
    const displayName = summary.displayName ?? detail?.displayName ?? summary.name
    const projectDisplayName = kind === 'project'
      ? summary.projectDisplayName ?? detail?.projectDisplayName ?? projectName ?? ''
      : undefined
    const instructionTemplate = summary.instructionTemplate ?? detail?.instructionTemplate ?? []
    const automatic = toEffectiveAutomatic(effective.dispatch, effective.sources.dispatch)

    // Explicit-mode row: the stored structural reference plus its exact
    // resolution. Alias references are resolved freshly at snapshot time; an
    // unknown/deleted alias or an unavailable inline target reports the issue
    // and keeps the structural reference — it never falls back to another
    // runtime or to automatic mode.
    let explicitRow: TaskSettingsExplicitRow | undefined
    // Automatic-mode row: selected resolved dispatch + safe reason, exposed
    // through minimal additive optional fields (keeps the Task page layout).
    let automaticSelection: TaskSettingsAutomaticSelection | undefined
    if (effective.mode === 'explicit') {
      const reference = effective.explicitRuntime
      if (reference === undefined) {
        issues.push({
          code: 'invalid_settings',
          message: 'explicit mode is selected but no explicit runtime reference (alias or target) is set',
        })
      } else {
        let resolvedTarget: string | null = null
        let resolved: TaskSettingsExplicitRow['resolved'] = null
        let readiness: TaskSettingsRuntimeReadiness | null = null
        try {
          const target = await this.resolveReference(reference)
          const capabilities = effective.dispatch.requiredCapabilities
          const explicitResolution = this.resolver.resolveExplicit({
            taskName: summary.name,
            exactRuntime: target,
            ...(capabilities !== undefined && capabilities.length > 0 ? { requiredCapabilities: capabilities } : {}),
          })
          if (explicitResolution.ok) {
            resolvedTarget = explicitResolution.exactAgentRuntime
            // Attach the paired authoritative Catalog display labels to the
            // resolved dispatch snapshot; canonical ids stay authoritative.
            const priced = withDeepSeekAttemptPricing(
              explicitResolution.resolved,
              this.now(),
              effective.timeoutMs,
            )
            const labels = this.displayLabelsOf(priced)
            resolved = labels
              ? {
                  ...priced,
                  provider_display_name: labels.providerDisplayName,
                  model_display_name: labels.modelDisplayName,
                }
              : priced
            readiness = await this.runtimeReadiness(
              summary.name,
              explicitResolution.exactAgentRuntime,
              TaskSettingsService.tripleOf(explicitResolution.resolved),
            )
          } else {
            issues.push({
              code: 'explicit_runtime_unavailable',
              message: explicitResolution.error.message,
            })
          }
        } catch (error) {
          issues.push({ code: 'explicit_runtime_unavailable', message: messageOf(error) })
        }
        explicitRow = { reference, resolved_target: resolvedTarget, resolved, readiness }
      }
    } else {
      // Automatic preview shares the exact automatic-selection helper used by
      // automatic runs (same availability/free/cap/client policy, same
      // immutable ranking), but never falls back. All automatic rows in one
      // snapshot request reuse the request-scoped preview memo — one immutable
      // quota snapshot and one readiness probe per canonical runtime — so rows
      // stay deterministic without repeating quota/credential reads. A failure
      // surfaces as a structured issue.
      try {
        const selection = await this.resolveAutomaticSelection({
          taskName: summary.name,
          requirements: effective.dispatch,
          timeoutMs: effective.timeoutMs,
          maxAutoOutputUsdPerMillion: effective.maxAutoOutputUsdPerMillion,
        }, previewMemo)
        if (selection.ok) {
          // Attach the paired authoritative Catalog display labels to the
          // selected automatic dispatch; canonical ids stay authoritative.
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
          // One closed deterministic failure: the exact code the real gate
          // recorded plus its safe Chinese message — never resolver error text.
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
    }

    return {
      identity,
      name: summary.name,
      display_name: displayName,
      ...(projectName !== undefined ? { project: projectName } : {}),
      ...(projectDisplayName !== undefined ? { project_display_name: projectDisplayName } : {}),
      builtin: {
        identity,
        name: summary.name,
        source,
        ...(description !== undefined ? { description } : {}),
        ...(projectName !== undefined ? { project: projectName } : {}),
        prompt_template: summary.promptTemplate ?? detail?.promptTemplate ?? 'dynamic',
        instruction_template: instructionTemplate,
        timeout_ms: builtinLayer.timeoutMs ?? null,
        dispatch: toSnakeDispatch(builtinLayer.dispatch ?? {}),
      },
      user_task: this.toLayerDto(userTaskLayer),
      effective: {
        mode: { value: effective.mode as TaskSettingsMode, source: toSourceLayer(effective.sources.selectionMode) },
        explicit_runtime: {
          value: effective.explicitRuntime ?? null,
          source: toSourceLayer(effective.sources.explicitRuntime),
        },
        timeout_ms: { value: effective.timeoutMs, source: toSourceLayer(effective.sources.timeoutMs) },
        max_auto_output_usd_per_million: {
          value: effective.maxAutoOutputUsdPerMillion ?? null,
          source: toSourceLayer(effective.sources.maxAutoOutputUsdPerMillion),
        },
        automatic,
      },
      ...(explicitRow !== undefined ? { explicit: explicitRow } : {}),
      ...(automaticSelection !== undefined ? { automatic_selection: automaticSelection } : {}),
      issues,
    }
  }

  private async runtimeReadiness(
    taskName: string,
    exactRuntime: string,
    runtime: TaskSettingsRuntimeAvailabilityTarget,
  ): Promise<TaskSettingsRuntimeReadiness> {
    const issues: TaskSettingsValidationIssue[] = []
    const daemonReport = this.daemonAvailability ? await this.daemonAvailability() : undefined
    const providerReport = this.runtimeAvailability ? await this.runtimeAvailability(runtime) : undefined

    let daemonOk = true
    let daemon: TaskSettingsRuntimeReadiness['daemon']
    if (daemonReport === undefined) {
      daemon = 'unknown'
    } else if (daemonReport.accepting) {
      daemon = 'accepting'
    } else if (daemonReport.known === false) {
      daemon = 'unknown'
    } else {
      daemon = 'unavailable'
      daemonOk = false
      issues.push({ code: 'daemon_not_accepting', message: 'daemon is not accepting new task runs' })
    }

    const providerCredential = providerReport?.providerCredential ?? 'unknown'
    const providerLive = providerReport?.providerLive ?? 'unknown'
    const quota = providerReport?.quota ?? 'unknown'
    const providerOk = providerReport === undefined || providerReport.available
    if (providerReport !== undefined && !providerReport.available) {
      issues.push({
        code: 'provider_unavailable',
        message: `provider '${runtime.provider}' is not currently available for explicit runtime '${exactRuntime}'`,
      })
    }

    return {
      runtime: exactRuntime,
      client: runtime.client,
      provider: runtime.provider,
      model: runtime.model,
      daemon,
      provider_credential: providerCredential,
      provider_live: providerLive,
      quota,
      available: daemonOk && providerOk,
      issues,
    }
  }

  /** Non-billable live daemon admission and provider credential/route
   *  availability check against an already-selected runtime. No paid probe is
   *  ever issued, an unknown quota is never treated as available (or zero), and
   *  failure never falls back to another candidate. */
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
    if (this.runtimeAvailability) {
      const availability = await this.runtimeAvailability(triple)
      if (!availability.available) {
        throw new TaskSettingsRuntimeUnavailableError(
          taskId,
          runtimeId,
          `provider '${triple.provider}' is not currently available`,
        )
      }
      return availability
    }
    return undefined
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
   *  native Codex/Cursor choices exist, exactly one bounded Forge provider
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
   *  rankAutoRoutingCandidates runs once and the matching exact choice is
   *  selected with no fallback. */
  private async resolveAutomaticSelection(
    params: AutomaticSelectionParams,
    previewMemo?: AutomaticPreviewMemo,
  ): Promise<AutomaticSelectionResult> {
    // Automatic price admission is finalized below from the request-time
    // horizon snapshot. Omitting only the price ceiling here lets a scheduled
    // DeepSeek tariff replace stale Catalog metadata; every non-DeepSeek
    // candidate is still checked against the same static reference by policy.
    const { maxOutputUsdPerMillion: _catalogPriceCeiling, ...intrinsicRequirements } = params.requirements
    const eligible = this.resolver.eligible({ taskName: params.taskName, requirements: intrinsicRequirements })
    if (!eligible.ok) return { ok: false, error: eligible.error }

    const quotaPromise = previewMemo?.quota
      ?? (this.quotaSnapshots
        ? this.quotaSnapshots.routingSnapshot()
        : Promise.resolve(null))
    if (previewMemo !== undefined) previewMemo.quota = quotaPromise

    const needsNative = needsNativeProviderReadiness(eligible.choices)
    let nativeReadinessPromise: Promise<ForgeProviderReadinessSnapshot | null> = Promise.resolve(null)
    if (needsNative && this.nativeProviderReadiness !== undefined) {
      nativeReadinessPromise = previewMemo?.nativeProviderReadiness
        ?? Promise.resolve()
          .then(() => this.nativeProviderReadiness!())
          .catch(() => null)
      if (previewMemo !== undefined) previewMemo.nativeProviderReadiness = nativeReadinessPromise
    }

    // Start the independent non-inference samples together and bind both
    // completed immutable results to every readiness decision in this
    // selection. A failed native sample remains explicit null/unknown and is
    // never retried or replaced inside the evaluation.
    const [boundSnapshot, nativeProviderReadiness]: [
      AutoRoutingBoundQuotaSnapshot | null,
      ForgeProviderReadinessSnapshot | null,
    ] = await Promise.all([quotaPromise, nativeReadinessPromise])
    const snapshot: AutoRoutingQuotaSnapshot | null = boundSnapshot?.snapshot ?? null
    const availabilityContext: TaskSettingsRuntimeAvailabilityContext = {
      codeBuddySnapshot: boundSnapshot?.codeBuddySnapshot,
      nativeProviderReadiness,
    }
    const nowMs = snapshot ? snapshot.nowMs : this.now()
    const blocked = new Set(snapshot ? snapshot.hardBlockedProviderIds : [])

    // Structured actual eliminations, recorded at the exact stage that empties
    // the surviving pool; deterministic selection never parses error text.
    const eliminations: TaskResolutionElimination[] = []
    const probed: AutomaticProbeEntry[] = []
    for (const choice of eligible.choices) {
      if (blocked.has(choice.provider)) {
        // A determinate hard-blocked provider is a real quota gate.
        eliminations.push(eliminationOf('quota_unavailable', boundedReferenceOutputUsdPerM(choice)))
        continue
      }
      const availability = await this.previewRuntimeAvailability(
        TaskSettingsService.tripleOf(choice),
        previewMemo,
        availabilityContext,
      )
      if (availability !== undefined && !availability.available) {
        // The live readiness probe rejected the exact choice: no available provider.
        eliminations.push({ code: 'no_available_provider' })
        continue
      }
      probed.push({ choice, availability })
    }
    const collapsed = collapseAutomaticChoices(probed)
    if (collapsed.length === 0) {
      return { ok: false, error: automaticSelectionFailure(params, eliminations) }
    }

    const caps: number[] = []
    if (typeof params.requirements.maxOutputUsdPerMillion === 'number') {
      caps.push(params.requirements.maxOutputUsdPerMillion)
    }
    if (params.maxAutoOutputUsdPerMillion !== undefined) {
      caps.push(params.maxAutoOutputUsdPerMillion)
    }
    const deepSeekPricing = new Map<string, DeepSeekAutomaticPricing>()
    for (const entry of collapsed) {
      const pricing = deepSeekAutomaticPricingOf(entry.choice, nowMs, params.timeoutMs)
      if (pricing !== undefined) deepSeekPricing.set(entry.choice.exactAgentRuntime, pricing)
    }
    const finiteReferences = collapsed
      .map((entry) => deepSeekPricing.get(entry.choice.exactAgentRuntime)?.safetyOutputUsdPerM
        ?? entry.choice.reference_pricing.output_usd_per_million)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    const capUsdPerM = caps.length > 0
      ? Math.min(...caps)
      : finiteReferences.length > 0
        ? Math.max(...finiteReferences)
        : 0

    const context: AutomaticSelectionContext = {
      snapshotId: snapshot ? snapshot.snapshotId : 'settings-no-quota-snapshot',
      nowMs,
      timeoutMs: params.timeoutMs,
      snapshot,
      capUsdPerM,
      minimumTps: finiteOrDefault(params.requirements.minimumTps, 0),
      intelligenceMinRank: intelligenceRankOf(params.requirements.intelligenceMin, 0),
      intelligenceMaxRank: intelligenceRankOf(params.requirements.intelligenceMax, INTELLIGENCE_ORDER.premium),
      intelligenceExpectedRank:
        params.requirements.intelligenceExpected === undefined
          ? undefined
          : intelligenceRankOf(params.requirements.intelligenceExpected, INTELLIGENCE_ORDER.premium),
    }

    const inputs: CandidateInput[] = []
    for (const entry of collapsed) {
      const pricing = deepSeekPricing.get(entry.choice.exactAgentRuntime)
      const candidate = toAutomaticCandidateInput(entry, context, pricing)
      if (candidate === null) {
        const referenceUsdPerM = pricing?.safetyOutputUsdPerM
          ?? entry.choice.reference_pricing.output_usd_per_million
        if (typeof referenceUsdPerM !== 'number' || !Number.isFinite(referenceUsdPerM) || referenceUsdPerM < 0) {
          eliminations.push(eliminationOf('price_limit'))
        } else {
          eliminations.push(eliminationOf('intelligence_requirement', referenceUsdPerM))
        }
        continue
      }
      inputs.push(candidate)
    }
    if (inputs.length === 0) {
      return { ok: false, error: automaticSelectionFailure(params, eliminations) }
    }

    const ranked = rankAutoRoutingCandidates(inputs)
    const best = ranked.ranked[0]
    if (!best) {
      // Every routed candidate was excluded by a real Catalog gate; each
      // exclusion reason maps to its closed code. Unknown reasons are not a
      // hard elimination, so they surface as no_available_provider.
      for (const exclusion of ranked.excluded) {
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
      quota_tier: best.tier,
      quota_coverage_complete: best.coverageComplete,
      quota_headroom_trusted: best.headroomTrusted,
      reference_output_usd_per_million: best.referenceUsdPerM,
      routing_output_usd_per_million: best.routingPriceUsdPerM,
      effective_cap_usd_per_million: context.capUsdPerM,
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
    const reason = `automatic selection rank ${best.rank}/${ranked.ranked.length} (${best.supplyClass}, quota tier ${best.tier})`
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

    if (patch.mode !== undefined) {
      if (patch.mode === null) {
        delete raw.selection_mode
      } else {
        raw.selection_mode = patch.mode as TaskSettingsMode
      }
    }

    if (patch.explicit_runtime !== undefined) {
      if (patch.explicit_runtime === null) {
        delete raw.explicit_runtime
      } else {
        // Structural reference (alias or inline target) is stored verbatim.
        // Alias usability is validated by the fresh save preflight, never here.
        raw.explicit_runtime = patch.explicit_runtime
      }
    }

    if (patch.timeout_ms !== undefined) {
      if (patch.timeout_ms === null) {
        delete raw.timeout_ms
      } else {
        raw.timeout_ms = patch.timeout_ms
      }
    }

    if (patch.max_auto_output_usd_per_million !== undefined) {
      if (patch.max_auto_output_usd_per_million === null) {
        delete raw.max_auto_output_usd_per_million
      } else {
        raw.max_auto_output_usd_per_million = patch.max_auto_output_usd_per_million
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

  /** Converts a canonical config layer into the JSON-safe snake_case layer DTO.
   *  The stored explicit reference (alias or inline target) is structural and
   *  is carried verbatim; a resolved triple is never copied back. */
  private toLayerDto(layer?: ConfigTaskSettingsLayer): TaskSettingsLayerDto {
    if (!layer) return {}
    return {
      ...(layer.selectionMode !== undefined ? { mode: layer.selectionMode } : {}),
      ...(layer.timeoutMs !== undefined ? { timeout_ms: layer.timeoutMs } : {}),
      ...(layer.dispatch !== undefined && Object.keys(layer.dispatch).length > 0
        ? { automatic: toSnakeDispatch(layer.dispatch) }
        : {}),
      ...(layer.explicitRuntime !== undefined ? { explicit_runtime: layer.explicitRuntime } : {}),
      ...(layer.maxAutoOutputUsdPerMillion !== undefined
        ? { max_auto_output_usd_per_million: layer.maxAutoOutputUsdPerMillion }
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
  maxAutoOutputUsdPerMillion: number | undefined
}

interface AutomaticProbeEntry {
  choice: TaskDispatchChoice
  availability?: TaskSettingsProviderAvailability
}

/** Request-scoped automatic-preview memo built per snapshot() request and
 *  passed through buildRow -> resolveAutomaticSelection for automatic rows
 *  only. It holds the request's single immutable quota snapshot (unknown/
 *  fail-closed results included) and one non-billable readiness probe promise
 *  per canonical runtime triple, so N automatic rows sharing the same eligible
 *  runtimes never repeat quota reads or identical credential reads. resolveForRun
 *  and save preflight never construct or pass a memo: they always probe fresh. */
interface AutomaticPreviewMemo {
  /** Immutable quota snapshot promise for this request, created on the first
   *  automatic row that needs one and reused by the rest of the rows. */
  quota?: Promise<AutoRoutingBoundQuotaSnapshot | null>
  /** One immutable authoritative native-provider status sample shared by all
   * relevant automatic rows in this snapshot request. Null is a sampled
   * failure and must never trigger a second query or optimistic fallback. */
  nativeProviderReadiness?: Promise<ForgeProviderReadinessSnapshot | null>
  /** Non-billable runtimeAvailability probe per canonical runtime triple. */
  availability: Map<string, Promise<TaskSettingsProviderAvailability>>
}

/** Canonical string key of a resolved runtime triple used to dedupe identical
 *  non-billable readiness probes within one snapshot request. */
function runtimeTripleKey(runtime: TaskSettingsRuntimeAvailabilityTarget): string {
  return `${runtime.provider}/${runtime.model}:${runtime.client}#${runtime.mode}`
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

interface AutomaticSelectionContext {
  snapshotId: string
  nowMs: number
  timeoutMs: number
  snapshot: AutoRoutingQuotaSnapshot | null
  capUsdPerM: number
  minimumTps: number
  intelligenceMinRank: number
  intelligenceMaxRank: number
  intelligenceExpectedRank: number | undefined
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function intelligenceRankOf(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const rank = INTELLIGENCE_ORDER[value as keyof typeof INTELLIGENCE_ORDER]
  return rank === undefined ? fallback : rank
}

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
 * Forge provider-status sample. This intentionally keys on the native client,
 * not the Catalog provider id: codex-spark shares the `codex` credential
 * resolver and native client while retaining its distinct quota provider id.
 * Gateway variants never consume native login state. */
function needsNativeProviderReadiness(choices: readonly TaskDispatchChoice[]): boolean {
  return choices.some((choice) =>
    choice.mode === 'native' && (choice.client === 'codex' || choice.client === 'cursor'),
  )
}

const DEEPSEEK_SAFETY_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1_000

interface DeepSeekAutomaticPricing {
  safetyOutputUsdPerM: number
  marginalPrice: NonNullable<CandidateInput['marginalPrice']>
  attemptReferencePricing: TaskResolvedDispatch['reference_pricing']
}

function deepSeekModelOf(dispatch: { provider: string; model: string }): DeepSeekPricingModel | undefined {
  // Only the active deepseek-flash tariff applies. Match exact CodeBuddy and
  // TokenHub model identities; retired ids must not resolve to a price.
  if (dispatch.provider === 'codebuddy' && dispatch.model === 'deepseek-v4.1-flash') return 'deepseek-flash'
  if (dispatch.provider === 'tokenhub' && dispatch.model === 'deepseek/deepseek-flash') return 'deepseek-flash'
  return undefined
}

function toTaskReferencePricing(pricing: DeepSeekReferencePricing): TaskResolvedDispatch['reference_pricing'] {
  return {
    input_usd_per_million: pricing.inputCacheMissPerMillion,
    cached_input_usd_per_million: pricing.inputCacheHitPerMillion,
    output_usd_per_million: pricing.outputPerMillion,
    source: pricing.sources.join(' | '),
    checked_at: pricing.checkedAt,
  }
}

/** Request-time DeepSeek evidence has two deliberately distinct prices: the
 *  applicable official peak/list price for hard admission and the worst
 *  actual peak/off-peak price inside this attempt for ranking and costing. */
function deepSeekAutomaticPricingOf(
  dispatch: { provider: string; model: string },
  nowMs: number,
  timeoutMs: number,
): DeepSeekAutomaticPricing | undefined {
  const model = deepSeekModelOf(dispatch)
  if (model === undefined) return undefined
  const throughMs = nowMs + timeoutMs
  const attempt = resolveDeepSeekReferencePricing({ model, currency: 'USD', at: nowMs, through: throughMs })
  // Any seven-day interval contains every UTC weekday peak window. Extending
  // only forward preserves the applicable tariff eras: pre-cut/crossing keeps
  // the old higher peak, while a horizon beginning at/after the cut never
  // reaches back into the retired table.
  const safety = resolveDeepSeekReferencePricing({
    model,
    currency: 'USD',
    at: nowMs,
    through: Math.max(throughMs, nowMs + DEEPSEEK_SAFETY_LOOKAHEAD_MS),
  })
  return {
    safetyOutputUsdPerM: safety.outputPerMillion,
    marginalPrice: {
      usdPerM: attempt.outputPerMillion,
      appliesFromMs: nowMs,
      appliesUntilMs: throughMs,
      source: attempt.sources.join(' | '),
      ruleId: `deepseek-official-tariff:${model}:${attempt.checkedAt}`,
      worst_applicable: 'worst_applicable',
    },
    attemptReferencePricing: toTaskReferencePricing(attempt),
  }
}

function withDeepSeekAttemptPricing(
  dispatch: TaskResolvedDispatch,
  nowMs: number,
  timeoutMs: number,
): TaskResolvedDispatch {
  const pricing = deepSeekAutomaticPricingOf(dispatch, nowMs, timeoutMs)
  return pricing === undefined
    ? dispatch
    : { ...dispatch, reference_pricing: pricing.attemptReferencePricing }
}

/** Builds one policy CandidateInput from truthful resolved dispatch evidence,
 *  the snapshot quota entry (or an empty unknown list), and the confirmed-free
 *  supply fact covering the routing timeout horizon. Returns null when the
 *  candidate cannot supply truthful reference/speed/intelligence evidence. */
function toAutomaticCandidateInput(
  entry: AutomaticProbeEntry,
  context: AutomaticSelectionContext,
  deepSeekPricing?: DeepSeekAutomaticPricing,
): CandidateInput | null {
  const choice = entry.choice
  const referenceUsdPerM = deepSeekPricing?.safetyOutputUsdPerM
    ?? choice.reference_pricing.output_usd_per_million
  if (typeof referenceUsdPerM !== 'number' || !Number.isFinite(referenceUsdPerM) || referenceUsdPerM < 0) {
    return null
  }
  const intelligenceRank = INTELLIGENCE_ORDER[choice.intelligence as keyof typeof INTELLIGENCE_ORDER]
  if (intelligenceRank === undefined || !Number.isFinite(intelligenceRank)) return null
  const quotaEntry = context.snapshot?.entries.find(
    (candidate) => candidate.providerId === choice.provider && candidate.modelId === choice.model,
  )
  const requiredQuota = quotaEntry?.requiredQuota ?? []
  const freeFact = entry.availability?.freeSupply
  return {
    snapshotId: context.snapshotId,
    canonicalId: choice.exactAgentRuntime,
    nowMs: context.nowMs,
    referenceUsdPerM,
    referenceKind: 'listed',
    effectiveCapUsdPerM: context.capUsdPerM,
    timeoutMs: context.timeoutMs,
    minimumTps: context.minimumTps,
    effectiveTps: choice.speed.effective_tps,
    intelligenceRank,
    intelligenceMinRank: context.intelligenceMinRank,
    intelligenceMaxRank: context.intelligenceMaxRank,
    intelligenceExpectedRank: context.intelligenceExpectedRank,
    requiredQuota,
    ...(deepSeekPricing !== undefined ? { marginalPrice: deepSeekPricing.marginalPrice } : {}),
    confirmedFreeSupply: freeFact
      ? {
          kind: 'confirmed_free',
          appliesFromMs: context.nowMs,
          appliesUntilMs: context.nowMs + context.timeoutMs,
          source: freeFact.source,
          ruleId: freeFact.ruleId,
        }
      : null,
  }
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
  expected_tps: { value: number | null; source: TaskSettingsSourceLayer }
  minimum_tps: { value: number | null; source: TaskSettingsSourceLayer }
  intelligence_min: { value: 'low' | 'mid' | 'high' | 'premium' | null; source: TaskSettingsSourceLayer }
  intelligence_max: { value: 'low' | 'mid' | 'high' | 'premium' | null; source: TaskSettingsSourceLayer }
  intelligence_expected: { value: 'low' | 'mid' | 'high' | 'premium' | null; source: TaskSettingsSourceLayer }
  max_output_usd_per_million: { value: number | null; source: TaskSettingsSourceLayer }
  required_capabilities: { value: Array<'text' | 'image'> | null; source: TaskSettingsSourceLayer }
  exclude_model_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_profile_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_client_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_provider_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
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
    selectionMode: toSourceLayer(sources.selectionMode),
    explicitRuntime: toSourceLayer(sources.explicitRuntime),
    timeoutMs: toSourceLayer(sources.timeoutMs),
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
          // Definitions never pin a runtime: only timeout/dispatch/prompt
          // metadata is projected; no agentRuntime/profile is derived.
          const target = resolveTaskTarget(item.name, workspaceRoot, project)
          const config = target?.definition.config
          const record = item as {
            project?: unknown
            source?: unknown
            description?: unknown
            timeoutMs?: unknown
            dispatch?: unknown
            promptTemplate?: unknown
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
            ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
            ...(record.dispatch !== undefined
              ? { dispatch: record.dispatch }
              : {}),
            ...(record.promptTemplate === 'dynamic' || record.promptTemplate === 'fixed'
              ? { promptTemplate: record.promptTemplate }
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
        ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
        ...(record.dispatch !== undefined ? { dispatch: record.dispatch } : {}),
        ...(record.promptTemplate === 'dynamic' || record.promptTemplate === 'fixed'
          ? { promptTemplate: record.promptTemplate }
          : {}),
        instructionTemplate: taskInstructionTemplate(config),
      }
      return {
        ...summary,
        ...(record.permission === 'readonly' || record.permission === 'edit' || record.permission === 'yolo'
          ? { permission: record.permission }
          : {}),
        ...(record.input_schema !== undefined ? { input_schema: record.input_schema } : {}),
        ...(record.output_schema !== undefined ? { output_schema: record.output_schema } : {}),
      } as TaskSettingsDefinitionDetail
    },
  }
}
