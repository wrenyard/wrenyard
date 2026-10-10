import { GitRepository } from '../../core/vcs/index.mts'
import type {
  WorkspaceVcsCommitResult,
  WorkspaceVcsDiffResult,
  WorkspaceVcsPullResult,
  WorkspaceVcsPushResult,
  WorkspaceVcsStatusResult,
} from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'
import { mapServiceError } from './project.mts'

export interface WorkspaceVcsRpcHandlerOptions {
  workspaceRoot: string
}

export function registerWorkspaceVcsHandlers(router: RpcRouter, options: WorkspaceVcsRpcHandlerOptions): void {
  const repository = new GitRepository(options.workspaceRoot, { ownRoot: true })

  router.register('workspace.vcs.status', async () => {
    return workspaceVcsJsonResult<WorkspaceVcsStatusResult>(() => repository.status())
  })
  router.register('workspace.vcs.diff', async (params) => {
    return workspaceVcsJsonResult<WorkspaceVcsDiffResult>(async () => {
      const diff = await repository.diff({ paths: params.paths, staged: params.staged })
      return { diff }
    })
  })
  router.register('workspace.vcs.commit', async (params) => {
    return workspaceVcsJsonResult<WorkspaceVcsCommitResult>(() =>
      repository.commitFiles({ message: params.message, files: params.files }),
    )
  })
  router.register('workspace.vcs.push', async () => {
    return workspaceVcsJsonResult<WorkspaceVcsPushResult>(async () => {
      const result = await repository.push({ requireClean: false })
      if (result.pushed) {
        return {
          branch: result.branch,
          remote: result.remote,
          pushed: true,
          ...(result.head === undefined ? {} : { head: result.head }),
          summary: result.summary,
        }
      }
      return {
        branch: result.branch ?? '',
        remote: 'origin',
        pushed: false,
        summary: result.summary,
        reason: result.reason,
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    })
  })
  router.register('workspace.vcs.pull', async () => {
    return workspaceVcsJsonResult<WorkspaceVcsPullResult>(async () => {
      const result = await repository.pull()
      if (result.pulled) {
        return {
          branch: result.branch,
          remote: result.remote,
          pulled: true,
          summary: result.summary,
        }
      }
      return {
        branch: result.branch ?? '',
        remote: 'origin',
        pulled: false,
        summary: result.summary,
        reason: result.reason,
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    })
  })
}

async function workspaceVcsJsonResult<T>(operation: () => unknown | Promise<unknown>): Promise<T> {
  try {
    return toJsonShape(await operation()) as T
  } catch (error) {
    throw mapServiceError(error, 'workspace-vcs', 'vcs_error')
  }
}

function toJsonShape<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
