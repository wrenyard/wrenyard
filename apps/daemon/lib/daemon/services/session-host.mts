import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import type { WrenyardGatewayConnection } from '@wrenyard/control'
import type { ProviderDefinition } from '@wrenyard/providers'
import {
  AUXILIARY_ROLE_ORDER,
  type AuxiliaryRoutePreview,
  type ProjectInfo,
  type SessionHost,
  type TaskArtifact,
} from '@wrenyard/session'
import { ProjectManager } from '../../core/project/manager.mts'
import type { TaskContext } from '../../core/task/context.mts'
import { isTaskRunRejection, type TaskService } from '../../core/task/service.mts'
import { METHOD_NOT_FOUND, ProtocolError } from '../../protocol/errors.mts'
import { describeMethod } from '../../protocol/registry.mts'
import type { RpcRouter } from '../../server/rpc-router.mts'
import { WorkspaceVcsService } from './workspace-vcs-service.mts'
import type { WorkspaceDocService } from './workspace-doc-service.mts'

/** Project RPC methods a session may invoke through `call`/`methods`. */
const SESSION_CALLABLE_METHODS = new Set([
  'project.status',
  'project.diff',
  'project.commit',
  'project.push',
  'project.pull',
  'project.worktree.list',
  'project.worktree.create',
  'project.worktree.remove',
  'project.worktree.merge',
  'project.register',
])

export interface DaemonSessionHostOptions {
  workspaceRoot: string
  stateRoot: string
  gateway(): Promise<WrenyardGatewayConnection>
  routeStatus?: SessionHost['routeStatus']
  selectAuxiliary: SessionHost['selectAuxiliary']
  taskService: TaskService
  /** Daemon-owned workspace document authority the session writes through. */
  workspaceDocService: WorkspaceDocService
  /** The product-wired provider definitions main inference validates its
   *  target against. */
  resolveInferenceProvider(providerId: string): ProviderDefinition | undefined
  /** The daemon RPC router the session invokes allowlisted project methods through. */
  router: RpcRouter
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

/**
 * Resolve a canonical `provider/model` route id to its catalog display name and
 * context window, using the same provider catalog `provider.list` reads.
 */
function resolveRouteMetadata(
  model: string,
  resolveProvider: (providerId: string) => ProviderDefinition | undefined,
): { modelName?: string; contextWindow?: number } {
  const separator = model.indexOf('/')
  if (separator <= 0 || separator === model.length - 1) return {}
  const definition = resolveProvider(model.slice(0, separator))?.models.find(
    entry => entry.id === model.slice(separator + 1),
  )
  if (!definition) return {}
  return {
    modelName: definition.displayName,
    ...(definition.contextWindow === undefined ? {} : { contextWindow: definition.contextWindow }),
  }
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

/** In-process feature ports; task admission goes through TaskService, never RPC. */
export function createDaemonSessionHost(options: DaemonSessionHostOptions): SessionHost {
  const { stateRoot, taskService, workspaceDocService } = options
  const projects = new ProjectManager({ workspaceRoot: options.workspaceRoot })
  const workspaceVcsService = new WorkspaceVcsService(options.workspaceRoot)
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
    /**
     * Read-only rank-1 preview of every auxiliary role. Reuses the injected
     * selector and the same provider catalog `provider.list` serves; a role with
     * no candidate, or whose selection throws, reports `error` and no model.
     */
    async previewAuxiliaryRoutes(): Promise<AuxiliaryRoutePreview[]> {
      const roles: AuxiliaryRoutePreview[] = []
      for (const role of AUXILIARY_ROLE_ORDER) {
        try {
          const route = (await options.selectAuxiliary(role))[0]
          if (!route) {
            roles.push({ role, error: 'no candidate route' })
            continue
          }
          roles.push({
            role,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            ...resolveRouteMetadata(route.model, options.resolveInferenceProvider),
          })
        } catch (error) {
          roles.push({ role, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return roles
    },
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
      return {
        description: definition.description ?? definition.name,
        inputSchema: definition.input_schema,
        source: definition.source,
        ...(requiredCapabilities === undefined || requiredCapabilities.length === 0
          ? {}
          : { requiredCapabilities }),
      }
    },
    async createTaskRun(params) {
      const project = params.project ?? ''
      const result = await taskService.run({
        taskId: params.task, project, input: params.input, ctx: params.ctx as TaskContext | undefined,
      })
      if (isTaskRunRejection(result)) throw new Error(`Task run rejected: ${JSON.stringify(result)}`)
      return { taskRunId: result.task_run_id }
    },
    async waitTaskRun(taskRunId, signal) {
      const result = await taskService.wait(taskRunId, undefined, signal)
      const artifacts = outputArtifacts(result.output)
      const artifactErrors = artifactErrorDescriptors(result._meta)
      return {
        status: result.status as string,
        output: outputText(result.output) || outputText(result.error),
        ...(artifacts.length === 0 ? {} : { artifacts }),
        ...(artifactErrors.length === 0 ? {} : { artifactErrors }),
      }
    },
    async cancelTaskRun(taskRunId) { await taskService.cancel(taskRunId) },
    async writeDocument(params) {
      return workspaceDocService.writeProjectDocument(params)
    },
    workspaceVcs: {
      async status() {
        return { ...(await workspaceVcsService.status()) }
      },
      async diff(opts) {
        return workspaceVcsService.diff(opts)
      },
      async commit(params) {
        return workspaceVcsService.commit(params)
      },
      async push() {
        return { ...(await workspaceVcsService.push()) }
      },
      async pull() {
        return { ...(await workspaceVcsService.pull()) }
      },
    },
    /**
     * Describe the allowlisted project methods a session may call, in request
     * order. Any name outside SESSION_CALLABLE_METHODS is rejected.
     */
    async methods(names) {
      const described: { name: string; description: string; params: Record<string, unknown> }[] = []
      for (const name of names) {
        if (!SESSION_CALLABLE_METHODS.has(name)) {
          throw new ProtocolError(METHOD_NOT_FOUND, { method: name })
        }
        const method = describeMethod(name)
        if (!method) {
          throw new ProtocolError(METHOD_NOT_FOUND, { method: name })
        }
        described.push({
          name: method.name,
          description: method.description,
          params: method.params as Record<string, unknown>,
        })
      }
      return described
    },
    /**
     * Invoke one allowlisted project method through the daemon RPC pipeline.
     * Non-allowlisted names are rejected. A ProtocolError becomes an Error whose
     * `code` is the error data's string `code` when present, otherwise the
     * numeric protocol code, and whose message is the protocol message.
     */
    async call(method, params) {
      if (!SESSION_CALLABLE_METHODS.has(method)) {
        throw new ProtocolError(METHOD_NOT_FOUND, { method })
      }
      try {
        return await options.router.invoke(method, params, { transport: 'session' })
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error
        const data = error.data
        const code = data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string'
          ? (data as { code: string }).code
          : String(error.code)
        const mapped = new Error(error.message) as Error & { code: string }
        mapped.code = code
        throw mapped
      }
    },
  }
}
