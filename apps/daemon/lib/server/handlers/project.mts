import { ProjectManager } from '../../core/project/manager.mts'
import {
  INVALID_PARAMS,
  ProtocolError,
} from '../../protocol/errors.mts'
import type {
  ProjectCommitResult,
  ProjectDescribeResult,
  ProjectDiffResult,
  ProjectListResult,
  ProjectPullResult,
  ProjectPushResult,
  ProjectRegisterResult,
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
  router.register('project.diff', async (params) => {
    return projectJsonResult<ProjectDiffResult>(async () => {
      const diff = await manager.diff(
        { project: params.project, worktree_id: params.worktree_id },
        { paths: params.paths, staged: params.staged },
      )
      return {
        project: params.project,
        ...(params.worktree_id === undefined ? {} : { worktree_id: params.worktree_id }),
        diff,
      }
    })
  })
  router.register('project.commit', async (params) => {
    return projectJsonResult<ProjectCommitResult>(async () => {
      const result = await manager.commit(
        { project: params.project, worktree_id: params.worktree_id },
        { message: params.message, files: params.files },
      )
      return {
        project: params.project,
        ...(params.worktree_id === undefined ? {} : { worktree_id: params.worktree_id }),
        ...result,
      }
    })
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
  router.register('project.register', async (params) => {
    return projectJsonResult<ProjectRegisterResult>(() => manager.registerProject({
      project: params.project,
      description: params.description,
      display_name: params.display_name,
      checkout_path: params.checkout_path,
      git_remote: params.git_remote,
      default_branch: params.default_branch,
    }))
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
        code: errorCode(error) ?? 'project_error',
      },
    )
  }
}

/** Preserve a thrown error's string `code` (e.g. GitCheckoutError) in the error data. */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

function toJsonShape<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
