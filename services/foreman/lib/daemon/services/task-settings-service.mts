import { createHash } from 'node:crypto'
import type { TaskDispatchResolver } from '../../core/task/dispatch-resolver.mts'
import { TaskService } from '../../core/task/service.mts'
import { synthesizeAgentRuntime } from '../../core/agent-runtime.mts'
import { resolveTaskTarget } from '../../workspace/definition-registry.mts'
import type { ForemanConfigStore } from '../../config/manager.mts'
import { JsonForemanConfigStore } from '../../config/manager.mts'
import {
  TASK_DISPATCH_FIELDS,
  taskDefaultsToSettingsLayer,
  taskSettingsIdentity,
  readBuiltinSettingsSelection,
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
  TaskSettingsAutomaticDispatch,
  TaskSettingsExplicitRow,
  TaskSettingsExplicitRuntime,
  TaskSettingsLayer as TaskSettingsLayerDto,
  TaskSettingsMode,
  TaskSettingsPatch,
  TaskSettingsRuntimeReadiness,
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
 * `tasks.agentRuntime` map is read only as builtin compatibility (through
 * `readBuiltinSettingsSelection`) and is never written.
 *
 * Effective settings resolve through config/task-settings.mts, merging the
 * system defaults, builtin task defaults, user global, user per-task, and (for
 * runs) invocation layers right-wins. Snapshot/preflight never performs a paid
 * model call: automatic mode validates via `TaskDispatchResolver.resolve` and
 * explicit mode via `resolveExplicit`/`listExactRuntimes`, with daemon
 * admission and live provider credential/availability supplied by injected
 * non-billable callbacks.
 */
export interface TaskSettingsDefinitionSummary {
  name: string
  kind?: 'builtin' | 'project'
  project?: string
  source?: string
  description?: string
  agentRuntime?: string
  timeoutMs?: number
  dispatch?: unknown
  promptTemplate?: 'dynamic' | 'fixed'
}

export interface TaskSettingsDefinitionDetail extends TaskSettingsDefinitionSummary {
  permission?: 'readonly' | 'edit' | 'yolo'
  input_schema?: unknown
  output_schema?: unknown
}

export interface TaskSettingsDefinitionSource {
  list(project?: string): TaskSettingsDefinitionSummary[] | Promise<TaskSettingsDefinitionSummary[]>
  describe(taskId: string, project?: string): TaskSettingsDefinitionDetail | Promise<TaskSettingsDefinitionDetail>
}

export interface TaskSettingsProviderAvailability {
  providerCredential: 'available' | 'missing' | 'unknown'
  providerLive: 'available' | 'unavailable' | 'unknown'
  quota: 'available' | 'unavailable' | 'unknown'
  available: boolean
}

export type TaskSettingsRuntimeAvailabilityCallback = (
  runtime: TaskSettingsExplicitRuntime,
) => Promise<TaskSettingsProviderAvailability> | TaskSettingsProviderAvailability

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
  if (layer.agentRuntime !== undefined) raw.agent_runtime = layer.agentRuntime
  if (layer.timeoutMs !== undefined) raw.timeout_ms = layer.timeoutMs
  if (layer.additionalInstructions !== undefined) raw.additional_instructions = layer.additionalInstructions
  if (layer.dispatch !== undefined && Object.keys(layer.dispatch).length > 0) {
    raw.dispatch = toSnakeDispatch(layer.dispatch)
  }
  return raw
}

export class TaskSettingsService {
  private readonly configPath: string
  private readonly resolver: TaskDispatchResolver
  private readonly store: ForemanConfigStore
  private readonly definitions: TaskSettingsDefinitionSource
  private readonly daemonAvailability?: TaskSettingsDaemonAvailabilityCallback
  private readonly runtimeAvailability?: TaskSettingsRuntimeAvailabilityCallback
  private exactRuntimeIdsCache: readonly string[] | undefined

  constructor(options: TaskSettingsServiceOptions) {
    this.configPath = options.configPath
    this.resolver = options.resolver
    this.store = options.store ?? new JsonForemanConfigStore()
    this.definitions = options.definitions ?? createWorkspaceDefinitionSource(options.workspaceRoot)
    this.daemonAvailability = options.daemonAvailability
    this.runtimeAvailability = options.runtimeAvailability
  }

  /** The authoritative config path this daemon-owned service reads and writes. */
  get authoritativeConfigPath(): string {
    return this.configPath
  }

  private exactRuntimeIds(): readonly string[] {
    if (this.exactRuntimeIdsCache === undefined) {
      const listed = this.resolver.listExactRuntimes({ taskName: 'task-settings' })
      this.exactRuntimeIdsCache = listed.ok ? listed.items.map((item) => item.exactAgentRuntime) : []
    }
    return this.exactRuntimeIdsCache
  }

  /** Maps an exact runtime id (`forge/<profile>`) to its client/provider/model
   *  triple, or null when no available exact candidate carries that id. */
  private exactRuntimeTriple(runtimeId: string): TaskSettingsExplicitRuntime | null {
    const items = this.resolver.listExactRuntimes({ taskName: 'task-settings' })
    if (!items.ok) return null
    const match = items.items.find(
      (item) => item.available && item.resolved !== undefined && item.exactAgentRuntime === runtimeId,
    )
    if (!match?.resolved) return null
    return {
      client: match.resolved.client,
      provider: match.resolved.provider,
      model: match.resolved.model,
    }
  }

  /** Maps an explicit client/provider/model triple back to one exact runtime id. */
  private exactRuntimeIdForTriple(triple: TaskSettingsExplicitRuntime): string | null {
    const items = this.resolver.listExactRuntimes({ taskName: 'task-settings' })
    if (!items.ok) return null
    const matches = items.items.filter(
      (item) =>
        item.available
        && item.resolved !== undefined
        && item.resolved.client === triple.client
        && item.resolved.provider === triple.provider
        && item.resolved.model === triple.model,
    )
    if (matches.length !== 1) return null
    return matches[0]!.exactAgentRuntime
  }

  /** Maps a non-persistent public snake_case invocation layer into the canonical
   *  config layer. An explicit_runtime triple is converted back to the one exact
   *  runtime id, rejecting triples that identify no single currently-available
   *  exact runtime. The invocation layer is never written to config. */
  private invocationLayerToCanonical(
    invocation: TaskSettingsLayerDto,
  ): ConfigTaskSettingsLayer {
    const raw: Record<string, unknown> = {}
    if (invocation.mode !== undefined && invocation.mode !== null) {
      raw.selectionMode = invocation.mode
    }
    if (invocation.explicit_runtime !== undefined && invocation.explicit_runtime !== null) {
      const runtimeId = this.exactRuntimeIdForTriple(invocation.explicit_runtime)
      if (runtimeId === null) {
        throw new TaskSettingsInvalidSettingsError(
          `explicit_runtime ${JSON.stringify(invocation.explicit_runtime)} does not map to exactly one available exact runtime`,
        )
      }
      raw.agentRuntime = runtimeId
    }
    if (invocation.timeout_ms !== undefined && invocation.timeout_ms !== null) {
      raw.timeoutMs = invocation.timeout_ms
    }
    if (
      invocation.additional_instructions !== undefined
      && invocation.additional_instructions !== null
    ) {
      raw.additionalInstructions = invocation.additional_instructions
    }
    if (invocation.automatic !== undefined && invocation.automatic !== null) {
      raw.dispatch = invocation.automatic
    }
    return normalizeTaskSettingsLayer(raw, { scope: 'invocation settings' })
  }

  /** Resolves the authoritative settings for one task run at execution time.
   *  The authoritative config is read here at call time and the five layers
   *  (system defaults -> builtin Task defaults supplied by the kernel ->
   *  user global -> stable per-task incl. legacy builtin compatibility ->
   *  invocation) merge right-wins through the config/task-settings.mts
   *  resolver — no second merge algorithm. The invocation layer is
   *  non-persistent. Automatic mode resolves with the effective dispatch only
   *  (never a stale inherited exact runtime as a pin); explicit mode calls
   *  resolveExplicit with only required capabilities. Both modes then run the
   *  same non-billable live daemon/provider readiness checks exactly once
   *  against the selected runtime and fail without fallback. */
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

    const builtinLayer = taskDefaultsToSettingsLayer(
      {
        ...(params.defaults?.agentRuntime !== undefined ? { runtime: params.defaults.agentRuntime } : {}),
        ...(params.defaults?.timeoutMs !== undefined ? { timeoutMs: params.defaults.timeoutMs } : {}),
        dispatch: rawDefinitionDispatch(params.defaults?.dispatch),
      },
      { exactRuntimeIds: this.exactRuntimeIds() },
    )

    const userTaskLayer = kind === 'builtin'
      ? readBuiltinSettingsSelection(tasks, params.taskName).layer
      : readPerTaskSettings(tasks, identity)

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
      const runtimeId = effective.runtime
      if (runtimeId === undefined) {
        throw new TaskSettingsInvalidSettingsError('explicit mode requires an exact runtime selection')
      }
      const capabilities = effective.dispatch.requiredCapabilities
      const explicitResolution = this.resolver.resolveExplicit({
        taskName: params.taskName,
        exactRuntime: runtimeId,
        ...(capabilities !== undefined && capabilities.length > 0 ? { requiredCapabilities: capabilities } : {}),
      })
      if (!explicitResolution.ok) {
        // Explicit mode bypasses automatic ranking and never falls back.
        throw explicitResolution.error
      }
      // Same non-billable live daemon admission and provider credential/route
      // readiness check shared by automatic runs and snapshot/save preflight,
      // run once against the runtime resolveExplicit selected; failure never
      // falls back to another candidate.
      await this.assertLiveRuntimeAvailability(params.taskName, runtimeId, {
        client: explicitResolution.resolved.client,
        provider: explicitResolution.resolved.provider,
        model: explicitResolution.resolved.model,
      })
      return {
        mode: 'explicit',
        exactAgentRuntime: runtimeId,
        dispatch: explicitResolution.resolved,
        timeoutMs: effective.timeoutMs,
        ...(effective.additionalInstructions !== undefined
          ? { additionalInstructions: effective.additionalInstructions }
          : {}),
        sources: toRunSources(effective.sources),
      }
    }

    // Automatic mode: pass only the effective dispatch to resolver.resolve; any
    // inherited exact runtime declaration is a stale pin and is deliberately
    // never forwarded as an exactRuntime constraint.
    const resolution = this.resolver.resolve({
      taskName: params.taskName,
      requirements: effective.dispatch as ConfigTaskDispatchRequirements,
    })
    if (!resolution.ok) throw resolution.error
    // Automatic actual runs run the same non-billable live daemon admission and
    // provider credential/route availability check as explicit runs, exactly
    // once against the runtime resolver.resolve selected. Failure fails the run
    // without a second resolver call and without falling back to another
    // candidate; no paid probe is issued.
    await this.assertLiveRuntimeAvailability(params.taskName, resolution.exactAgentRuntime, {
      client: resolution.resolved.client,
      provider: resolution.resolved.provider,
      model: resolution.resolved.model,
    })
    return {
      mode: 'automatic',
      exactAgentRuntime: resolution.exactAgentRuntime,
      dispatch: resolution.resolved,
      timeoutMs: effective.timeoutMs,
      ...(effective.additionalInstructions !== undefined
        ? { additionalInstructions: effective.additionalInstructions }
        : {}),
      sources: toRunSources(effective.sources),
    }
  }

  async snapshot(params: TaskSettingsSnapshotParams = {}): Promise<TaskSettingsSnapshotResult> {
    const { record, revision } = this.readConfigRecord()
    const tasks = tasksSectionOf(record)
    const userGlobal = readGlobalTaskSettings(tasks)

    const summaries = await this.definitions.list(params.project)
    const rows: TaskSettingsTaskRow[] = []
    for (const summary of summaries) {
      if (params.task_id !== undefined && summary.name !== params.task_id) continue
      rows.push(await this.buildRow(summary, params.project, tasks, userGlobal))
    }

    return {
      config_path: this.configPath,
      revision,
      ...(params.project !== undefined ? { project: params.project } : {}),
      user_global: this.toLayerDto(userGlobal),
      rows,
    }
  }

  async save(params: TaskSettingsSaveParams): Promise<TaskSettingsSnapshotResult> {
    if (params.scope === 'task') {
      const taskId = params.task_id?.trim() ?? ''
      if (!taskId) throw new TaskSettingsTaskNotFoundError(params.task_id ?? '')
      const summaries = await this.definitions.list(params.project)
      const summary = summaries.find((entry) => entry.name === taskId)
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
    if (nextGlobal?.selectionMode === 'explicit' && nextGlobal.agentRuntime === undefined) {
      throw new TaskSettingsInvalidSettingsError('global explicit mode requires an exact explicit_runtime selection')
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
    const taskId = params.task_id?.trim() ?? ''
    const current = this.readConfigRecord()
    if (current.revision !== params.expected_revision) {
      throw new TaskSettingsContentConflictError(params.expected_revision, current.revision)
    }

    const kind: 'builtin' | 'project' = summary.kind
      ?? (summary.project !== undefined || params.project !== undefined ? 'project' : 'builtin')
    const identity = taskSettingsIdentity({
      kind,
      name: taskId,
      ...(kind === 'project' ? { project: summary.project ?? params.project } : {}),
    })

    const tasks = tasksSectionOf(current.record)
    const baselineLayer = kind === 'builtin'
      ? readBuiltinSettingsSelection(tasks, taskId).layer
      : readPerTaskSettings(tasks, identity)
    const nextLayer = this.applyPatchToLayer(baselineLayer, params.patch)

    if (nextLayer !== undefined) {
      const builtinLayer = taskDefaultsToSettingsLayer(
        {
          runtime: summary.agentRuntime,
          ...(summary.timeoutMs !== undefined ? { timeoutMs: summary.timeoutMs } : {}),
          dispatch: rawDefinitionDispatch(summary.dispatch),
        },
        { exactRuntimeIds: this.exactRuntimeIds() },
      )
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
        if (effective.runtime === undefined) {
          throw new TaskSettingsInvalidSettingsError('explicit mode requires an exact runtime selection')
        }
        const triple = this.resolveExplicitRoute(taskId, effective.runtime, effective.dispatch.requiredCapabilities)
        await this.assertLiveRuntimeAvailability(taskId, effective.runtime, triple)
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
    return this.snapshot({ project: params.project, task_id: taskId })
  }

  private summaryDefaults(summary: TaskSettingsDefinitionSummary, detail?: TaskSettingsDefinitionDetail): {
    runtime?: string
    timeoutMs?: number
    dispatch: ConfigTaskDispatchRequirements
  } {
    return {
      ...(summary.agentRuntime !== undefined ? { runtime: summary.agentRuntime } : {}),
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
      detail = await this.definitions.describe(summary.name, project)
    } catch {
      detail = undefined
    }

    const builtinLayer = taskDefaultsToSettingsLayer(this.summaryDefaults(summary, detail), {
      exactRuntimeIds: this.exactRuntimeIds(),
    })

    const userTaskLayer = kind === 'builtin'
      ? readBuiltinSettingsSelection(tasks, summary.name).layer
      : readPerTaskSettings(tasks, identity)

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
    const automatic = toEffectiveAutomatic(effective.dispatch, effective.sources.dispatch)

    let explicitRow: TaskSettingsExplicitRow | undefined
    const runtimeId = effective.runtime
    const capabilities = effective.dispatch.requiredCapabilities
    // Authoritative explicit-mode picker input: exact existing runtimes the
    // resolver can select for this task's required capabilities. Enumerated once
    // regardless of the effective mode so an automatic row can offer explicit
    // selection without fabricating a current explicit runtime. Only available
    // items with truthful resolved metadata are projected; no paid probe is
    // issued and no default explicit runtime is selected.
    const listed = this.resolver.listExactRuntimes({
      taskName: summary.name,
      ...(capabilities !== undefined && capabilities.length > 0 ? { requiredCapabilities: capabilities } : {}),
    })
    const runtimeChoices = listed.ok
      ? listed.items
        .filter((item) => item.available && item.resolved !== undefined)
        .map((item) => ({ ...item.resolved!, exactAgentRuntime: item.exactAgentRuntime }))
      : []
    if (effective.mode === 'explicit') {
      if (runtimeId === undefined) {
        issues.push({
          code: 'invalid_settings',
          message: 'explicit mode is selected but no exact runtime is available',
        })
      } else {
        const explicitResolution = this.resolver.resolveExplicit({
          taskName: summary.name,
          exactRuntime: runtimeId,
          ...(capabilities !== undefined && capabilities.length > 0 ? { requiredCapabilities: capabilities } : {}),
        })
        if (explicitResolution.ok) {
          const resolved = { ...explicitResolution.resolved, exactAgentRuntime: explicitResolution.exactAgentRuntime }
          const triple = {
            client: explicitResolution.resolved.client,
            provider: explicitResolution.resolved.provider,
            model: explicitResolution.resolved.model,
          }
          const readiness = await this.runtimeReadiness(
            summary.name,
            explicitResolution.exactAgentRuntime,
            triple,
          )
          explicitRow = { runtime: triple, choices: runtimeChoices, resolved, readiness }
        } else {
          issues.push({
            code: 'explicit_runtime_unavailable',
            message: explicitResolution.error.message,
          })
          const fallbackTriple = this.exactRuntimeTriple(runtimeId)
          if (fallbackTriple !== null) {
            explicitRow = { runtime: fallbackTriple, choices: runtimeChoices, resolved: null, readiness: null }
          }
        }
      }
    } else {
      const resolution = this.resolver.resolve({
        taskName: summary.name,
        requirements: effective.dispatch as ConfigTaskDispatchRequirements,
      })
      if (!resolution.ok) {
        issues.push({
          code: 'automatic_dispatch_unavailable',
          message: resolution.error.message,
        })
      }
    }

    return {
      identity,
      name: summary.name,
      ...(projectName !== undefined ? { project: projectName } : {}),
      builtin: {
        identity,
        name: summary.name,
        source,
        ...(description !== undefined ? { description } : {}),
        ...(projectName !== undefined ? { project: projectName } : {}),
        prompt_template: summary.promptTemplate ?? detail?.promptTemplate ?? 'dynamic',
        declared_runtime: builtinLayer.agentRuntime ?? null,
        timeout_ms: builtinLayer.timeoutMs ?? null,
        dispatch: toSnakeDispatch(builtinLayer.dispatch ?? {}),
      },
      user_task: this.toLayerDto(userTaskLayer),
      effective: {
        mode: { value: effective.mode as TaskSettingsMode, source: toSourceLayer(effective.sources.selectionMode) },
        explicit_runtime: {
          value: runtimeId === undefined ? null : this.exactRuntimeTriple(runtimeId),
          source: toSourceLayer(effective.sources.agentRuntime),
        },
        timeout_ms: { value: effective.timeoutMs, source: toSourceLayer(effective.sources.timeoutMs) },
        additional_instructions: {
          value: effective.additionalInstructions ?? null,
          source: toSourceLayer(effective.sources.additionalInstructions),
        },
        automatic,
      },
      runtime_choices: runtimeChoices,
      ...(explicitRow !== undefined ? { explicit: explicitRow } : {}),
      issues,
    }
  }

  private async runtimeReadiness(
    taskName: string,
    exactRuntime: string,
    runtime: TaskSettingsExplicitRuntime,
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

  /** Explicit resolver route/capability validation (snapshot/save preflight).
   *  Never falls back to another runtime or to automatic ranking. Resolves the
   *  selected exact runtime into its client/provider/model triple. */
  private resolveExplicitRoute(
    taskId: string,
    runtimeId: string,
    requiredCapabilities: ConfigTaskDispatchRequirements['requiredCapabilities'],
  ): { client: string; provider: string; model: string } {
    const explicitResolution = this.resolver.resolveExplicit({
      taskName: taskId,
      exactRuntime: runtimeId,
      ...(requiredCapabilities !== undefined && requiredCapabilities.length > 0
        ? { requiredCapabilities }
        : {}),
    })
    if (!explicitResolution.ok) {
      throw new TaskSettingsInvalidSettingsError(explicitResolution.error.message)
    }
    const resolved = explicitResolution.resolved
    return { client: resolved.client, provider: resolved.provider, model: resolved.model }
  }

  /** Non-billable live daemon admission and provider credential/route
   *  availability check against an already-selected runtime. No paid probe is
   *  ever issued, an unknown quota is never treated as available (or zero), and
   *  failure never falls back to another candidate. */
  private async assertLiveRuntimeAvailability(
    taskId: string,
    runtimeId: string,
    triple: { client: string; provider: string; model: string },
  ): Promise<void> {
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
        delete raw.agent_runtime
      } else {
        const runtimeId = this.exactRuntimeIdForTriple(patch.explicit_runtime)
        if (runtimeId === null) {
          throw new TaskSettingsInvalidSettingsError(
            `explicit_runtime ${JSON.stringify(patch.explicit_runtime)} does not match an existing exact runtime`,
          )
        }
        raw.agent_runtime = runtimeId
      }
    }

    if (patch.timeout_ms !== undefined) {
      if (patch.timeout_ms === null) {
        delete raw.timeout_ms
      } else {
        raw.timeout_ms = patch.timeout_ms
      }
    }

    if (patch.additional_instructions !== undefined) {
      if (patch.additional_instructions === null) {
        delete raw.additional_instructions
      } else {
        raw.additional_instructions = patch.additional_instructions
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
   *  The stored exact runtime id is mapped back to an explicit_runtime triple
   *  when an available candidate still carries it; otherwise the field is
   *  omitted (the effective row reports the precise issue). */
  private toLayerDto(layer?: ConfigTaskSettingsLayer): TaskSettingsLayerDto {
    if (!layer) return {}
    return {
      ...(layer.selectionMode !== undefined ? { mode: layer.selectionMode } : {}),
      ...(layer.timeoutMs !== undefined ? { timeout_ms: layer.timeoutMs } : {}),
      ...(layer.additionalInstructions !== undefined
        ? { additional_instructions: layer.additionalInstructions }
        : {}),
      ...(layer.dispatch !== undefined && Object.keys(layer.dispatch).length > 0
        ? { automatic: toSnakeDispatch(layer.dispatch) }
        : {}),
      ...(layer.agentRuntime !== undefined
        ? (() => {
          const triple = this.exactRuntimeTriple(layer.agentRuntime!)
          return triple !== null ? { explicit_runtime: triple } : {}
        })()
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

interface TaskSettingsEffectiveAutomaticDto {
  expected_tps: { value: number | null; source: TaskSettingsSourceLayer }
  minimum_tps: { value: number | null; source: TaskSettingsSourceLayer }
  intelligence_min: { value: 'low' | 'mid' | 'high' | 'frontier' | 'premium' | null; source: TaskSettingsSourceLayer }
  intelligence_max: { value: 'low' | 'mid' | 'high' | 'frontier' | 'premium' | null; source: TaskSettingsSourceLayer }
  max_output_usd_per_million: { value: number | null; source: TaskSettingsSourceLayer }
  required_capabilities: { value: Array<'text' | 'image'> | null; source: TaskSettingsSourceLayer }
  exclude_model_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_profile_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_client_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  exclude_provider_ids: { value: string[] | null; source: TaskSettingsSourceLayer }
  preferred_runtime: { value: TaskSettingsExplicitRuntime | null; source: TaskSettingsSourceLayer }
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
    agentRuntime: toSourceLayer(sources.agentRuntime),
    timeoutMs: toSourceLayer(sources.timeoutMs),
    additionalInstructions: toSourceLayer(sources.additionalInstructions),
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
  return {
    async list(project) {
      const items = await getService().list(project)
      return Array.isArray(items)
        ? items.map((item) => {
          const target = resolveTaskTarget(item.name, workspaceRoot, project)
          const config = target?.definition.config
          const declaredAgentRuntime = config?.agentRuntime
            ?? (config?.profile ? synthesizeAgentRuntime(config.profile).toString() : undefined)
          const record = item as {
            project?: unknown
            source?: unknown
            description?: unknown
            timeoutMs?: unknown
            dispatch?: unknown
            promptTemplate?: unknown
          }
          const projectName = record.project !== undefined ? String(record.project) : undefined
          return {
            name: item.name,
            ...(projectName !== undefined
              ? { kind: 'project' as const, project: projectName }
              : { kind: 'builtin' as const }),
            ...(record.source !== undefined ? { source: String(record.source) } : {}),
            ...(record.description !== undefined ? { description: String(record.description) } : {}),
            ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
            ...(declaredAgentRuntime !== undefined
              ? { agentRuntime: declaredAgentRuntime }
              : {}),
            ...(record.dispatch !== undefined
              ? { dispatch: record.dispatch }
              : {}),
            ...(record.promptTemplate === 'dynamic' || record.promptTemplate === 'fixed'
              ? { promptTemplate: record.promptTemplate }
              : {}),
          }
        })
        : []
    },
    async describe(taskId, project) {
      const detail = await getService().describe(taskId, project)
      const record = detail as unknown as Record<string, unknown>
      const target = resolveTaskTarget(taskId, workspaceRoot, project)
      const config = target?.definition.config
      const declaredAgentRuntime = config?.agentRuntime
        ?? (config?.profile ? synthesizeAgentRuntime(config.profile).toString() : undefined)
      const summary: TaskSettingsDefinitionSummary = {
        name: String(record.name ?? ''),
        ...(record.project !== undefined
          ? { kind: 'project' as const, project: String(record.project) }
          : { kind: 'builtin' as const }),
        ...(record.source !== undefined ? { source: String(record.source) } : {}),
        ...(record.description !== undefined ? { description: String(record.description) } : {}),
        ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
        ...(declaredAgentRuntime !== undefined ? { agentRuntime: declaredAgentRuntime } : {}),
        ...(record.dispatch !== undefined ? { dispatch: record.dispatch } : {}),
        ...(record.promptTemplate === 'dynamic' || record.promptTemplate === 'fixed'
          ? { promptTemplate: record.promptTemplate }
          : {}),
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
