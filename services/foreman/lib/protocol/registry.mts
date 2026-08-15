import type { JsonSchema } from './jsonrpc.mts'
import {
  activitySnapshotParamsSchema,
  activitySnapshotResultSchema,
  type ActivitySnapshotParams,
  type ActivitySnapshotV1,
} from './methods/activity.mts'
import {
  daemonDrainParamsSchema,
  daemonDrainResultSchema,
  daemonFreezeParamsSchema,
  daemonFreezeResultSchema,
  daemonShutdownParamsSchema,
  daemonShutdownResultSchema,
  daemonStatusParamsSchema,
  daemonStatusResultSchema,
  daemonThawParamsSchema,
  daemonThawResultSchema,
  type DaemonDrainParams,
  type DaemonDrainResult,
  type DaemonFreezeParams,
  type DaemonFreezeResult,
  type DaemonShutdownParams,
  type DaemonShutdownResult,
  type DaemonStatusParams,
  type DaemonStatusResult,
  type DaemonThawParams,
  type DaemonThawResult,
} from './methods/daemon.mts'
import {
  eventListParamsSchema,
  eventListResultSchema,
  type EventListParams,
  type EventListResult,
} from './methods/event.mts'
import {
  healthPingParamsSchema,
  healthPingResultSchema,
  type HealthPingParams,
  type HealthPingResult,
} from './methods/health.mts'
import {
  messageSendParamsSchema,
  messageSendResultSchema,
  type MessageSendParams,
  type MessageSendResult,
} from './methods/message.mts'
import {
  petRestartParamsSchema,
  petRestartResultSchema,
  petStartParamsSchema,
  petStartResultSchema,
  petStatusParamsSchema,
  petStatusResultSchema,
  petStopParamsSchema,
  petStopResultSchema,
  type PetControlParams,
  type PetControlResult,
  type PetStatusParams,
  type PetStatusResult,
} from './methods/pet.mts'
import {
  projectDescribeParamsSchema,
  projectDescribeResultSchema,
  projectListParamsSchema,
  projectListResultSchema,
  projectPullParamsSchema,
  projectPullResultSchema,
  projectPushParamsSchema,
  projectPushResultSchema,
  projectStatusParamsSchema,
  projectStatusResultSchema,
  projectWorktreeCreateParamsSchema,
  projectWorktreeCreateResultSchema,
  projectWorktreeListParamsSchema,
  projectWorktreeListResultSchema,
  projectWorktreeMergeParamsSchema,
  projectWorktreeMergeResultSchema,
  projectWorktreeRemoveParamsSchema,
  projectWorktreeRemoveResultSchema,
  type ProjectDescribeParams,
  type ProjectDescribeResult,
  type ProjectListParams,
  type ProjectListResult,
  type ProjectPullParams,
  type ProjectPullResult,
  type ProjectPushParams,
  type ProjectPushResult,
  type ProjectStatusParams,
  type ProjectStatusResult,
  type ProjectWorktreeCreateParams,
  type ProjectWorktreeCreateResult,
  type ProjectWorktreeListParams,
  type ProjectWorktreeListResult,
  type ProjectWorktreeMergeParams,
  type ProjectWorktreeMergeResult,
  type ProjectWorktreeRemoveParams,
  type ProjectWorktreeRemoveResult,
} from './methods/project.mts'
import {
  projectCommitLogParamsSchema,
  projectCommitLogResultSchema,
  type ProjectCommitLogParams,
  type ProjectCommitLogResult,
} from './methods/project.mts'
import {
  statsTodayParamsSchema,
  statsTodayResultSchema,
  statsSummaryParamsSchema,
  statsSummaryResultSchema,
  type StatsTodayParams,
  type StatsTodayResult,
  type StatsSummaryParams,
  type StatsSummaryResult,
} from './methods/stats.mts'
import {
  taskDefinitionDescribeParamsSchema,
  taskDefinitionDescribeResultSchema,
  taskDefinitionListParamsSchema,
  taskDefinitionListResultSchema,
  taskRunCancelParamsSchema,
  taskRunCancelResultSchema,
  taskRunCreateParamsSchema,
  taskRunCreateResultSchema,
  taskRunEventsParamsSchema,
  taskRunEventsResultSchema,
  taskRunListParamsSchema,
  taskRunListResultSchema,
  taskRunOutputParamsSchema,
  taskRunOutputResultSchema,
  taskRunStatusParamsSchema,
  taskRunStatusResultSchema,
  type TaskDefinitionDescribeParams,
  type TaskDefinitionDescribeResult,
  type TaskDefinitionListParams,
  type TaskDefinitionListResult,
  type TaskRunCancelParams,
  type TaskRunCancelResult,
  type TaskRunCreateParams,
  type TaskRunCreateResult,
  type TaskRunEventsParams,
  type TaskRunEventsResult,
  type TaskRunListParams,
  type TaskRunListResult,
  type TaskRunOutputParams,
  type TaskRunOutputResult,
  type TaskRunStatusParams,
  type TaskRunStatusResult,
} from './methods/task.mts'
import {
  pmTicketCreateParamsSchema,
  pmTicketCreateResultSchema,
  pmTicketGetParamsSchema,
  pmTicketGetResultSchema,
  pmTicketListParamsSchema,
  pmTicketListResultSchema,
  pmTicketUpdateParamsSchema,
  pmTicketUpdateResultSchema,
  pmTicketDeleteParamsSchema,
  pmTicketDeleteResultSchema,
  type PmTicketCreateParams,
  type PmTicketCreateResult,
  type PmTicketGetParams,
  type PmTicketGetResult,
  type PmTicketListParams,
  type PmTicketListResult,
  type PmTicketUpdateParams,
  type PmTicketUpdateResult,
  type PmTicketDeleteParams,
  type PmTicketDeleteResult,
} from './methods/pm.mts'
import {
  taskgraphCreateParamsSchema,
  taskgraphCreateResultSchema,
  taskgraphListParamsSchema,
  taskgraphListResultSchema,
  taskgraphPatchParamsSchema,
  taskgraphPatchResultSchema,
  taskgraphStatusParamsSchema,
  taskgraphStatusResultSchema,
  taskgraphEventsParamsSchema,
  taskgraphEventsResultSchema,
  taskgraphSignalParamsSchema,
  taskgraphSignalResultSchema,
  taskgraphNodeInspectParamsSchema,
  taskgraphNodeInspectResultSchema,
  taskgraphInspectParamsSchema,
  taskgraphInspectResultSchema,
  taskgraphWaitParamsSchema,
  taskgraphWaitResultSchema,
  taskgraphSlipParamsSchema,
  taskgraphSlipResultSchema,
  type TaskGraphCreateParams,
  type TaskGraphCreateResult,
  type TaskGraphListParams,
  type TaskGraphListResult,
  type TaskGraphPatchParams,
  type TaskGraphPatchResult,
  type TaskGraphStatusParams,
  type TaskGraphStatusResult,
  type TaskGraphEventsParams,
  type TaskGraphEventsResult,
  type TaskGraphSignalParams,
  type TaskGraphSignalResult,
  type TaskGraphNodeInspectParams,
  type TaskGraphNodeInspectResult,
  type TaskGraphInspectParams,
  type TaskGraphInspectResult,
  type TaskGraphWaitParams,
  type TaskGraphWaitResult,
  type TaskGraphSlipParams,
  type TaskGraphSlipResult,
} from './methods/taskgraph.mts'
import {
  fwaAssignParamsSchema,
  fwaAssignResultSchema,
  fwaListParamsSchema,
  fwaListResultSchema,
  fwaStatusParamsSchema,
  fwaStatusResultSchema,
  fwaTranscriptParamsSchema,
  fwaTranscriptResultSchema,
  type FwaAssignParams,
  type FwaAssignResult,
  type FwaListParams,
  type FwaListResult,
  type FwaStatusParams,
  type FwaStatusResult,
  type FwaTranscriptParams,
  type FwaTranscriptResult,
} from './methods/fwa.mts'
import {
  agentListParamsSchema,
  agentListResultSchema,
  agentSyncParamsSchema,
  agentSyncResultSchema,
  agentCompactParamsSchema,
  agentCompactResultSchema,
  agentGraphReviewParamsSchema,
  agentGraphReviewResultSchema,
  agentModelListParamsSchema,
  agentModelListResultSchema,
  agentModelSetParamsSchema,
  agentModelSetResultSchema,
  type AgentListParams,
  type AgentListResult,
  type AgentSyncParams,
  type AgentSyncResult,
  type AgentCompactParams,
  type AgentCompactResult,
  type AgentGraphReviewParams,
  type AgentGraphReviewResult,
  type AgentModelListParams,
  type AgentModelListResult,
  type AgentModelSetParams,
  type AgentModelSetResult,
} from './methods/agent.mts'
import {
  workspaceDocListParamsSchema,
  workspaceDocListResultSchema,
  workspaceDocReadParamsSchema,
  workspaceDocReadResultSchema,
  workspaceDocCreateParamsSchema,
  workspaceDocCreateResultSchema,
  workspaceDocUpdateParamsSchema,
  workspaceDocUpdateResultSchema,
  type WorkspaceDocListParams,
  type WorkspaceDocListResult,
  type WorkspaceDocReadParams,
  type WorkspaceDocReadResult,
  type WorkspaceDocCreateParams,
  type WorkspaceDocCreateResult,
  type WorkspaceDocUpdateParams,
  type WorkspaceDocUpdateResult,
} from './methods/workspace-doc.mts'

export type {
  ActivitySnapshotParams,
  ActivitySnapshotV1,
} from './methods/activity.mts'
export type {
  DaemonDrainParams,
  DaemonDrainResult,
  DaemonFreezeParams,
  DaemonFreezeResult,
  DaemonShutdownParams,
  DaemonShutdownResult,
  DaemonStatusParams,
  DaemonStatusResult,
  DaemonThawParams,
  DaemonThawResult,
} from './methods/daemon.mts'
export type {
  EventListParams,
  EventListResult,
} from './methods/event.mts'
export type {
  HealthPingParams,
  HealthPingResult,
} from './methods/health.mts'
export type {
  MessageSendParams,
  MessageSendResult,
} from './methods/message.mts'
export type {
  PetControlParams,
  PetControlResult,
  PetLifecycleState,
  PetStatusParams,
  PetStatusResult,
} from './methods/pet.mts'
export type {
  ProjectCommitLogParams,
  ProjectCommitLogResult,
  ProjectDescribeParams,
  ProjectDescribeResult,
  ProjectListParams,
  ProjectListResult,
  ProjectPullParams,
  ProjectPullResult,
  ProjectPushParams,
  ProjectPushResult,
  ProjectStatusParams,
  ProjectStatusResult,
  ProjectWorktreeCreateParams,
  ProjectWorktreeCreateResult,
  ProjectWorktreeListParams,
  ProjectWorktreeListResult,
  ProjectWorktreeMergeParams,
  ProjectWorktreeMergeResult,
  ProjectWorktreeRemoveParams,
  ProjectWorktreeRemoveResult,
} from './methods/project.mts'
export type {
  WorkspaceDocListParams,
  WorkspaceDocListResult,
  WorkspaceDocReadParams,
  WorkspaceDocReadResult,
  WorkspaceDocCreateParams,
  WorkspaceDocCreateResult,
  WorkspaceDocUpdateParams,
  WorkspaceDocUpdateResult,
} from './methods/workspace-doc.mts'
export type {
  StatsTodayParams,
  StatsTodayResult,
  StatsSummaryParams,
  StatsSummaryResult,
} from './methods/stats.mts'
export type {
  TaskDefinitionDescribeParams,
  TaskDefinitionDescribeResult,
  TaskDefinitionListParams,
  TaskDefinitionListResult,
  TaskRunCancelParams,
  TaskRunCancelResult,
  TaskRunCreateParams,
  TaskRunCreateResult,
  TaskRunEventsParams,
  TaskRunEventsResult,
  TaskRunListParams,
  TaskRunListResult,
  TaskRunOutputParams,
  TaskRunOutputResult,
  TaskRunStatusParams,
  TaskRunStatusResult,
} from './methods/task.mts'
export type {
  PmTicketCreateParams,
  PmTicketCreateResult,
  PmTicketGetParams,
  PmTicketGetResult,
  PmTicketListParams,
  PmTicketListResult,
  PmTicketUpdateParams,
  PmTicketUpdateResult,
  PmTicketDeleteParams,
  PmTicketDeleteResult,
} from './methods/pm.mts'
export type {
  TaskGraphCreateParams,
  TaskGraphCreateResult,
  TaskGraphListParams,
  TaskGraphListResult,
  TaskGraphPatchParams,
  TaskGraphPatchResult,
  TaskGraphStatusParams,
  TaskGraphStatusResult,
  TaskGraphEventsParams,
  TaskGraphEventsResult,
  TaskGraphSignalParams,
  TaskGraphSignalResult,
  TaskGraphNodeInspectParams,
  TaskGraphNodeInspectResult,
  TaskGraphInspectParams,
  TaskGraphInspectResult,
  TaskGraphWaitParams,
  TaskGraphWaitResult,
  TaskGraphSlipParams,
  TaskGraphSlipResult,
} from './methods/taskgraph.mts'
export type {
  FwaAssignParams,
  FwaAssignResult,
  FwaListParams,
  FwaListResult,
  FwaStatusParams,
  FwaStatusResult,
  FwaTranscriptParams,
  FwaTranscriptResult,
} from './methods/fwa.mts'
export type {
  AgentListParams,
  AgentListResult,
  AgentSyncParams,
  AgentSyncResult,
  AgentCompactParams,
  AgentCompactResult,
  AgentGraphReviewParams,
  AgentGraphReviewResult,
  AgentModelListParams,
  AgentModelListResult,
  AgentModelSetParams,
  AgentModelSetResult,
} from './methods/agent.mts'

export interface MethodSchema<TParams = unknown, TResult = unknown> {
  params: JsonSchema
  result: JsonSchema
  _params?: TParams
  _result?: TResult
}

export interface ForemanMethodParams {
  'agent.list': AgentListParams
  'agent.sync': AgentSyncParams
  'agent.compact': AgentCompactParams
  'agent.graph.review': AgentGraphReviewParams
  'agent.model.list': AgentModelListParams
  'agent.model.set': AgentModelSetParams
  'activity.snapshot': ActivitySnapshotParams
  'daemon.drain': DaemonDrainParams
  'daemon.freeze': DaemonFreezeParams
  'daemon.shutdown': DaemonShutdownParams
  'daemon.status': DaemonStatusParams
  'daemon.thaw': DaemonThawParams
  'health.ping': HealthPingParams
  'event.list': EventListParams
  'stats.today': StatsTodayParams
  'stats.summary': StatsSummaryParams
  'task.definition.list': TaskDefinitionListParams
  'task.definition.describe': TaskDefinitionDescribeParams
  'task.run.create': TaskRunCreateParams
  'task.run.list': TaskRunListParams
  'task.run.status': TaskRunStatusParams
  'task.run.output': TaskRunOutputParams
  'task.run.cancel': TaskRunCancelParams
  'task.run.events': TaskRunEventsParams
  'project.list': ProjectListParams
  'project.describe': ProjectDescribeParams
  'project.status': ProjectStatusParams
  'project.pull': ProjectPullParams
  'project.push': ProjectPushParams
  'project.worktree.list': ProjectWorktreeListParams
  'project.worktree.create': ProjectWorktreeCreateParams
  'project.worktree.remove': ProjectWorktreeRemoveParams
  'project.worktree.merge': ProjectWorktreeMergeParams
  'project.commitLog': ProjectCommitLogParams
  'message.send': MessageSendParams
  'pet.status': PetStatusParams
  'pet.start': PetControlParams
  'pet.stop': PetControlParams
  'pet.restart': PetControlParams
  'pm.ticket.create': PmTicketCreateParams
  'pm.ticket.get': PmTicketGetParams
  'pm.ticket.list': PmTicketListParams
  'pm.ticket.update': PmTicketUpdateParams
  'pm.ticket.delete': PmTicketDeleteParams
  'taskgraph.create': TaskGraphCreateParams
  'taskgraph.patch': TaskGraphPatchParams
  'taskgraph.status': TaskGraphStatusParams
  'taskgraph.events': TaskGraphEventsParams
  'taskgraph.signal': TaskGraphSignalParams
  'taskgraph.node.inspect': TaskGraphNodeInspectParams
  'taskgraph.inspect': TaskGraphInspectParams
  'taskgraph.list': TaskGraphListParams
  'taskgraph.wait': TaskGraphWaitParams
  'taskgraph.slip': TaskGraphSlipParams
  'workspace.doc.list': WorkspaceDocListParams
  'workspace.doc.read': WorkspaceDocReadParams
  'workspace.doc.create': WorkspaceDocCreateParams
  'workspace.doc.update': WorkspaceDocUpdateParams
  'fwa.assign': FwaAssignParams
  'fwa.list': FwaListParams
  'fwa.status': FwaStatusParams
  'fwa.transcript': FwaTranscriptParams
}

export interface ForemanMethodResults {
  'agent.list': AgentListResult
  'agent.sync': AgentSyncResult
  'agent.compact': AgentCompactResult
  'agent.graph.review': AgentGraphReviewResult
  'agent.model.list': AgentModelListResult
  'agent.model.set': AgentModelSetResult
  'activity.snapshot': ActivitySnapshotV1
  'daemon.drain': DaemonDrainResult
  'daemon.freeze': DaemonFreezeResult
  'daemon.shutdown': DaemonShutdownResult
  'daemon.status': DaemonStatusResult
  'daemon.thaw': DaemonThawResult
  'health.ping': HealthPingResult
  'event.list': EventListResult
  'stats.today': StatsTodayResult
  'stats.summary': StatsSummaryResult
  'task.definition.list': TaskDefinitionListResult
  'task.definition.describe': TaskDefinitionDescribeResult
  'task.run.create': TaskRunCreateResult
  'task.run.list': TaskRunListResult
  'task.run.status': TaskRunStatusResult
  'task.run.output': TaskRunOutputResult
  'task.run.cancel': TaskRunCancelResult
  'task.run.events': TaskRunEventsResult
  'project.list': ProjectListResult
  'project.describe': ProjectDescribeResult
  'project.status': ProjectStatusResult
  'project.pull': ProjectPullResult
  'project.push': ProjectPushResult
  'project.worktree.list': ProjectWorktreeListResult
  'project.worktree.create': ProjectWorktreeCreateResult
  'project.worktree.remove': ProjectWorktreeRemoveResult
  'project.worktree.merge': ProjectWorktreeMergeResult
  'project.commitLog': ProjectCommitLogResult
  'message.send': MessageSendResult
  'pet.status': PetStatusResult
  'pet.start': PetControlResult
  'pet.stop': PetControlResult
  'pet.restart': PetControlResult
  'pm.ticket.create': PmTicketCreateResult
  'pm.ticket.get': PmTicketGetResult
  'pm.ticket.list': PmTicketListResult
  'pm.ticket.update': PmTicketUpdateResult
  'pm.ticket.delete': PmTicketDeleteResult
  'taskgraph.create': TaskGraphCreateResult
  'taskgraph.patch': TaskGraphPatchResult
  'taskgraph.status': TaskGraphStatusResult
  'taskgraph.events': TaskGraphEventsResult
  'taskgraph.signal': TaskGraphSignalResult
  'taskgraph.node.inspect': TaskGraphNodeInspectResult
  'taskgraph.inspect': TaskGraphInspectResult
  'taskgraph.list': TaskGraphListResult
  'taskgraph.wait': TaskGraphWaitResult
  'taskgraph.slip': TaskGraphSlipResult
  'workspace.doc.list': WorkspaceDocListResult
  'workspace.doc.read': WorkspaceDocReadResult
  'workspace.doc.create': WorkspaceDocCreateResult
  'workspace.doc.update': WorkspaceDocUpdateResult
  'fwa.assign': FwaAssignResult
  'fwa.list': FwaListResult
  'fwa.status': FwaStatusResult
  'fwa.transcript': FwaTranscriptResult
}

export type ForemanMethod = keyof ForemanMethodParams & keyof ForemanMethodResults
export type MethodParams<TMethod extends ForemanMethod> = ForemanMethodParams[TMethod]
export type MethodResult<TMethod extends ForemanMethod> = ForemanMethodResults[TMethod]

export const methodRegistry: {
  readonly [TMethod in ForemanMethod]: MethodSchema<MethodParams<TMethod>, MethodResult<TMethod>>
} = {
  'agent.list': {
    params: agentListParamsSchema,
    result: agentListResultSchema,
  },
  'agent.sync': {
    params: agentSyncParamsSchema,
    result: agentSyncResultSchema,
  },
  'agent.compact': {
    params: agentCompactParamsSchema,
    result: agentCompactResultSchema,
  },
  'agent.graph.review': {
    params: agentGraphReviewParamsSchema,
    result: agentGraphReviewResultSchema,
  },
  'agent.model.list': {
    params: agentModelListParamsSchema,
    result: agentModelListResultSchema,
  },
  'agent.model.set': {
    params: agentModelSetParamsSchema,
    result: agentModelSetResultSchema,
  },
  'activity.snapshot': {
    params: activitySnapshotParamsSchema,
    result: activitySnapshotResultSchema,
  },
  'daemon.drain': {
    params: daemonDrainParamsSchema,
    result: daemonDrainResultSchema,
  },
  'daemon.freeze': {
    params: daemonFreezeParamsSchema,
    result: daemonFreezeResultSchema,
  },
  'daemon.shutdown': {
    params: daemonShutdownParamsSchema,
    result: daemonShutdownResultSchema,
  },
  'daemon.status': {
    params: daemonStatusParamsSchema,
    result: daemonStatusResultSchema,
  },
  'daemon.thaw': {
    params: daemonThawParamsSchema,
    result: daemonThawResultSchema,
  },
  'health.ping': {
    params: healthPingParamsSchema,
    result: healthPingResultSchema,
  },
  'event.list': {
    params: eventListParamsSchema,
    result: eventListResultSchema,
  },
  'stats.today': {
    params: statsTodayParamsSchema,
    result: statsTodayResultSchema,
  },
  'stats.summary': {
    params: statsSummaryParamsSchema,
    result: statsSummaryResultSchema,
  },
  'task.definition.list': {
    params: taskDefinitionListParamsSchema,
    result: taskDefinitionListResultSchema,
  },
  'task.definition.describe': {
    params: taskDefinitionDescribeParamsSchema,
    result: taskDefinitionDescribeResultSchema,
  },
  'task.run.create': {
    params: taskRunCreateParamsSchema,
    result: taskRunCreateResultSchema,
  },
  'task.run.list': {
    params: taskRunListParamsSchema,
    result: taskRunListResultSchema,
  },
  'task.run.status': {
    params: taskRunStatusParamsSchema,
    result: taskRunStatusResultSchema,
  },
  'task.run.output': {
    params: taskRunOutputParamsSchema,
    result: taskRunOutputResultSchema,
  },
  'task.run.cancel': {
    params: taskRunCancelParamsSchema,
    result: taskRunCancelResultSchema,
  },
  'task.run.events': {
    params: taskRunEventsParamsSchema,
    result: taskRunEventsResultSchema,
  },
  'project.list': {
    params: projectListParamsSchema,
    result: projectListResultSchema,
  },
  'project.describe': {
    params: projectDescribeParamsSchema,
    result: projectDescribeResultSchema,
  },
  'project.status': {
    params: projectStatusParamsSchema,
    result: projectStatusResultSchema,
  },
  'project.pull': {
    params: projectPullParamsSchema,
    result: projectPullResultSchema,
  },
  'project.push': {
    params: projectPushParamsSchema,
    result: projectPushResultSchema,
  },
  'project.worktree.list': {
    params: projectWorktreeListParamsSchema,
    result: projectWorktreeListResultSchema,
  },
  'project.worktree.create': {
    params: projectWorktreeCreateParamsSchema,
    result: projectWorktreeCreateResultSchema,
  },
  'project.worktree.remove': {
    params: projectWorktreeRemoveParamsSchema,
    result: projectWorktreeRemoveResultSchema,
  },
  'project.worktree.merge': {
    params: projectWorktreeMergeParamsSchema,
    result: projectWorktreeMergeResultSchema,
  },
  'project.commitLog': {
    params: projectCommitLogParamsSchema,
    result: projectCommitLogResultSchema,
  },
  'message.send': {
    params: messageSendParamsSchema,
    result: messageSendResultSchema,
  },
  'pet.status': {
    params: petStatusParamsSchema,
    result: petStatusResultSchema,
  },
  'pet.start': {
    params: petStartParamsSchema,
    result: petStartResultSchema,
  },
  'pet.stop': {
    params: petStopParamsSchema,
    result: petStopResultSchema,
  },
  'pet.restart': {
    params: petRestartParamsSchema,
    result: petRestartResultSchema,
  },
  'pm.ticket.create': {
    params: pmTicketCreateParamsSchema,
    result: pmTicketCreateResultSchema,
  },
  'pm.ticket.get': {
    params: pmTicketGetParamsSchema,
    result: pmTicketGetResultSchema,
  },
  'pm.ticket.list': {
    params: pmTicketListParamsSchema,
    result: pmTicketListResultSchema,
  },
  'pm.ticket.update': {
    params: pmTicketUpdateParamsSchema,
    result: pmTicketUpdateResultSchema,
  },
  'pm.ticket.delete': {
    params: pmTicketDeleteParamsSchema,
    result: pmTicketDeleteResultSchema,
  },
  'taskgraph.create': {
    params: taskgraphCreateParamsSchema,
    result: taskgraphCreateResultSchema,
  },
  'taskgraph.patch': {
    params: taskgraphPatchParamsSchema,
    result: taskgraphPatchResultSchema,
  },
  'taskgraph.status': {
    params: taskgraphStatusParamsSchema,
    result: taskgraphStatusResultSchema,
  },
  'taskgraph.events': {
    params: taskgraphEventsParamsSchema,
    result: taskgraphEventsResultSchema,
  },
  'taskgraph.signal': {
    params: taskgraphSignalParamsSchema,
    result: taskgraphSignalResultSchema,
  },
  'taskgraph.node.inspect': {
    params: taskgraphNodeInspectParamsSchema,
    result: taskgraphNodeInspectResultSchema,
  },
  'taskgraph.inspect': {
    params: taskgraphInspectParamsSchema,
    result: taskgraphInspectResultSchema,
  },
  'taskgraph.list': {
    params: taskgraphListParamsSchema,
    result: taskgraphListResultSchema,
  },
  'taskgraph.wait': {
    params: taskgraphWaitParamsSchema,
    result: taskgraphWaitResultSchema,
  },
  'taskgraph.slip': {
    params: taskgraphSlipParamsSchema,
    result: taskgraphSlipResultSchema,
  },
  'workspace.doc.list': {
    params: workspaceDocListParamsSchema,
    result: workspaceDocListResultSchema,
  },
  'workspace.doc.read': {
    params: workspaceDocReadParamsSchema,
    result: workspaceDocReadResultSchema,
  },
  'workspace.doc.create': {
    params: workspaceDocCreateParamsSchema,
    result: workspaceDocCreateResultSchema,
  },
  'workspace.doc.update': {
    params: workspaceDocUpdateParamsSchema,
    result: workspaceDocUpdateResultSchema,
  },
  'fwa.assign': {
    params: fwaAssignParamsSchema,
    result: fwaAssignResultSchema,
  },
  'fwa.list': {
    params: fwaListParamsSchema,
    result: fwaListResultSchema,
  },
  'fwa.status': {
    params: fwaStatusParamsSchema,
    result: fwaStatusResultSchema,
  },
  'fwa.transcript': {
    params: fwaTranscriptParamsSchema,
    result: fwaTranscriptResultSchema,
  },
}

export function isForemanMethod(method: string): method is ForemanMethod {
  return Object.prototype.hasOwnProperty.call(methodRegistry, method)
}

export function getMethodSchema(method: string): MethodSchema | undefined {
  if (!isForemanMethod(method)) return undefined
  return methodRegistry[method]
}
