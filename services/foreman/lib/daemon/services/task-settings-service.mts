import { createHash } from 'node:crypto'
import type { TaskDispatchRequirements } from '@wrenyard/catalog'
import type { ForemanConfigStore } from '../../config/manager.mts'
import { JsonForemanConfigStore } from '../../config/manager.mts'
import type { TaskDispatchResolver } from '../../core/task/dispatch-resolver.mts'
import { TaskService } from '../../core/task/service.mts'
import { synthesizeAgentRuntime } from '../../core/agent-runtime.mts'
import { resolveTaskTarget } from '../../workspace/definition-registry.mts'
import type {
  TaskSettingsSaveParams,
  TaskSettingsSnapshotParams,
  TaskSettingsSnapshotResult,
  TaskSettingsTaskRow,
} from '../../protocol/methods/task.mts'

/**
 * A definition source exposes the read-only contract metadata the snapshot
 * reports. The daemon default scans the workspace via `TaskService`; tests may
 * inject a deterministic fixture. `source`/`permission`/`schema`/`dispatch`
 * metadata is read-only — the settings service never mutates it.
 */
export interface TaskSettingsDefinitionSummary {
  name: string
  project?: string
  source?: string
  agentRuntime?: string
  dispatch?: unknown
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

export interface TaskSettingsServiceOptions {
  workspaceRoot: string
  /** Authoritative resolved config file the daemon is running against. */
  configPath: string
  /** Shared daemon dispatch resolver; eligibility comes from this instance only. */
  resolver: TaskDispatchResolver
  store?: ForemanConfigStore
  env?: NodeJS.ProcessEnv
  definitions?: TaskSettingsDefinitionSource
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

export class TaskSettingsIneligibleRuntimeError extends Error {
  readonly code = 'ineligible_agent_runtime' as const
  constructor(
    readonly taskId: string,
    readonly agentRuntime: string,
  ) {
    super(`agent runtime '${agentRuntime}' is not an eligible exact choice for task '${taskId}'`)
    this.name = 'TaskSettingsIneligibleRuntimeError'
  }
}

/**
 * Daemon-owned TaskSettingsService backing the human Tasks page
 * (`task.settings.snapshot` / `task.settings.save`).
 *
 * Preferences are machine-global by *bare task name*: even when a project is
 * selected the key written is `tasks.agentRuntime[<task_id>]`, shared by every
 * same-named task across projects.
 *
 * `save` is CAS-safe: the caller's `expected_revision` must match a
 * deterministic content revision of the current config file; any divergence is
 * a typed `content_conflict` and the file is never written. Only the single
 * key `tasks.agentRuntime[<bare task name>]` is updated or deleted; every
 * unrelated and unknown key is preserved and the write is atomic. Only exact
 * agent runtimes currently present in the task's resolver `eligible` choices
 * may be selected (or `null` to reset); legacy policy aliases such as
 * `forge/fast`, `forge/general`, and `forge/ultra` are always rejected.
 */
export class TaskSettingsService {
  private readonly configPath: string
  private readonly resolver: TaskDispatchResolver
  private readonly store: ForemanConfigStore
  private readonly definitions: TaskSettingsDefinitionSource

  constructor(options: TaskSettingsServiceOptions) {
    this.configPath = options.configPath
    this.resolver = options.resolver
    this.store = options.store ?? new JsonForemanConfigStore()
    this.definitions = options.definitions ?? createWorkspaceDefinitionSource(options.workspaceRoot)
  }

  /** The authoritative config path this daemon-owned service reads and writes. */
  get authoritativeConfigPath(): string {
    return this.configPath
  }

  async snapshot(params: TaskSettingsSnapshotParams = {}): Promise<TaskSettingsSnapshotResult> {
    const { record, revision } = this.readConfigRecord()
    const machinePreferences = readMachinePreferences(record)

    const summaries = await this.definitions.list(params.project)
    const rows: TaskSettingsTaskRow[] = []
    for (const summary of summaries) {
      const taskId = summary.name
      const declared = summary.agentRuntime && summary.agentRuntime.trim() ? summary.agentRuntime : null
      const machinePreference = machinePreferences[taskId] ?? null

      // Read-only contract metadata (best-effort: a describe failure must not
      // drop the row — the settings surface only reports, never edits these).
      let detail: TaskSettingsDefinitionDetail | undefined
      try {
        detail = await this.definitions.describe(taskId, params.project)
      } catch {
        detail = undefined
      }

      const eligibility = this.resolver.eligible({
        taskName: taskId,
        requirements: toDispatchRequirements(summary.dispatch),
        declaredRuntime: declared ?? undefined,
      })
      const eligible = eligibility.ok ? eligibility.choices : []

      rows.push({
        task_id: taskId,
        project: summary.project ?? params.project ?? '',
        source: summary.source ?? detail?.source ?? '',
        ...(detail?.permission !== undefined ? { permission: detail.permission } : {}),
        ...(detail?.input_schema !== undefined ? { input_schema: detail.input_schema } : {}),
        ...(detail?.output_schema !== undefined ? { output_schema: detail.output_schema } : {}),
        ...(summary.dispatch !== undefined
          ? { dispatch: summary.dispatch as TaskSettingsTaskRow['dispatch'] }
          : {}),
        declared_agent_runtime: declared,
        machine_preference: machinePreference,
        selection: {
          agent_runtime: machinePreference,
          source: machinePreference !== null ? 'machine' : 'automatic',
        },
        eligible,
      })
    }

    return {
      config_path: this.configPath,
      revision,
      scope: 'machine_global',
      keyed_by: 'bare_task_name',
      ...(params.project !== undefined ? { project: params.project } : {}),
      tasks: rows,
    }
  }

  async save(params: TaskSettingsSaveParams): Promise<TaskSettingsSnapshotResult> {
    const taskId = params.task_id.trim()
    if (!taskId) throw new TaskSettingsTaskNotFoundError(params.task_id)

    const summaries = await this.definitions.list(params.project)
    const summary = summaries.find((entry) => entry.name === taskId)
    if (!summary) throw new TaskSettingsTaskNotFoundError(params.task_id)

    // Non-null selection must be an exact agent runtime currently in this
    // task's eligible choices. Resolver `eligible` rows carry exact pins only
    // (`forge/<profile>`); policy aliases (fast/general/ultra) never appear.
    if (params.agent_runtime !== null) {
      const declared = summary.agentRuntime && summary.agentRuntime.trim() ? summary.agentRuntime : null
      const eligibility = this.resolver.eligible({
        taskName: taskId,
        requirements: toDispatchRequirements(summary.dispatch),
        declaredRuntime: declared ?? undefined,
      })
      const accepted = eligibility.ok
        && eligibility.choices.some((choice) => choice.exactAgentRuntime === params.agent_runtime)
      if (!accepted) {
        throw new TaskSettingsIneligibleRuntimeError(params.task_id, params.agent_runtime)
      }
    }

    // CAS: reload the current config and compare a deterministic content
    // revision before any mutation. On a stale revision fail with a typed
    // content_conflict and never write.
    const current = this.readConfigRecord()
    if (current.revision !== params.expected_revision) {
      throw new TaskSettingsContentConflictError(params.expected_revision, current.revision)
    }

    // Mutate only tasks.agentRuntime[<bare task name>]; preserve every other
    // top-level key and tasks sibling key, then write atomically.
    const next = mutateTaskAgentRuntime(current.record, taskId, params.agent_runtime)
    this.store.write(this.configPath, next)

    return this.snapshot({ project: params.project })
  }

  private readConfigRecord(): { record: import('../../config/data.mts').ConfigRecord; revision: string } {
    const parsed = this.store.read(this.configPath)
    const record: import('../../config/data.mts').ConfigRecord = parsed ?? {}
    return { record, revision: contentRevision(record) }
  }
}

function contentRevision(record: unknown): string {
  const text = JSON.stringify(record ?? {}) ?? '{}'
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function readMachinePreferences(record: import('../../config/data.mts').ConfigRecord): Record<string, string> {
  const raw = (record as Record<string, unknown>).tasks as Record<string, unknown> | undefined
  const agentRuntime = raw?.agentRuntime
  if (agentRuntime === undefined || agentRuntime === null) return {}
  if (typeof agentRuntime !== 'object' || Array.isArray(agentRuntime)) {
    throw new Error('tasks.agentRuntime must be an object of task id to agentRuntime string')
  }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(agentRuntime as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[name] = value.trim()
  }
  return out
}

/**
 * Bounded mutation: update or delete only `tasks.agentRuntime[<bare task>]`.
 * Unknown top-level keys and sibling keys under `tasks` are preserved
 * byte-for-byte as values. Returns the same record for chaining.
 */
function mutateTaskAgentRuntime(
  record: import('../../config/data.mts').ConfigRecord,
  taskId: string,
  value: string | null,
): import('../../config/data.mts').ConfigRecord {
  const root = record as Record<string, unknown>
  const existingTasks = root.tasks

  if (existingTasks === undefined) {
    if (value === null) return record
    root.tasks = { agentRuntime: { [taskId]: value } }
    return record
  }
  if (typeof existingTasks !== 'object' || Array.isArray(existingTasks)) {
    throw new Error('tasks must be an object')
  }
  const tasks = existingTasks as Record<string, unknown>
  const existingMap = tasks.agentRuntime

  if (existingMap !== undefined && (typeof existingMap !== 'object' || Array.isArray(existingMap))) {
    throw new Error('tasks.agentRuntime must be an object of task id to agentRuntime string')
  }

  if (value === null) {
    // Reset: delete the bare task key only.
    if (existingMap === undefined) return record
    const map = existingMap as Record<string, unknown>
    delete map[taskId]
    if (Object.keys(map).length === 0) delete tasks.agentRuntime
    if (Object.keys(tasks).length === 0) delete root.tasks
    return record
  }

  const map = (existingMap ?? {}) as Record<string, unknown>
  if (existingMap === undefined) tasks.agentRuntime = map
  map[taskId] = value
  return record
}

function toDispatchRequirements(value: unknown): TaskDispatchRequirements {
  if (value !== null && typeof value === 'object') return value as TaskDispatchRequirements
  return {}
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
          return {
            name: item.name,
            ...((item as { project?: unknown }).project !== undefined
              ? { project: String((item as { project: unknown }).project) }
              : {}),
            ...((item as { source?: unknown }).source !== undefined
              ? { source: String((item as { source: unknown }).source) }
              : {}),
            ...(declaredAgentRuntime !== undefined
              ? { agentRuntime: declaredAgentRuntime }
              : {}),
            ...((item as { dispatch?: unknown }).dispatch !== undefined
              ? { dispatch: (item as { dispatch: unknown }).dispatch }
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
        ...(record.project !== undefined ? { project: String(record.project) } : {}),
        ...(record.source !== undefined ? { source: String(record.source) } : {}),
        ...(declaredAgentRuntime !== undefined ? { agentRuntime: declaredAgentRuntime } : {}),
        ...(record.dispatch !== undefined ? { dispatch: record.dispatch } : {}),
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
