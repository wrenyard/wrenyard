import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import type { WrenyardGatewayConnection } from '@wrenyard/control'
import type { ProviderDefinition } from '@wrenyard/providers'
import {
  type ProjectInfo,
  type SessionHost,
  type TaskArtifact,
} from '@wrenyard/session'
import { ProjectManager } from '../../core/project/manager.mts'
import type { TaskContext } from '../../core/task/context.mts'
import { isTaskRunRejection, type TaskService } from '../../core/task/service.mts'
import { getAgentExecutionHost } from '../../core/operations/primitives/agent.mts'
import { ensureDiscovered, resolveTaskTarget } from '../../workspace/task-loader.mts'
import { isTrustedDocDefinition } from '../../standard/index.mts'

export interface DaemonSessionHostOptions {
  workspaceRoot: string
  stateRoot: string
  gateway(): Promise<WrenyardGatewayConnection>
  routeStatus?: SessionHost['routeStatus']
  selectAuxiliary: SessionHost['selectAuxiliary']
  taskService: TaskService
  /** The product-wired provider definitions main inference validates its
   *  target against. */
  resolveInferenceProvider(providerId: string): ProviderDefinition | undefined
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  return output === undefined || output === null ? '' : JSON.stringify(output, null, 2)
}

/** Declared artifacts of a structured task output, or an empty list. */
function outputArtifacts(output: unknown): TaskArtifact[] {
  if (!output || typeof output !== 'object') return []
  const declared = (output as { artifacts?: unknown }).artifacts
  if (!Array.isArray(declared)) return []
  return declared.filter((entry): entry is TaskArtifact => {
    if (!entry || typeof entry !== 'object') return false
    const record = entry as Record<string, unknown>
    return typeof record.path === 'string' && (record.kind === 'image' || record.kind === 'file')
  })
}

/** Textual descriptors of artifact entries the runtime stripped. */
function artifactErrorDescriptors(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return []
  const errors = (meta as { artifactErrors?: unknown }).artifactErrors
  if (!Array.isArray(errors)) return []
  const descriptors: string[] = []
  for (const entry of errors) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { index?: unknown; path?: unknown; reason?: unknown }
    const reason = typeof record.reason === 'string' ? record.reason : 'invalid artifact entry'
    const index = typeof record.index === 'number' ? `[${record.index}]` : ''
    const path = typeof record.path === 'string' ? ` ${record.path}` : ''
    descriptors.push(`${index}${path}: ${reason}`.trim())
  }
  return descriptors
}

function readGitHead(checkoutPath: string): { branch?: string; head?: string } {
  const read = (args: string[]): string => execFileSync('git', ['-C', checkoutPath, 'rev-parse', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }).trim()
  try {
    const branch = read(['--abbrev-ref', 'HEAD'])
    const head = read(['--short', 'HEAD'])
    return { ...(branch && branch !== 'HEAD' ? { branch } : {}), ...(head ? { head } : {}) }
  } catch {
    return {}
  }
}

/** Flatten a described input schema into bounded `name: description` lines. */
function inputSummaryLines(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []
  const record = schema as Record<string, unknown>
  const properties = record.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return []
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  )
  const lines: string[] = []
  for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
    const property = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const description = typeof property.description === 'string' ? property.description.trim() : ''
    const fallback = property.type === undefined
      ? (property.enum !== undefined ? 'enum' : 'value')
      : Array.isArray(property.type)
        ? property.type.join('|')
        : String(property.type)
    lines.push(`${name}${required.has(name) ? ' (required)' : ''}: ${description || fallback}`)
  }
  return lines
}

/** Verify the `doc` target is the trusted builtin singleton via the real registry. */
async function isTrustedDocTarget(workspaceRoot: string, project?: string): Promise<boolean> {
  await ensureDiscovered(workspaceRoot)
  const target = resolveTaskTarget('doc', workspaceRoot, project || undefined)
  return Boolean(target && isTrustedDocDefinition(target.definition, target.source))
}

/**
 * Native settlement fence for a trusted document run. It reads the persisted
 * task status once: when the wait was aborted and the run is still
 * queued/running it cancels the existing run (a terminal run is never
 * re-cancelled), then, when admission recorded a linked execution, awaits the
 * existing supervised native promise. No linked execution means there is
 * nothing to await — the task wait terminal remains the fact.
 */
async function settleTrustedDocRun(taskService: TaskService, taskRunId: string, signal?: AbortSignal): Promise<void> {
  const status = taskService.status(taskRunId)
  const current = typeof status?.status === 'string' ? status.status : undefined
  if (signal?.aborted && (current === 'queued' || current === 'running')) {
    try {
      await taskService.cancel(taskRunId)
    } catch {
      // Cancellation is best-effort; the native fence below still runs.
    }
  }
  const meta = status?._meta
  const executionId = meta && typeof meta === 'object'
    ? (meta as { execution_id?: unknown }).execution_id
    : undefined
  if (typeof executionId === 'string' && executionId.length > 0) {
    await getAgentExecutionHost().waitExecution(executionId)
  }
}

/** In-process feature ports; task admission goes through TaskService, never RPC. */
export function createDaemonSessionHost(options: DaemonSessionHostOptions): SessionHost {
  const { stateRoot, taskService } = options
  // Local, in-memory record of admitted trusted-document runs only. It never
  // gates admission (definition identity does) and never crosses process
  // boundaries.
  const trustedDocRuns = new Set<string>()
  const projects = new ProjectManager({ workspaceRoot: options.workspaceRoot })
  const listProjects = async (): Promise<ProjectInfo[]> => projects.listProjects().map(project => ({
    id: project.name,
    workspaceDir: `projects/${project.name}`,
    checkoutPath: project.path,
    ...(project.displayName ? { displayName: project.displayName } : {}),
    ...(project.gitRemote ? { gitRemote: project.gitRemote } : {}),
    ...(project.defaultBranch ? { defaultBranch: project.defaultBranch } : {}),
  }))

  return {
    workspaceRoot: options.workspaceRoot,
    stateRoot,
    deviceName: hostname(),
    gateway: options.gateway,
    resolveInferenceProvider: options.resolveInferenceProvider,
    selectAuxiliary: options.selectAuxiliary,
    routeStatus: options.routeStatus,
    listProjects,
    gitHead: async checkoutPath => readGitHead(checkoutPath),
    async listTaskDefinitions() {
      const definitions: { id: string; description: string; project?: string; inputSummary: string[] }[] = []
      const seen = new Set<string>()
      const add = (items: Awaited<ReturnType<TaskService['list']>>, project?: string): void => {
        for (const item of items) {
          const owner = item.source === 'builtin' ? undefined : item.project ?? project
          const key = `${owner ?? ''}:${item.name}`
          if (seen.has(key)) continue
          seen.add(key)
          definitions.push({
            id: item.name, description: item.description ?? item.name,
            ...(owner === undefined ? {} : { project: owner }),
            inputSummary: inputSummaryLines(item.input_schema),
          })
        }
      }
      add(await taskService.list())
      for (const project of projects.listProjects()) add(await taskService.list(project.name), project.name)
      return definitions
    },
    async describeTask(id, project) {
      const definition = await taskService.describe(id, project)
      const requiredCapabilities = definition.dispatch?.requiredCapabilities
      const builtinDoc = id === 'doc' ? await isTrustedDocTarget(options.workspaceRoot, project) : false
      return {
        description: definition.description ?? definition.name,
        inputSchema: definition.input_schema,
        source: definition.source,
        builtinDoc,
        ...(requiredCapabilities === undefined || requiredCapabilities.length === 0
          ? {}
          : { requiredCapabilities }),
      }
    },
    async createTaskRun(params) {
      const project = params.project ?? ''
      // A typed `doc` run is admitted only against the trusted builtin
      // singleton; a shadowing override is refused before TaskService sees it.
      const trustedDoc = params.task === 'doc' ? await isTrustedDocTarget(options.workspaceRoot, project) : false
      if (params.task === 'doc' && !trustedDoc) {
        throw new Error(
          `Builtin document task 'doc' is unavailable: the resolved definition is not the trusted builtin document singleton.`,
        )
      }
      const result = await taskService.run({
        taskId: params.task, project, input: params.input, ctx: params.ctx as TaskContext | undefined,
      })
      if (isTaskRunRejection(result)) throw new Error(`Task run rejected: ${JSON.stringify(result)}`)
      if (trustedDoc) trustedDocRuns.add(result.task_run_id)
      return { taskRunId: result.task_run_id }
    },
    async waitTaskRun(taskRunId, signal) {
      const isTrustedDocRun = trustedDocRuns.has(taskRunId)
      // Preserve the original task-wait failure so the settlement fence can
      // never mask it, while a successful wait with a failed settlement must
      // still surface the settlement error instead of reporting done.
      let waitFailed = false
      let waitError: unknown
      let result: Awaited<ReturnType<TaskService['wait']>> | undefined
      try {
        result = await taskService.wait(taskRunId, undefined, signal)
      } catch (error) {
        waitFailed = true
        waitError = error
      }
      if (isTrustedDocRun) {
        try {
          await settleTrustedDocRun(taskService, taskRunId, signal)
        } catch (error) {
          if (!waitFailed) throw error
        } finally {
          trustedDocRuns.delete(taskRunId)
        }
      }
      if (waitFailed) throw waitError
      const artifacts = outputArtifacts(result!.output)
      const artifactErrors = artifactErrorDescriptors(result!._meta)
      return {
        status: result!.status as string,
        output: outputText(result!.output) || outputText(result!.error),
        ...(artifacts.length === 0 ? {} : { artifacts }),
        ...(artifactErrors.length === 0 ? {} : { artifactErrors }),
      }
    },
    async cancelTaskRun(taskRunId) { await taskService.cancel(taskRunId) },
  }
}
