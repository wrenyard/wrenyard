import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import type { WrenyardGatewayConnection } from '@wrenyard/control-client'
import {
  buildSummarySettingsSnapshot,
  readSummaryModel,
  type ProjectInfo,
  type SessionHost,
} from '@wrenyard/session'
import { ProjectManager } from '../../core/project/manager.mts'
import type { TaskContext } from '../../core/task/context.mts'
import { isTaskRunRejection, type TaskService } from '../../core/task/service.mts'
import type { WorkspaceDocService } from './workspace-doc-service.mts'

export interface DaemonSessionHostOptions {
  workspaceRoot: string
  stateRoot: string
  gateway(): Promise<WrenyardGatewayConnection>
  taskService: TaskService
  workspaceDocService: WorkspaceDocService
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  return output === undefined || output === null ? '' : JSON.stringify(output, null, 2)
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

/** In-process feature ports; task admission goes through TaskService, never RPC. */
export function createDaemonSessionHost(options: DaemonSessionHostOptions): SessionHost {
  const { stateRoot, taskService, workspaceDocService } = options
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
    async cheapModel() {
      const canonical = readSummaryModel(stateRoot).trim() || 'deepseek-v4.1-flash'
      const summary = await buildSummarySettingsSnapshot({
        readGatewayConnection: options.gateway,
        readSummaryModel: () => readSummaryModel(stateRoot),
      })
      const connection = await options.gateway()
      const usable = connection.models.filter(model => !model.taskOnly)
      const preferred = summary.options.find(option => option.canonicalModel === canonical && option.available)?.publicId
      const model = usable.find(model => model.publicId === preferred)
        ?? usable.find(model => model.publicId === canonical)
        ?? usable.find(model => model.publicId.slice(model.publicId.indexOf('/') + 1) === canonical)
        ?? usable.find(model => model.id === canonical)
      if (!model) throw new Error(`Gateway cannot resolve summary model '${canonical}'`)
      return model.publicId
    },
    listProjects,
    gitHead: async checkoutPath => readGitHead(checkoutPath),
    async listTaskDefinitions() {
      const definitions: { id: string; description: string; project?: string }[] = []
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
          })
        }
      }
      add(await taskService.list())
      for (const project of projects.listProjects()) add(await taskService.list(project.name), project.name)
      return definitions
    },
    async describeTask(id, project) {
      const definition = await taskService.describe(id, project)
      return { description: definition.description ?? definition.name, inputSchema: definition.input_schema }
    },
    async createTaskRun(params) {
      const result = await taskService.run({
        taskId: params.task, project: params.project ?? '', input: params.input, ctx: params.ctx as TaskContext | undefined,
      })
      if (isTaskRunRejection(result)) throw new Error(`Task run rejected: ${JSON.stringify(result)}`)
      return { taskRunId: result.task_run_id }
    },
    async waitTaskRun(taskRunId, signal) {
      const result = await taskService.wait(taskRunId, undefined, signal)
      return { status: result.status as string, output: outputText(result.output) || outputText(result.error) }
    },
    async cancelTaskRun(taskRunId) { await taskService.cancel(taskRunId) },
    async createWorkspaceDoc(path, content) { await workspaceDocService.create({ path, content }) },
    async updateWorkspaceDoc(path, content, expectedContent) {
      await workspaceDocService.update({ path, content, expectedContent })
    },
  }
}
