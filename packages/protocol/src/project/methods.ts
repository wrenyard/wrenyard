import type { RpcMethod } from '../common/methods.ts'
import type {
  ProjectCommitLogParams,
  ProjectCommitLogResult,
  ProjectCommitParams,
  ProjectCommitResult,
  ProjectDescribeParams,
  ProjectDescribeResult,
  ProjectDiffParams,
  ProjectDiffResult,
  ProjectListParams,
  ProjectListResult,
  ProjectPullParams,
  ProjectPullResult,
  ProjectPushParams,
  ProjectPushResult,
  ProjectRegisterParams,
  ProjectRegisterResult,
  ProjectStatusParams,
  ProjectStatusResult,
  ProjectWorktreeCreateParams,
  ProjectWorktreeCreateResult,
  ProjectWorktreeListParams,
  ProjectWorktreeListResult,
  ProjectWorktreeMergeParams,
  ProjectWorktreeMergeResult,
  ProjectWorktreeRebaseParams,
  ProjectWorktreeRebaseResult,
  ProjectWorktreeRemoveParams,
  ProjectWorktreeRemoveResult,
} from './types.ts'

export interface ProjectMethods {
  'project.list': RpcMethod<ProjectListParams, ProjectListResult>
  'project.describe': RpcMethod<ProjectDescribeParams, ProjectDescribeResult>
  'project.status': RpcMethod<ProjectStatusParams, ProjectStatusResult>
  'project.pull': RpcMethod<ProjectPullParams, ProjectPullResult>
  'project.push': RpcMethod<ProjectPushParams, ProjectPushResult>
  'project.diff': RpcMethod<ProjectDiffParams, ProjectDiffResult>
  'project.commit': RpcMethod<ProjectCommitParams, ProjectCommitResult>
  'project.worktree.list': RpcMethod<ProjectWorktreeListParams, ProjectWorktreeListResult>
  'project.worktree.create': RpcMethod<ProjectWorktreeCreateParams, ProjectWorktreeCreateResult>
  'project.worktree.remove': RpcMethod<ProjectWorktreeRemoveParams, ProjectWorktreeRemoveResult>
  'project.worktree.merge': RpcMethod<ProjectWorktreeMergeParams, ProjectWorktreeMergeResult>
  'project.worktree.rebase': RpcMethod<ProjectWorktreeRebaseParams, ProjectWorktreeRebaseResult>
  'project.commitLog': RpcMethod<ProjectCommitLogParams, ProjectCommitLogResult>
  'project.register': RpcMethod<ProjectRegisterParams, ProjectRegisterResult>
}
