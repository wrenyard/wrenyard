import type { RpcMethod } from '../common/methods.ts'
import type {
  TaskGraphCreateParams,
  TaskGraphCreateResult,
  TaskGraphEventsParams,
  TaskGraphEventsResult,
  TaskGraphInspectParams,
  TaskGraphInspectResult,
  TaskGraphListParams,
  TaskGraphListResult,
  TaskGraphNodeInspectParams,
  TaskGraphNodeInspectResult,
  TaskGraphPatchParams,
  TaskGraphPatchResult,
  TaskGraphSignalParams,
  TaskGraphSignalResult,
  TaskGraphSlipParams,
  TaskGraphSlipResult,
  TaskGraphStatusParams,
  TaskGraphStatusResult,
  TaskGraphWaitParams,
  TaskGraphWaitResult,
} from './types.ts'

export interface TaskgraphMethods {
  'taskgraph.create': RpcMethod<TaskGraphCreateParams, TaskGraphCreateResult>
  'taskgraph.patch': RpcMethod<TaskGraphPatchParams, TaskGraphPatchResult>
  'taskgraph.status': RpcMethod<TaskGraphStatusParams, TaskGraphStatusResult>
  'taskgraph.events': RpcMethod<TaskGraphEventsParams, TaskGraphEventsResult>
  'taskgraph.signal': RpcMethod<TaskGraphSignalParams, TaskGraphSignalResult>
  'taskgraph.node.inspect': RpcMethod<TaskGraphNodeInspectParams, TaskGraphNodeInspectResult>
  'taskgraph.inspect': RpcMethod<TaskGraphInspectParams, TaskGraphInspectResult>
  'taskgraph.list': RpcMethod<TaskGraphListParams, TaskGraphListResult>
  'taskgraph.wait': RpcMethod<TaskGraphWaitParams, TaskGraphWaitResult>
  'taskgraph.slip': RpcMethod<TaskGraphSlipParams, TaskGraphSlipResult>
}
