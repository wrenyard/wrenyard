import type { RpcMethod } from '../common/methods.ts'
import type {
  WorkspaceDocCreateParams,
  WorkspaceDocCreateResult,
  WorkspaceDocDeleteParams,
  WorkspaceDocDeleteResult,
  WorkspaceDocEditParams,
  WorkspaceDocListParams,
  WorkspaceDocListResult,
  WorkspaceDocReadParams,
  WorkspaceDocReadResult,
  WorkspaceDocUpdateParams,
  WorkspaceDocUpdateResult,
} from './doc.ts'
import type {
  WorkspaceVcsCommitParams,
  WorkspaceVcsCommitResult,
  WorkspaceVcsDiffParams,
  WorkspaceVcsDiffResult,
  WorkspaceVcsPullParams,
  WorkspaceVcsPullResult,
  WorkspaceVcsPushParams,
  WorkspaceVcsPushResult,
  WorkspaceVcsStatusParams,
  WorkspaceVcsStatusResult,
} from './vcs.ts'
import type {
  TodoCreateParams,
  TodoCreateResult,
  TodoGetParams,
  TodoGetResult,
  TodoListParams,
  TodoListResult,
  TodoUpdateParams,
  TodoUpdateResult,
  TodoAddTagsInput,
  TodoRemoveTagInput,
  TodoAppendCommentInput,
  TodoDeleteCommentInput,
  TodoTagResult,
  TodoCommentResult,
} from './todo.ts'
import type {
  RemoteHostListParams,
  RemoteHostListResult,
  RemoteHostMutationResult,
  RemoteHostRenameParams,
  RemoteHostSaveParams,
  WorkspaceInitializeParams,
  WorkspaceInitializeResult,
  WorkspaceInspectParams,
  WorkspaceInspectResult,
  WorkspaceSwitchParams,
  WorkspaceSwitchResult,
} from './types.ts'

export interface WorkspaceMethods {
  'workspace.doc.list': RpcMethod<WorkspaceDocListParams, WorkspaceDocListResult>
  'workspace.doc.read': RpcMethod<WorkspaceDocReadParams, WorkspaceDocReadResult>
  'workspace.doc.create': RpcMethod<WorkspaceDocCreateParams, WorkspaceDocCreateResult>
  'workspace.doc.update': RpcMethod<WorkspaceDocUpdateParams, WorkspaceDocUpdateResult>
  'workspace.doc.edit': RpcMethod<WorkspaceDocEditParams, WorkspaceDocUpdateResult>
  'workspace.doc.delete': RpcMethod<WorkspaceDocDeleteParams, WorkspaceDocDeleteResult>
  'workspace.vcs.status': RpcMethod<WorkspaceVcsStatusParams, WorkspaceVcsStatusResult>
  'workspace.vcs.diff': RpcMethod<WorkspaceVcsDiffParams, WorkspaceVcsDiffResult>
  'workspace.vcs.commit': RpcMethod<WorkspaceVcsCommitParams, WorkspaceVcsCommitResult>
  'workspace.vcs.push': RpcMethod<WorkspaceVcsPushParams, WorkspaceVcsPushResult>
  'workspace.vcs.pull': RpcMethod<WorkspaceVcsPullParams, WorkspaceVcsPullResult>
  'workspace.switch': RpcMethod<WorkspaceSwitchParams, WorkspaceSwitchResult>
  'workspace.inspect': RpcMethod<WorkspaceInspectParams, WorkspaceInspectResult>
  'workspace.initialize': RpcMethod<WorkspaceInitializeParams, WorkspaceInitializeResult>
  'todo.list': RpcMethod<TodoListParams, TodoListResult>
  'todo.get': RpcMethod<TodoGetParams, TodoGetResult>
  'todo.create': RpcMethod<TodoCreateParams, TodoCreateResult>
  'todo.update': RpcMethod<TodoUpdateParams, TodoUpdateResult>
  'todo.tag': RpcMethod<TodoAddTagsInput, TodoTagResult>
  'todo.untag': RpcMethod<TodoRemoveTagInput, TodoTagResult>
  'todo.comment': RpcMethod<TodoAppendCommentInput, TodoCommentResult>
  'todo.uncomment': RpcMethod<TodoDeleteCommentInput, TodoCommentResult>
  'remote.host.list': RpcMethod<RemoteHostListParams, RemoteHostListResult>
  'remote.host.save': RpcMethod<RemoteHostSaveParams, RemoteHostMutationResult>
  'remote.host.rename': RpcMethod<RemoteHostRenameParams, RemoteHostMutationResult>
}
