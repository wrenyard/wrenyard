import { ProjectManager } from '../../core/project/manager.mts'
import {
  INVALID_PARAMS,
  ProtocolError,
} from '../../protocol/errors.mts'
import type {
  ProjectDescribeResult,
  ProjectListResult,
  ProjectPullResult,
  ProjectPushResult,
  ProjectStatusResult,
  ProjectWorktreeCreateResult,
  ProjectWorktreeListResult,
  ProjectWorktreeMergeResult,
  ProjectWorktreeRemoveResult,
} from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'
import type { ProjectCommitLogResult } from '../../protocol/methods/project.mts'

export interface ProjectRpcHandlerOptions {
  workspaceRoot: string
}

export function registerProjectHandlers(router: RpcRouter, options: ProjectRpcHandlerOptions): void {
  const manager = new ProjectManager({ workspaceRoot: options.workspaceRoot })

  router.register('project.list', async () => {
    return projectJsonResult<ProjectListResult>(() => manager.listProjects())
  })
  router.register('project.describe', async (params) => {
    return projectJsonResult<ProjectDescribeResult>(() => manager.getProject(params.project))
  })
  router.register('project.status', async (params) => {
    return projectJsonResult<ProjectStatusResult>(() => manager.status(params.project))
  })
  router.register('project.pull', async (params) => {
    return projectJsonResult<ProjectPullResult>(() => manager.pullProject(params.project))
  })
  router.register('project.push', async (params) => {
    return projectJsonResult<ProjectPushResult>(() => manager.pushProject({
      project: params.project,
      worktreeId: params.worktree_id,
    }))
  })
  router.register('project.worktree.list', async (params) => {
    return projectJsonResult<ProjectWorktreeListResult>(() => manager.listWorktrees(params.project))
  })
  router.register('project.worktree.create', async (params) => {
    return projectJsonResult<ProjectWorktreeCreateResult>(() => {
      const createManager = params.worktree_id
        ? new ProjectManager({
          workspaceRoot: options.workspaceRoot,
          idGenerator: () => params.worktree_id as string,
        })
        : manager
      return createManager.createWorktree(params.project, params.branch)
    })
  })
  router.register('project.worktree.remove', async (params) => {
    return projectJsonResult<ProjectWorktreeRemoveResult>(() => {
      if (params.project) manager.getProject(params.project)
      return manager.removeWorktree(params.worktree_id)
    })
  })
  router.register('project.worktree.merge', async (params) => {
    return projectJsonResult<ProjectWorktreeMergeResult>(() => manager.mergeWorktree(params.project, params.worktree_id))
  })
  router.register('project.commitLog', async (params) => {
    return projectJsonResult<ProjectCommitLogResult>(() => manager.commitLog(params.project, params.limit ?? 20))
  })
}

async function projectJsonResult<T>(operation: () => unknown | Promise<unknown>): Promise<T> {
  try {
    return toJsonShape(await operation()) as T
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError(
      { code: INVALID_PARAMS.code, message: error instanceof Error ? error.message : String(error) },
      {
        service: 'project',
        code: 'project_error',
      },
    )
  }
}

function toJsonShape<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
