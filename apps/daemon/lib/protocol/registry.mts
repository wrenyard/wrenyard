import type { JsonSchema } from './jsonrpc.mts'
import {
  sessionListParamsSchema, sessionListResultSchema,
  sessionCreateParamsSchema, sessionCreateResultSchema,
  sessionSendParamsSchema, sessionSendResultSchema,
  sessionInterruptParamsSchema, sessionInterruptResultSchema,
  sessionEventsParamsSchema, sessionEventsResultSchema,
  sessionContextInspectParamsSchema, sessionContextInspectResultSchema,
  sessionRoutesPreviewParamsSchema, sessionRoutesPreviewResultSchema,
  sessionMediaReadParamsSchema, sessionMediaReadResultSchema,
  sessionDeleteParamsSchema, sessionDeleteResultSchema,
  type SessionListParams, type SessionListResult,
  type SessionCreateParams, type SessionCreateResult,
  type SessionSendParams, type SessionSendResult,
  type SessionInterruptParams, type SessionInterruptResult,
  type SessionEventsParams, type SessionEventsResult,
  type SessionContextInspectParams, type SessionContextInspectResult,
  type SessionRoutesPreviewParams, type SessionRoutesPreviewResult,
  type SessionMediaReadParams, type SessionMediaReadResult,
  type SessionDeleteParams, type SessionDeleteResult,
} from './methods/session.mts'
export type {
  SessionListParams, SessionListResult,
  SessionCreateParams, SessionCreateResult,
  SessionSendParams, SessionSendResult,
  SessionInterruptParams, SessionInterruptResult,
  SessionEventsParams, SessionEventsResult,
  SessionContextInspectParams, SessionContextInspectResult,
  SessionRoutesPreviewParams, SessionRoutesPreviewResult,
  SessionMediaReadParams, SessionMediaReadResult,
  SessionDeleteParams, SessionDeleteResult,
} from './methods/session.mts'
import {
  activitySnapshotParamsSchema,
  activitySnapshotResultSchema,
  type ActivitySnapshotParams,
  type ActivitySnapshotV1,
} from './methods/activity.mts'
import {
  daemonShutdownParamsSchema,
  daemonShutdownResultSchema,
  daemonStatusParamsSchema,
  daemonStatusResultSchema,
  type DaemonShutdownParams,
  type DaemonShutdownResult,
  type DaemonStatusParams,
  type DaemonStatusResult,
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
  gatewayConnectionParamsSchema,
  gatewayConnectionResultSchema,
  type GatewayConnectionParams,
  type GatewayConnectionResult,
} from './methods/gateway.mts'
export type { GatewayConnectionParams, GatewayConnectionResult } from './methods/gateway.mts'
import {
  providerConfigureParamsSchema,
  providerConfigureResultSchema,
  providerListParamsSchema,
  providerListResultSchema,
  providerQuotaParamsSchema,
  providerQuotaResultSchema,
  type ProviderConfigureParams,
  type ProviderConfigureResult,
  type ProviderListParams,
  type ProviderListResult,
  type ProviderQuotaParams,
  type ProviderQuotaResult,
} from './methods/provider.mts'
export type { ProviderConfigureParams, ProviderConfigureResult, ProviderListParams, ProviderListResult, ProviderQuotaParams, ProviderQuotaResult } from './methods/provider.mts'
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
  taskRunWaitParamsSchema,
  taskRunWaitResultSchema,
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
  type TaskRunWaitParams,
  type TaskRunWaitResult,
} from './methods/task.mts'
import {
  taskRoutingTestParamsSchema,
  taskRoutingTestResultSchema,
  taskRoutingTestTasksParamsSchema,
  taskRoutingTestTasksResultSchema,
  taskSettingsRuntimesParamsSchema,
  taskSettingsRuntimesResultSchema,
  taskSettingsSaveParamsSchema,
  taskSettingsSaveResultSchema,
  taskSettingsSnapshotParamsSchema,
  taskSettingsSnapshotResultSchema,
  type TaskRoutingTestParams,
  type TaskRoutingTestResult,
  type TaskRoutingTestTasksParams,
  type TaskRoutingTestTasksResult,
  type TaskSettingsRuntimesParams,
  type TaskSettingsRuntimesResult,
  type TaskSettingsSaveParams,
  type TaskSettingsSaveResult,
  type TaskSettingsSnapshotParams,
  type TaskSettingsSnapshotResult,
} from './methods/task.mts'
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
import {
  runtimeAliasPutParamsSchema,
  runtimeAliasPutResultSchema,
  runtimeAliasRemoveParamsSchema,
  runtimeAliasRemoveResultSchema,
  runtimeAliasSnapshotParamsSchema,
  runtimeAliasSnapshotResultSchema,
  type RuntimeAliasPutParams,
  type RuntimeAliasRemoveParams,
  type RuntimeAliasSnapshotParams,
  type RuntimeAliasSnapshotResult,
} from './methods/runtime-alias.mts'
import {
  execCancelParamsSchema,
  execCancelResultSchema,
  execEventsParamsSchema,
  execEventsResultSchema,
  execGetParamsSchema,
  execGetResultSchema,
  execStartParamsSchema,
  execStartResultSchema,
  type ExecCancelParams,
  type ExecCancelResult,
  type ExecEventsParams,
  type ExecEventsResult,
  type ExecGetParams,
  type ExecGetResult,
  type ExecStartParams,
  type ExecStartResult,
} from './methods/exec.mts'

export type {
  ActivitySnapshotParams,
  ActivitySnapshotV1,
} from './methods/activity.mts'
export type {
  DaemonShutdownParams,
  DaemonShutdownResult,
  DaemonStatusParams,
  DaemonStatusResult,
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
  RuntimeAliasPutParams,
  RuntimeAliasPutResult,
  RuntimeAliasRemoveParams,
  RuntimeAliasRemoveResult,
  RuntimeAliasSnapshotParams,
  RuntimeAliasSnapshotResult,
} from './methods/runtime-alias.mts'
export type {
  ExecCancelParams,
  ExecCancelResult,
  ExecEventsParams,
  ExecEventsResult,
  ExecGetParams,
  ExecGetResult,
  ExecStartParams,
  ExecStartResult,
} from './methods/exec.mts'
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
  TaskRunWaitParams,
  TaskRunWaitResult,
} from './methods/task.mts'
export type {
  TaskRoutingTestParams,
  TaskRoutingTestResult,
  TaskRoutingTestTasksParams,
  TaskRoutingTestTasksResult,
  TaskSettingsRuntimesParams,
  TaskSettingsRuntimesResult,
  TaskSettingsSaveParams,
  TaskSettingsSaveResult,
  TaskSettingsSnapshotParams,
  TaskSettingsSnapshotResult,
} from './methods/task.mts'
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

export interface MethodSchema<TParams = unknown, TResult = unknown> {
  params: JsonSchema
  result: JsonSchema
  _params?: TParams
  _result?: TResult
}

export interface ForemanMethodParams {
  'activity.snapshot': ActivitySnapshotParams
  'daemon.shutdown': DaemonShutdownParams
  'daemon.status': DaemonStatusParams
  'health.ping': HealthPingParams
  'gateway.connection': GatewayConnectionParams
  'provider.list': ProviderListParams
  'provider.configure': ProviderConfigureParams
  'provider.quota': ProviderQuotaParams
  'event.list': EventListParams
  'stats.today': StatsTodayParams
  'stats.summary': StatsSummaryParams
  'task.definition.list': TaskDefinitionListParams
  'task.definition.describe': TaskDefinitionDescribeParams
  'task.settings.snapshot': TaskSettingsSnapshotParams
  'task.settings.save': TaskSettingsSaveParams
  'task.settings.routingTest': TaskRoutingTestParams
  'task.settings.routingTestTasks': TaskRoutingTestTasksParams
  'task.settings.runtimes': TaskSettingsRuntimesParams
  'task.run.create': TaskRunCreateParams
  'task.run.list': TaskRunListParams
  'task.run.status': TaskRunStatusParams
  'task.run.output': TaskRunOutputParams
  'task.run.wait': TaskRunWaitParams
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
  'runtime.alias.snapshot': RuntimeAliasSnapshotParams
  'runtime.alias.put': RuntimeAliasPutParams
  'runtime.alias.remove': RuntimeAliasRemoveParams
  'exec.start': ExecStartParams
  'exec.get': ExecGetParams
  'exec.events': ExecEventsParams
  'exec.cancel': ExecCancelParams
  'session.list': SessionListParams
  'session.create': SessionCreateParams
  'session.send': SessionSendParams
  'session.interrupt': SessionInterruptParams
  'session.events': SessionEventsParams
  'session.context.inspect': SessionContextInspectParams
  'session.routes.preview': SessionRoutesPreviewParams
  'session.media.read': SessionMediaReadParams
  'session.delete': SessionDeleteParams
}

export interface ForemanMethodResults {
  'activity.snapshot': ActivitySnapshotV1
  'daemon.shutdown': DaemonShutdownResult
  'daemon.status': DaemonStatusResult
  'health.ping': HealthPingResult
  'gateway.connection': GatewayConnectionResult
  'provider.list': ProviderListResult
  'provider.configure': ProviderConfigureResult
  'provider.quota': ProviderQuotaResult
  'event.list': EventListResult
  'stats.today': StatsTodayResult
  'stats.summary': StatsSummaryResult
  'task.definition.list': TaskDefinitionListResult
  'task.definition.describe': TaskDefinitionDescribeResult
  'task.settings.snapshot': TaskSettingsSnapshotResult
  'task.settings.save': TaskSettingsSaveResult
  'task.settings.routingTest': TaskRoutingTestResult
  'task.settings.routingTestTasks': TaskRoutingTestTasksResult
  'task.settings.runtimes': TaskSettingsRuntimesResult
  'task.run.create': TaskRunCreateResult
  'task.run.list': TaskRunListResult
  'task.run.status': TaskRunStatusResult
  'task.run.output': TaskRunOutputResult
  'task.run.wait': TaskRunWaitResult
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
  'runtime.alias.snapshot': RuntimeAliasSnapshotResult
  'runtime.alias.put': RuntimeAliasSnapshotResult
  'runtime.alias.remove': RuntimeAliasSnapshotResult
  'exec.start': ExecStartResult
  'exec.get': ExecGetResult
  'exec.events': ExecEventsResult
  'exec.cancel': ExecCancelResult
  'session.list': SessionListResult
  'session.create': SessionCreateResult
  'session.send': SessionSendResult
  'session.interrupt': SessionInterruptResult
  'session.events': SessionEventsResult
  'session.context.inspect': SessionContextInspectResult
  'session.routes.preview': SessionRoutesPreviewResult
  'session.media.read': SessionMediaReadResult
  'session.delete': SessionDeleteResult
}

export type ForemanMethod = keyof ForemanMethodParams & keyof ForemanMethodResults
export type MethodParams<TMethod extends ForemanMethod> = ForemanMethodParams[TMethod]
export type MethodResult<TMethod extends ForemanMethod> = ForemanMethodResults[TMethod]

export const methodRegistry: {
  readonly [TMethod in ForemanMethod]: MethodSchema<MethodParams<TMethod>, MethodResult<TMethod>>
} = {
  'activity.snapshot': {
    params: activitySnapshotParamsSchema,
    result: activitySnapshotResultSchema,
  },
  'daemon.shutdown': {
    params: daemonShutdownParamsSchema,
    result: daemonShutdownResultSchema,
  },
  'daemon.status': {
    params: daemonStatusParamsSchema,
    result: daemonStatusResultSchema,
  },
  'health.ping': {
    params: healthPingParamsSchema,
    result: healthPingResultSchema,
  },
  'gateway.connection': {
    params: gatewayConnectionParamsSchema,
    result: gatewayConnectionResultSchema,
  },
  'provider.list': {
    params: providerListParamsSchema,
    result: providerListResultSchema,
  },
  'provider.configure': {
    params: providerConfigureParamsSchema,
    result: providerConfigureResultSchema,
  },
  'provider.quota': {
    params: providerQuotaParamsSchema,
    result: providerQuotaResultSchema,
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
  'task.settings.snapshot': {
    params: taskSettingsSnapshotParamsSchema,
    result: taskSettingsSnapshotResultSchema,
  },
  'task.settings.save': {
    params: taskSettingsSaveParamsSchema,
    result: taskSettingsSaveResultSchema,
  },
  'task.settings.routingTest': {
    params: taskRoutingTestParamsSchema,
    result: taskRoutingTestResultSchema,
  },
  'task.settings.routingTestTasks': {
    params: taskRoutingTestTasksParamsSchema,
    result: taskRoutingTestTasksResultSchema,
  },
  'task.settings.runtimes': {
    params: taskSettingsRuntimesParamsSchema,
    result: taskSettingsRuntimesResultSchema,
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
  'task.run.wait': {
    params: taskRunWaitParamsSchema,
    result: taskRunWaitResultSchema,
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
  'runtime.alias.snapshot': {
    params: runtimeAliasSnapshotParamsSchema,
    result: runtimeAliasSnapshotResultSchema,
  },
  'runtime.alias.put': {
    params: runtimeAliasPutParamsSchema,
    result: runtimeAliasPutResultSchema,
  },
  'runtime.alias.remove': {
    params: runtimeAliasRemoveParamsSchema,
    result: runtimeAliasRemoveResultSchema,
  },
  'exec.start': {
    params: execStartParamsSchema,
    result: execStartResultSchema,
  },
  'exec.get': {
    params: execGetParamsSchema,
    result: execGetResultSchema,
  },
  'exec.events': {
    params: execEventsParamsSchema,
    result: execEventsResultSchema,
  },
  'exec.cancel': {
    params: execCancelParamsSchema,
    result: execCancelResultSchema,
  },
  'session.list': { params: sessionListParamsSchema, result: sessionListResultSchema },
  'session.create': { params: sessionCreateParamsSchema, result: sessionCreateResultSchema },
  'session.send': { params: sessionSendParamsSchema, result: sessionSendResultSchema },
  'session.interrupt': { params: sessionInterruptParamsSchema, result: sessionInterruptResultSchema },
  'session.events': { params: sessionEventsParamsSchema, result: sessionEventsResultSchema },
  'session.context.inspect': {
    params: sessionContextInspectParamsSchema,
    result: sessionContextInspectResultSchema,
  },
  'session.routes.preview': {
    params: sessionRoutesPreviewParamsSchema,
    result: sessionRoutesPreviewResultSchema,
  },
  'session.media.read': {
    params: sessionMediaReadParamsSchema,
    result: sessionMediaReadResultSchema,
  },
  'session.delete': {
    params: sessionDeleteParamsSchema,
    result: sessionDeleteResultSchema,
  },
}

export function isForemanMethod(method: string): method is ForemanMethod {
  return Object.prototype.hasOwnProperty.call(methodRegistry, method)
}

export function getMethodSchema(method: string): MethodSchema | undefined {
  if (!isForemanMethod(method)) return undefined
  return methodRegistry[method]
}
