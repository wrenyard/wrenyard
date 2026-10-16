import { ProjectManager } from '../../core/project/manager.mts'
import { get } from '../../db/connection.mts'
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
  ProjectWorktreeRebaseResult,
  ProjectWorktreeRemoveResult,
} from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'
import type { ProjectCommitLogResult } from '../../protocol/methods/project.mts'

export interface ProjectRpcHandlerOptions {
  workspaceRoot: string
}

/**
 * Refuse a delivery or removal of a worktree that an unfinished Bot item holds.
 * The Bot delivers and cleans up its own worktrees directly, never over this
 * RPC surface, so a session or any other caller cannot merge, push or remove
 * one even when the worktree's own owner record was lost (a recreated worktree).
 */
function assertNotBotHeld(worktreeId: string | undefined): void {
  if (!worktreeId) return
  let held: unknown
  try {
    held = get(`SELECT 1 FROM bot_item WHERE worktree_id = ? AND state NOT IN ('completed', 'dismissed', 'withdrawn', 'failed') LIMIT 1`, worktreeId)
  } catch {
    return
  }
  if (held !== undefined) {
    throw new ProtocolError(
      { code: INVALID_PARAMS.code, message: `worktree ${worktreeId} belongs to an unfinished Bot item; only the Bot merges, pushes or removes it` },
      { service: 'project', code: 'bot_owned' },
    )
  }
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
    assertNotBotHeld(params.worktree_id)
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
    assertNotBotHeld(params.worktree_id)
    return projectJsonResult<ProjectWorktreeRemoveResult>(() => {
      if (params.project) manager.getProject(params.project)
      return manager.removeWorktree(params.worktree_id)
    })
  })
  router.register('project.worktree.merge', async (params) => {
    assertNotBotHeld(params.worktree_id)
    // No owner is forwarded: a worktree owned by a bot can only be merged by
    // that bot, so a session (or any other caller) gets reason 'bot_owned'.
    return projectJsonResult<ProjectWorktreeMergeResult>(() => manager.mergeWorktree(params.project, params.worktree_id))
  })
  router.register('project.worktree.rebase', async (params) => {
    return projectJsonResult<ProjectWorktreeRebaseResult>(() => manager.rebaseWorktree(params.project, params.worktree_id))
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
    throw mapServiceError(error, 'project', 'project_error')
  }
}

/**
 * Map a thrown service error to a ProtocolError carrying INVALID_PARAMS and
 * data { service, code }, where `code` is the thrown error's string `code`
 * property (e.g. VcsError) when present, otherwise `fallback`.
 */
export function mapServiceError(error: unknown, service: string, fallback: string): ProtocolError {
  if (error instanceof ProtocolError) return error
  return new ProtocolError(
    { code: INVALID_PARAMS.code, message: error instanceof Error ? error.message : String(error) },
    {
      service,
      code: errorCode(error) ?? fallback,
    },
  )
}

/** Preserve a thrown error's string `code` (e.g. VcsError) in the error data. */
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
