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
  sessionRenameParamsSchema, sessionRenameResultSchema,
  sessionTitleRegenerateParamsSchema, sessionTitleRegenerateResultSchema,
  sessionUpdateMetadataParamsSchema, sessionUpdateMetadataResultSchema,
  sessionPromptSuggestParamsSchema, sessionPromptSuggestResultSchema,
  sessionPromptCancelParamsSchema, sessionPromptCancelResultSchema,
  type SessionListParams, type SessionListResult,
  type SessionCreateParams, type SessionCreateResult,
  type SessionSendParams, type SessionSendResult,
  type SessionInterruptParams, type SessionInterruptResult,
  type SessionEventsParams, type SessionEventsResult,
  type SessionContextInspectParams, type SessionContextInspectResult,
  type SessionRoutesPreviewParams, type SessionRoutesPreviewResult,
  type SessionMediaReadParams, type SessionMediaReadResult,
  type SessionDeleteParams, type SessionDeleteResult,
  type SessionRenameParams, type SessionRenameResult,
  type SessionTitleRegenerateParams, type SessionTitleRegenerateResult,
  type SessionUpdateMetadataParams, type SessionUpdateMetadataResult,
  type SessionPromptSuggestParams, type SessionPromptSuggestResult,
  type SessionPromptCancelParams, type SessionPromptCancelResult,
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
  SessionRenameParams, SessionRenameResult,
  SessionTitleRegenerateParams, SessionTitleRegenerateResult,
  SessionUpdateMetadataParams, SessionUpdateMetadataResult,
  SessionPromptSuggestParams, SessionPromptSuggestResult,
  SessionPromptCancelParams, SessionPromptCancelResult,
} from './methods/session.mts'
import {
  routineListParamsSchema, routineListResultSchema,
  routineCreateParamsSchema, routineCreateResultSchema,
  routineUpdateParamsSchema, routineUpdateResultSchema,
  routineRunParamsSchema, routineRunResultSchema,
  routineDeleteParamsSchema, routineDeleteResultSchema,
  type RoutineListParams, type RoutineListResult,
  type RoutineCreateParams, type RoutineCreateResult,
  type RoutineUpdateParams, type RoutineUpdateResult,
  type RoutineRunParams, type RoutineRunResult,
  type RoutineDeleteParams, type RoutineDeleteResult,
} from './methods/routine.mts'
import {
  agentListParamsSchema, agentListResultSchema,
  agentGetParamsSchema, agentGetResultSchema,
  agentCreateParamsSchema, agentCreateResultSchema,
  agentMemoryListParamsSchema, agentMemoryListResultSchema,
  agentEventsParamsSchema, agentEventsResultSchema,
  agentWakeParamsSchema, agentWakeResultSchema,
  agentGroupEventsParamsSchema, agentGroupEventsResultSchema,
  agentGroupSendParamsSchema, agentGroupSendResultSchema,
  type AgentBotSummary,
  type AgentListParams, type AgentListResult,
  type AgentGetParams, type AgentGetResult,
  type AgentCreateParams, type AgentCreateResult,
  type AgentMemoryListParams, type AgentMemoryListResult,
  type AgentEventsParams, type AgentEventsResult,
  type AgentWakeParams, type AgentWakeResult,
  type AgentGroupEventsParams, type AgentGroupEventsResult,
  type AgentGroupSendParams, type AgentGroupSendResult,
  type GroupMessage,
} from './methods/agent.mts'
export type {
  AgentBotSummary,
  AgentListParams, AgentListResult,
  AgentGetParams, AgentGetResult,
  AgentCreateParams, AgentCreateResult,
  AgentMemoryListParams, AgentMemoryListResult,
  AgentEventsParams, AgentEventsResult,
  AgentWakeParams, AgentWakeResult,
  AgentGroupEventsParams, AgentGroupEventsResult,
  AgentGroupSendParams, AgentGroupSendResult,
  GroupMessage,
} from './methods/agent.mts'
export type {
  RoutineState, RoutineRecord,
  RoutineListParams, RoutineListResult,
  RoutineCreateParams, RoutineCreateResult,
  RoutineUpdateParams, RoutineUpdateResult,
  RoutineRunParams, RoutineRunResult,
  RoutineDeleteParams, RoutineDeleteResult,
} from './methods/routine.mts'
import {
  botListParamsSchema,
  botListResultSchema,
  botCreateParamsSchema,
  botCreateResultSchema,
  botUpdateParamsSchema,
  botUpdateResultSchema,
  botControlParamsSchema,
  botControlResultSchema,
  botDeleteParamsSchema,
  botDeleteResultSchema,
  botTickParamsSchema,
  botTickResultSchema,
  botConfigValidateParamsSchema,
  botConfigValidateResultSchema,
  botItemsParamsSchema,
  botItemsResultSchema,
  botItemGetParamsSchema,
  botItemGetResultSchema,
  botItemActionParamsSchema,
  botItemActionResultSchema,
  botLogParamsSchema,
  botLogResultSchema,
  botHealthParamsSchema,
  botHealthResultSchema,
  type BotListParams, type BotListResult,
  type BotCreateParams, type BotCreateResult,
  type BotUpdateParams, type BotUpdateResult,
  type BotControlParams, type BotControlResult,
  type BotDeleteParams, type BotDeleteResult,
  type BotTickParams, type BotTickResult,
  type BotConfigValidateParams, type BotConfigValidateResult,
  type BotItemsParams, type BotItemsResult,
  type BotItemGetParams, type BotItemGetResult,
  type BotItemActionParams, type BotItemActionResult,
  type BotLogParams, type BotLogResult,
  type BotHealthParams, type BotHealthResult,
} from './methods/bot.mts'
export type {
  BotState, BotMode, BotModel, BotRecord,
  BotAcceptanceCheck, BotItemRecord, BotLogRecord, BotTickLag, BotHealthError, BotHealth,
  BotControlAction, BotItemAction,
  BotListParams, BotListResult,
  BotCreateParams, BotCreateResult,
  BotUpdateParams, BotUpdateResult,
  BotControlParams, BotControlResult,
  BotDeleteParams, BotDeleteResult,
  BotTickParams, BotTickResult,
  BotConfigValidateParams, BotConfigValidateResult,
  BotItemsParams, BotItemsResult,
  BotItemGetParams, BotItemGetResult,
  BotItemActionParams, BotItemActionResult,
  BotLogParams, BotLogResult,
  BotHealthParams, BotHealthResult,
} from './methods/bot.mts'
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
  gatewaySettingsParamsSchema,
  gatewaySettingsResultSchema,
  gatewaySettingsSaveParamsSchema,
  gatewaySettingsSaveResultSchema,
  type GatewayConnectionParams,
  type GatewayConnectionResult,
  type GatewaySettingsParams,
  type GatewaySettingsResult,
  type GatewaySettingsSaveParams,
  type GatewaySettingsSaveResult,
} from './methods/gateway.mts'
export type {
  GatewayConnectionParams,
  GatewayConnectionResult,
  GatewaySettingsParams,
  GatewaySettingsResult,
  GatewaySettingsSaveParams,
  GatewaySettingsSaveResult,
} from './methods/gateway.mts'
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
  projectCommitParamsSchema,
  projectCommitResultSchema,
  projectDescribeParamsSchema,
  projectDescribeResultSchema,
  projectDiffParamsSchema,
  projectDiffResultSchema,
  projectListParamsSchema,
  projectListResultSchema,
  projectPullParamsSchema,
  projectPullResultSchema,
  projectPushParamsSchema,
  projectPushResultSchema,
  projectRegisterParamsSchema,
  projectRegisterResultSchema,
  projectStatusParamsSchema,
  projectStatusResultSchema,
  projectWorktreeCreateParamsSchema,
  projectWorktreeCreateResultSchema,
  projectWorktreeListParamsSchema,
  projectWorktreeListResultSchema,
  projectWorktreeMergeParamsSchema,
  projectWorktreeMergeResultSchema,
  projectWorktreeRebaseParamsSchema,
  projectWorktreeRebaseResultSchema,
  projectWorktreeRemoveParamsSchema,
  projectWorktreeRemoveResultSchema,
  type ProjectCommitParams,
  type ProjectCommitResult,
  type ProjectDescribeParams,
  type ProjectDescribeResult,
  type ProjectDiffParams,
  type ProjectDiffResult,
  type ProjectListParams,
  type ProjectListResult,
  type ProjectPullParams,
  type ProjectPullResult,
  type ProjectPushParams,
  type ProjectPushResult,
  type ProjectRegisterParams,
  type ProjectRegisterResult,
  type ProjectStatusParams,
  type ProjectStatusResult,
  type ProjectWorktreeCreateParams,
  type ProjectWorktreeCreateResult,
  type ProjectWorktreeListParams,
  type ProjectWorktreeListResult,
  type ProjectWorktreeMergeParams,
  type ProjectWorktreeMergeResult,
  type ProjectWorktreeRebaseParams,
  type ProjectWorktreeRebaseResult,
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
  taskSettingsSaveParamsSchema,
  taskSettingsSaveResultSchema,
  taskSettingsSnapshotParamsSchema,
  taskSettingsSnapshotResultSchema,
  type TaskRoutingTestParams,
  type TaskRoutingTestResult,
  type TaskRoutingTestTasksParams,
  type TaskRoutingTestTasksResult,
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
  workspaceDocEditParamsSchema,
  workspaceDocDeleteParamsSchema,
  workspaceDocDeleteResultSchema,
  type WorkspaceDocListParams,
  type WorkspaceDocListResult,
  type WorkspaceDocReadParams,
  type WorkspaceDocReadResult,
  type WorkspaceDocCreateParams,
  type WorkspaceDocCreateResult,
  type WorkspaceDocUpdateParams,
  type WorkspaceDocUpdateResult,
  type WorkspaceDocEditParams,
  type WorkspaceDocDeleteParams,
  type WorkspaceDocDeleteResult,
} from './methods/workspace-doc.mts'
import {
  todoListParamsSchema,
  todoListResultSchema,
  todoGetParamsSchema,
  todoGetResultSchema,
  todoCreateParamsSchema,
  todoCreateResultSchema,
  todoUpdateParamsSchema,
  todoUpdateResultSchema,
  type TodoListParams,
  type TodoListResult,
  type TodoGetParams,
  type TodoGetResult,
  type TodoCreateParams,
  type TodoCreateResult,
  type TodoUpdateParams,
  type TodoUpdateResult,
} from './methods/workspace-todo.mts'
import {
  workspaceVcsStatusParamsSchema,
  workspaceVcsStatusResultSchema,
  workspaceVcsDiffParamsSchema,
  workspaceVcsDiffResultSchema,
  workspaceVcsCommitParamsSchema,
  workspaceVcsCommitResultSchema,
  workspaceVcsPushParamsSchema,
  workspaceVcsPushResultSchema,
  workspaceVcsPullParamsSchema,
  workspaceVcsPullResultSchema,
  type WorkspaceVcsStatusParams,
  type WorkspaceVcsStatusResult,
  type WorkspaceVcsDiffParams,
  type WorkspaceVcsDiffResult,
  type WorkspaceVcsCommitParams,
  type WorkspaceVcsCommitResult,
  type WorkspaceVcsPushParams,
  type WorkspaceVcsPushResult,
  type WorkspaceVcsPullParams,
  type WorkspaceVcsPullResult,
} from './methods/workspace-vcs.mts'
export type {
  WorkspaceVcsStatusParams,
  WorkspaceVcsStatusResult,
  WorkspaceVcsDiffParams,
  WorkspaceVcsDiffResult,
  WorkspaceVcsCommitParams,
  WorkspaceVcsCommitResult,
  WorkspaceVcsPushParams,
  WorkspaceVcsPushResult,
  WorkspaceVcsPullParams,
  WorkspaceVcsPullResult,
} from './methods/workspace-vcs.mts'
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
import {
  componentsActionParamsSchema,
  componentsActionResultSchema,
  componentsListParamsSchema,
  componentsListResultSchema,
  type ComponentsActionParams,
  type ComponentsActionResult,
  type ComponentsListParams,
  type ComponentsListResult,
} from './methods/components.mts'
import {
  storageUsageParamsSchema,
  storageUsageResultSchema,
  storageCleanupPreviewParamsSchema,
  storageCleanupPreviewResultSchema,
  storageCleanupRunParamsSchema,
  storageCleanupRunResultSchema,
  type StorageUsageParams,
  type StorageUsageResult,
  type CleanupPreviewParams,
  type CleanupPreviewResult,
  type CleanupRunParams,
  type CleanupRunResult,
} from './methods/storage.mts'

export type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageDeviceIdentity,
  StorageRootInfo,
  StorageUsageParams,
  StorageUsageResult,
  StorageUsageSnapshot,
  StorageUsageStatus,
  StorageCleanupCategoryId,
  StorageCleanupCategoryPolicy,
  StorageCleanupCategorySummary,
  StorageCleanupOutcome,
  StorageCleanupOutcomeStatus,
  StorageCleanupPathEvidence,
  StorageCleanupPolicy,
  StorageCleanupRunRecord,
  CleanupPreviewParams,
  CleanupPreviewResult,
  CleanupRunParams,
  CleanupRunResult,
} from './methods/storage.mts'

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
} from './methods/project.mts'
export type {
  WorkspaceDocKind,
  WorkspaceDocEntry,
  WorkspaceDocEdit,
  WorkspaceDocListParams,
  WorkspaceDocListResult,
  WorkspaceDocReadParams,
  WorkspaceDocReadResult,
  WorkspaceDocCreateParams,
  WorkspaceDocCreateResult,
  WorkspaceDocUpdateParams,
  WorkspaceDocUpdateResult,
  WorkspaceDocEditParams,
  WorkspaceDocDeleteParams,
  WorkspaceDocDeleteResult,
} from './methods/workspace-doc.mts'
export {
  workspaceDocListParamsSchema,
  workspaceDocListResultSchema,
  workspaceDocReadParamsSchema,
  workspaceDocReadResultSchema,
  workspaceDocCreateParamsSchema,
  workspaceDocCreateResultSchema,
  workspaceDocUpdateParamsSchema,
  workspaceDocUpdateResultSchema,
  workspaceDocEditParamsSchema,
  workspaceDocDeleteParamsSchema,
  workspaceDocDeleteResultSchema,
} from './methods/workspace-doc.mts'
export type {
  Todo,
  TodoStatus,
  TodoCreateInput,
  TodoUpdateInput,
  TodoListParams,
  TodoListResult,
  TodoGetParams,
  TodoGetResult,
  TodoCreateParams,
  TodoCreateResult,
  TodoUpdateParams,
  TodoUpdateResult,
} from './methods/workspace-todo.mts'
export {
  todoListParamsSchema,
  todoListResultSchema,
  todoGetParamsSchema,
  todoGetResultSchema,
  todoCreateParamsSchema,
  todoCreateResultSchema,
  todoUpdateParamsSchema,
  todoUpdateResultSchema,
} from './methods/workspace-todo.mts'
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

// ── workspace.switch ──────────────────────────────────────────────────
// The daemon-owned idle-only workspace hot switch. Declared inline next to the
// workspace.doc.* / workspace.vcs.* entries because it is the one protocol
// method whose authority lives entirely in the daemon's own lifecycle.

export interface WorkspaceSwitchParams {
  /** Path of the workspace root to bind. Resolved and validated by the daemon. */
  root: string
}

/** Closed outcome of one workspace.switch call. */
export type WorkspaceSwitchOutcome =
  /** The daemon rebound every workspace-scoped service to the new root. */
  | 'switched'
  /** Refused: the daemon still has admitted work or an in-flight workspace operation. */
  | 'busy'
  /** Refused: the requested root is not an existing, resolvable directory. */
  | 'invalid'
  /** Refused: a shutdown was already requested. */
  | 'shutting_down'
  /** Refused: WRENYARD_WORKSPACE or --work-dir pins the root outside the config. */
  | 'pinned'
  /** Refused: this daemon exposes no switch implementation. */
  | 'unavailable'
  /** Failed unexpectedly; the previous root and config were kept. */
  | 'error'

export interface WorkspaceSwitchResult {
  ok: boolean
  outcome: WorkspaceSwitchOutcome
  /** Canonical workspace root now in effect; present only on a successful switch. */
  workspace_root?: string
  /** Human-readable reason for a non-success outcome. Never a credential or path leak beyond the requested root. */
  message?: string
}

export const workspaceSwitchParamsSchema = {
  type: 'object',
  required: ['root'],
  properties: {
    root: { type: 'string', minLength: 1, description: 'Workspace root to switch the daemon to.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceSwitchResultSchema = {
  type: 'object',
  required: ['ok', 'outcome'],
  properties: {
    ok: { type: 'boolean' },
    outcome: {
      enum: ['switched', 'busy', 'invalid', 'shutting_down', 'pinned', 'unavailable', 'error'],
      description: 'Closed outcome of the switch request.',
    },
    workspace_root: { type: 'string', description: 'Canonical workspace root in effect after a successful switch.' },
    message: { type: 'string', description: 'Reason a switch was refused.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ── remote.host.* / workspace.inspect / workspace.initialize ──────────
// Remote-connection management is owned by the daemon config, exactly like
// workspace.switch is owned by the daemon lifecycle. These methods are declared
// inline: the daemon is the authority for the saved-host registry, and the
// remote-safe workspace operations let Desktop inspect/initialize the active
// workspace without ever stat'ing or creating a remote path locally. None of
// these ever carry a password, private key or other secret.

/** One saved remote host, as presented over IPC. `displayName` is always resolved. */
export interface RemoteHostRecord {
  /** Concrete SSH `Host` alias; never a wildcard or negated pattern. */
  alias: string
  /** Resolved user-facing display name (falls back to the alias). */
  displayName: string
  /** Verified remote operating system, present only after a ready connection. */
  platform?: string
  /** Verified remote CPU architecture, present only after a ready connection. */
  arch?: string
  /** Verified remote daemon product version at save time. */
  daemonVersion?: string
}

/** The saved remote host list. */
export interface RemoteHostListResult {
  hosts: RemoteHostRecord[]
}

export type RemoteHostListParams = Record<string, never>

/**
 * Remember a host only after a validated, compatible, ready remote connection.
 * `ready: true` is the caller's attestation that validation and remote readiness
 * succeeded; a host is never saved from a probe or a failed confirmation.
 */
export interface RemoteHostSaveParams {
  alias: string
  displayName?: string
  platform: string
  arch: string
  daemonVersion: string
  ready: true
}

export interface RemoteHostRenameParams {
  alias: string
  displayName: string
}

export type RemoteHostMutationResult = RemoteHostListResult

/** Remote-safe inspection of the active daemon's workspace root. */
export interface WorkspaceInspectParams {
  /** Optional candidate root; when omitted the daemon inspects its own root. */
  root?: string
}

export type WorkspaceInspectOutcome = 'configured' | 'missing' | 'invalid'

export interface WorkspaceInspectResult {
  ok: boolean
  outcome: WorkspaceInspectOutcome
  /** Canonical root inspected (the daemon's own root when none was requested). */
  root: string
  /** Whether the root exists as a directory on the daemon's host. */
  exists: boolean
  /** True when the root is pinned by the daemon environment and not editable. */
  readOnly: boolean
  message?: string
}

/** Remote-safe initialization of a new workspace directory on the daemon host. */
export interface WorkspaceInitializeParams {
  root: string
}

export type WorkspaceInitializeOutcome = 'initialized' | 'exists' | 'busy' | 'invalid' | 'unavailable' | 'error'

export interface WorkspaceInitializeResult {
  ok: boolean
  outcome: WorkspaceInitializeOutcome
  root?: string
  message?: string
}

const remoteHostRecordSchema = {
  type: 'object',
  required: ['alias', 'displayName'],
  additionalProperties: false,
  properties: {
    alias: { type: 'string', minLength: 1, maxLength: 255 },
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    platform: { type: 'string', minLength: 1, maxLength: 64 },
    arch: { type: 'string', minLength: 1, maxLength: 64 },
    daemonVersion: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const satisfies JsonSchema

const remoteHostListResultSchema = {
  type: 'object',
  required: ['hosts'],
  additionalProperties: false,
  properties: { hosts: { type: 'array', maxItems: 100, items: remoteHostRecordSchema } },
} as const satisfies JsonSchema

export const remoteHostListParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const remoteHostSaveParamsSchema = {
  type: 'object',
  required: ['alias', 'platform', 'arch', 'daemonVersion', 'ready'],
  additionalProperties: false,
  properties: {
    alias: { type: 'string', minLength: 1, maxLength: 255 },
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    platform: { type: 'string', minLength: 1, maxLength: 64 },
    arch: { type: 'string', minLength: 1, maxLength: 64 },
    daemonVersion: { type: 'string', minLength: 1, maxLength: 64 },
    ready: { const: true, description: 'Caller attestation that validation and remote readiness succeeded.' },
  },
} as const satisfies JsonSchema

export const remoteHostRenameParamsSchema = {
  type: 'object',
  required: ['alias', 'displayName'],
  additionalProperties: false,
  properties: {
    alias: { type: 'string', minLength: 1, maxLength: 255 },
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const satisfies JsonSchema

export const remoteHostMutationResultSchema = remoteHostListResultSchema

export const workspaceInspectParamsSchema = {
  type: 'object',
  properties: { root: { type: 'string', minLength: 1, maxLength: 4096 } },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceInspectResultSchema = {
  type: 'object',
  required: ['ok', 'outcome', 'root', 'exists', 'readOnly'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    outcome: { enum: ['configured', 'missing', 'invalid'] },
    root: { type: 'string', maxLength: 4096 },
    exists: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    message: { type: 'string' },
  },
} as const satisfies JsonSchema

export const workspaceInitializeParamsSchema = {
  type: 'object',
  required: ['root'],
  additionalProperties: false,
  properties: { root: { type: 'string', minLength: 1, maxLength: 4096 } },
} as const satisfies JsonSchema

export const workspaceInitializeResultSchema = {
  type: 'object',
  required: ['ok', 'outcome'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    outcome: { enum: ['initialized', 'exists', 'busy', 'invalid', 'unavailable', 'error'] },
    root: { type: 'string', maxLength: 4096 },
    message: { type: 'string' },
  },
} as const satisfies JsonSchema

export interface MethodSchema<TParams = unknown, TResult = unknown> {
  params: JsonSchema
  result: JsonSchema
  /** Short, factual description of what the method does and its safety rules. */
  description?: string
  _params?: TParams
  _result?: TResult
}

export interface ForemanMethodParams {
  'activity.snapshot': ActivitySnapshotParams
  'daemon.shutdown': DaemonShutdownParams
  'daemon.status': DaemonStatusParams
  'health.ping': HealthPingParams
  'gateway.connection': GatewayConnectionParams
  'gateway.settings': GatewaySettingsParams
  'gateway.settings.save': GatewaySettingsSaveParams
  'provider.list': ProviderListParams
  'provider.configure': ProviderConfigureParams
  'provider.quota': ProviderQuotaParams
  'event.list': EventListParams
  'stats.today': StatsTodayParams
  'stats.summary': StatsSummaryParams
  'storage.usage': StorageUsageParams
  'storage.cleanup.preview': CleanupPreviewParams
  'storage.cleanup.run': CleanupRunParams
  'task.definition.list': TaskDefinitionListParams
  'task.definition.describe': TaskDefinitionDescribeParams
  'task.settings.snapshot': TaskSettingsSnapshotParams
  'task.settings.save': TaskSettingsSaveParams
  'task.settings.routingTest': TaskRoutingTestParams
  'task.settings.routingTestTasks': TaskRoutingTestTasksParams
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
  'project.diff': ProjectDiffParams
  'project.commit': ProjectCommitParams
  'project.worktree.list': ProjectWorktreeListParams
  'project.worktree.create': ProjectWorktreeCreateParams
  'project.worktree.remove': ProjectWorktreeRemoveParams
  'project.worktree.merge': ProjectWorktreeMergeParams
  'project.worktree.rebase': ProjectWorktreeRebaseParams
  'project.commitLog': ProjectCommitLogParams
  'project.register': ProjectRegisterParams
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
  'workspace.doc.edit': WorkspaceDocEditParams
  'workspace.doc.delete': WorkspaceDocDeleteParams
  'todo.list': TodoListParams
  'todo.get': TodoGetParams
  'todo.create': TodoCreateParams
  'todo.update': TodoUpdateParams
  'workspace.vcs.status': WorkspaceVcsStatusParams
  'workspace.vcs.diff': WorkspaceVcsDiffParams
  'workspace.vcs.commit': WorkspaceVcsCommitParams
  'workspace.vcs.push': WorkspaceVcsPushParams
  'workspace.vcs.pull': WorkspaceVcsPullParams
  'workspace.switch': WorkspaceSwitchParams
  'workspace.inspect': WorkspaceInspectParams
  'workspace.initialize': WorkspaceInitializeParams
  'remote.host.list': RemoteHostListParams
  'remote.host.save': RemoteHostSaveParams
  'remote.host.rename': RemoteHostRenameParams
  'exec.start': ExecStartParams
  'exec.get': ExecGetParams
  'exec.events': ExecEventsParams
  'exec.cancel': ExecCancelParams
  'components.list': ComponentsListParams
  'components.action': ComponentsActionParams
  'session.list': SessionListParams
  'session.create': SessionCreateParams
  'session.send': SessionSendParams
  'session.interrupt': SessionInterruptParams
  'session.events': SessionEventsParams
  'session.context.inspect': SessionContextInspectParams
  'session.routes.preview': SessionRoutesPreviewParams
  'session.media.read': SessionMediaReadParams
  'session.delete': SessionDeleteParams
  'session.rename': SessionRenameParams
  'session.title.regenerate': SessionTitleRegenerateParams
  'session.updateMetadata': SessionUpdateMetadataParams
  'session.prompt.suggest': SessionPromptSuggestParams
  'session.prompt.cancel': SessionPromptCancelParams
  'routine.list': RoutineListParams
  'routine.create': RoutineCreateParams
  'routine.update': RoutineUpdateParams
  'routine.run': RoutineRunParams
  'routine.delete': RoutineDeleteParams
  'agent.list': AgentListParams
  'agent.get': AgentGetParams
  'agent.create': AgentCreateParams
  'agent.memory.list': AgentMemoryListParams
  'agent.events': AgentEventsParams
  'agent.wake': AgentWakeParams
  'agent.group.events': AgentGroupEventsParams
  'agent.group.send': AgentGroupSendParams
  'bot.list': BotListParams
  'bot.create': BotCreateParams
  'bot.update': BotUpdateParams
  'bot.control': BotControlParams
  'bot.delete': BotDeleteParams
  'bot.tick': BotTickParams
  'bot.config.validate': BotConfigValidateParams
  'bot.items': BotItemsParams
  'bot.item.get': BotItemGetParams
  'bot.item.action': BotItemActionParams
  'bot.log': BotLogParams
  'bot.health': BotHealthParams
}

export interface ForemanMethodResults {
  'activity.snapshot': ActivitySnapshotV1
  'daemon.shutdown': DaemonShutdownResult
  'daemon.status': DaemonStatusResult
  'health.ping': HealthPingResult
  'gateway.connection': GatewayConnectionResult
  'gateway.settings': GatewaySettingsResult
  'gateway.settings.save': GatewaySettingsSaveResult
  'provider.list': ProviderListResult
  'provider.configure': ProviderConfigureResult
  'provider.quota': ProviderQuotaResult
  'event.list': EventListResult
  'stats.today': StatsTodayResult
  'stats.summary': StatsSummaryResult
  'storage.usage': StorageUsageResult
  'storage.cleanup.preview': CleanupPreviewResult
  'storage.cleanup.run': CleanupRunResult
  'task.definition.list': TaskDefinitionListResult
  'task.definition.describe': TaskDefinitionDescribeResult
  'task.settings.snapshot': TaskSettingsSnapshotResult
  'task.settings.save': TaskSettingsSaveResult
  'task.settings.routingTest': TaskRoutingTestResult
  'task.settings.routingTestTasks': TaskRoutingTestTasksResult
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
  'project.diff': ProjectDiffResult
  'project.commit': ProjectCommitResult
  'project.worktree.list': ProjectWorktreeListResult
  'project.worktree.create': ProjectWorktreeCreateResult
  'project.worktree.remove': ProjectWorktreeRemoveResult
  'project.worktree.merge': ProjectWorktreeMergeResult
  'project.worktree.rebase': ProjectWorktreeRebaseResult
  'project.commitLog': ProjectCommitLogResult
  'project.register': ProjectRegisterResult
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
  'workspace.doc.edit': WorkspaceDocUpdateResult
  'workspace.doc.delete': WorkspaceDocDeleteResult
  'todo.list': TodoListResult
  'todo.get': TodoGetResult
  'todo.create': TodoCreateResult
  'todo.update': TodoUpdateResult
  'workspace.vcs.status': WorkspaceVcsStatusResult
  'workspace.vcs.diff': WorkspaceVcsDiffResult
  'workspace.vcs.commit': WorkspaceVcsCommitResult
  'workspace.vcs.push': WorkspaceVcsPushResult
  'workspace.vcs.pull': WorkspaceVcsPullResult
  'workspace.switch': WorkspaceSwitchResult
  'workspace.inspect': WorkspaceInspectResult
  'workspace.initialize': WorkspaceInitializeResult
  'remote.host.list': RemoteHostListResult
  'remote.host.save': RemoteHostMutationResult
  'remote.host.rename': RemoteHostMutationResult
  'exec.start': ExecStartResult
  'exec.get': ExecGetResult
  'exec.events': ExecEventsResult
  'exec.cancel': ExecCancelResult
  'components.list': ComponentsListResult
  'components.action': ComponentsActionResult
  'session.list': SessionListResult
  'session.create': SessionCreateResult
  'session.send': SessionSendResult
  'session.interrupt': SessionInterruptResult
  'session.events': SessionEventsResult
  'session.context.inspect': SessionContextInspectResult
  'session.routes.preview': SessionRoutesPreviewResult
  'session.media.read': SessionMediaReadResult
  'session.delete': SessionDeleteResult
  'session.rename': SessionRenameResult
  'session.title.regenerate': SessionTitleRegenerateResult
  'session.updateMetadata': SessionUpdateMetadataResult
  'session.prompt.suggest': SessionPromptSuggestResult
  'session.prompt.cancel': SessionPromptCancelResult
  'routine.list': RoutineListResult
  'routine.create': RoutineCreateResult
  'routine.update': RoutineUpdateResult
  'routine.run': RoutineRunResult
  'routine.delete': RoutineDeleteResult
  'agent.list': AgentListResult
  'agent.get': AgentGetResult
  'agent.create': AgentCreateResult
  'agent.memory.list': AgentMemoryListResult
  'agent.events': AgentEventsResult
  'agent.wake': AgentWakeResult
  'agent.group.events': AgentGroupEventsResult
  'agent.group.send': AgentGroupSendResult
  'bot.list': BotListResult
  'bot.create': BotCreateResult
  'bot.update': BotUpdateResult
  'bot.control': BotControlResult
  'bot.delete': BotDeleteResult
  'bot.tick': BotTickResult
  'bot.config.validate': BotConfigValidateResult
  'bot.items': BotItemsResult
  'bot.item.get': BotItemGetResult
  'bot.item.action': BotItemActionResult
  'bot.log': BotLogResult
  'bot.health': BotHealthResult
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
  'gateway.settings': {
    params: gatewaySettingsParamsSchema,
    result: gatewaySettingsResultSchema,
    description: 'Read the persisted gateway access settings and the connection the running daemon currently serves. IPC-only; never returns a saved token value that differs from the effective one.',
  },
  'gateway.settings.save': {
    params: gatewaySettingsSaveParamsSchema,
    result: gatewaySettingsSaveResultSchema,
    description: 'Validate and persist a gateway port/token change. Never rebinds, restarts or rotates the running gateway; the saved change takes effect at the next bind. IPC-only.',
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
  'storage.usage': {
    params: storageUsageParamsSchema,
    result: storageUsageResultSchema,
    description: 'Read-only WY data directory usage snapshot',
  },
  'storage.cleanup.preview': {
    params: storageCleanupPreviewParamsSchema,
    result: storageCleanupPreviewResultSchema,
    description: 'Read-only preview of eligible managed-artifact cleanup',
  },
  'storage.cleanup.run': {
    params: storageCleanupRunParamsSchema,
    result: storageCleanupRunResultSchema,
    description: 'Execute eligible managed-artifact cleanup',
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
    description: 'Read-only status of a project checkout and its worktrees. Never fetches, pulls, commits, or changes files.',
  },
  'project.pull': {
    params: projectPullParamsSchema,
    result: projectPullResultSchema,
    description: 'Fast-forward only pull of the current branch from origin. Refuses when the tree is dirty or the branch has diverged; never merges or rebases.',
  },
  'project.push': {
    params: projectPushParamsSchema,
    result: projectPushResultSchema,
    description: 'Push the current branch to origin only. Requires a clean working tree and never pushes to any other remote or with force.',
  },
  'project.diff': {
    params: projectDiffParamsSchema,
    result: projectDiffResultSchema,
    description: 'Read-only working-tree diff of a project or worktree checkout, optionally limited to paths or the staged index. Changes nothing.',
  },
  'project.commit': {
    params: projectCommitParamsSchema,
    result: projectCommitResultSchema,
    description: 'Commit exactly the listed files in a project or worktree checkout. Refuses with file_unchanged, foreign_staged, or staged_mismatch when the staged set does not match the requested files.',
  },
  'project.worktree.list': {
    params: projectWorktreeListParamsSchema,
    result: projectWorktreeListResultSchema,
    description: 'List the managed git worktrees of one project. Read-only.',
  },
  'project.worktree.create': {
    params: projectWorktreeCreateParamsSchema,
    result: projectWorktreeCreateResultSchema,
    description: 'Create a managed git worktree for one project on a new or existing branch.',
  },
  'project.worktree.remove': {
    params: projectWorktreeRemoveParamsSchema,
    result: projectWorktreeRemoveResultSchema,
    description: 'Remove a managed git worktree without merging its branch.',
  },
  'project.worktree.merge': {
    params: projectWorktreeMergeParamsSchema,
    result: projectWorktreeMergeResultSchema,
    description: 'Rebase a clean worktree onto its target branch, fast-forward the target, then remove the worktree. Refuses on a dirty worktree, a diverged or stale target, or a non-fast-forward merge.',
  },
  'project.worktree.rebase': {
    params: projectWorktreeRebaseParamsSchema,
    result: projectWorktreeRebaseResultSchema,
    description: 'Rebase a clean worktree onto its target branch in the worktree only. Never touches the base checkout or the target branch; on conflict it aborts the rebase and reports the conflicting paths and the target commits that touched them.',
  },
  'project.commitLog': {
    params: projectCommitLogParamsSchema,
    result: projectCommitLogResultSchema,
  },
  'project.register': {
    params: projectRegisterParamsSchema,
    result: projectRegisterResultSchema,
    description: "Register a project by writing projects/<id>/<last segment>.fmproj. The id is '/'-separated segments matching [A-Za-z0-9._-] and may be nested such as gol/arts; the command refuses an id that already exists. When omitted, the git remote and default branch are detected from the checkout.",
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
    description: 'List the documents of one registered project, optionally limited to one kind, sorted by kind then name. Read-only.',
  },
  'workspace.doc.read': {
    params: workspaceDocReadParamsSchema,
    result: workspaceDocReadResultSchema,
    description: 'Read one ordinary project document by project/kind/name, or the existing registered project AGENTS.md by project/id: "AGENTS.md". Returns a version token for update or edit. Read-only.',
  },
  'workspace.doc.create': {
    params: workspaceDocCreateParamsSchema,
    result: workspaceDocCreateResultSchema,
    description: 'Create one document in a registered project. name is a short lowercase slug and the date prefix is added automatically. Refuses with exists when the document already exists, bad_name when name is not a short lowercase slug, unknown_project when the project is not registered and bad_kind when the kind is not spec, report or handoff.',
  },
  'workspace.doc.update': {
    params: workspaceDocUpdateParamsSchema,
    result: workspaceDocUpdateResultSchema,
    description: 'Overwrite an existing ordinary project document or the existing registered project AGENTS.md addressed by id: "AGENTS.md". base_version comes from doc.read; stale versions conflict.',
  },
  'workspace.doc.edit': {
    params: workspaceDocEditParamsSchema,
    result: workspaceDocUpdateResultSchema,
    description: 'Apply ordered unique literal edits to an existing ordinary project document or the existing registered project AGENTS.md addressed by id: "AGENTS.md". Ordinary base_version is optional; AGENTS.md requires it and nonempty edits/old text.',
  },
  'workspace.doc.delete': {
    params: workspaceDocDeleteParamsSchema,
    result: workspaceDocDeleteResultSchema,
    description: "Delete exactly one document of a registered project. name is a full name returned by workspace.doc.list or workspace.doc.create and base_version comes from workspace.doc.read, so a document changed since it was read is not deleted. Refuses with missing when the document does not exist, not_a_file when it is not a regular document, and conflict when base_version no longer matches.",
  },
  'todo.list': {
    params: todoListParamsSchema,
    result: todoListResultSchema,
    description: 'List every workspace todo, ordered by id. Read-only.',
  },
  'todo.get': {
    params: todoGetParamsSchema,
    result: todoGetResultSchema,
    description: 'Read one workspace todo by its id. Refuses with missing when no such todo exists. Read-only.',
  },
  'todo.create': {
    params: todoCreateParamsSchema,
    result: todoCreateResultSchema,
    description: "Create one workspace todo. The daemon generates the short stable id; there is no caller-selectable filesystem root. Refuses with bad_title, bad_status, bad_dependency/dependency_self/dependency_cycle or bad_attachment on invalid input.",
  },
  'todo.update': {
    params: todoUpdateParamsSchema,
    result: todoUpdateResultSchema,
    description: "Update one existing workspace todo by id. Absent fields are kept, id and created are immutable and updated is refreshed. Refuses with missing when no such todo exists.",
  },
  'workspace.vcs.status': {
    params: workspaceVcsStatusParamsSchema,
    result: workspaceVcsStatusResultSchema,
    description: "Read-only working-tree status of the workspace's own git repository. Operates only on the workspace's own git repository and refuses with workspace_not_repository otherwise. Changes nothing.",
  },
  'workspace.vcs.diff': {
    params: workspaceVcsDiffParamsSchema,
    result: workspaceVcsDiffResultSchema,
    description: "Read-only working-tree diff of the workspace's own git repository, optionally limited to paths or the staged index. Operates only on the workspace's own git repository and refuses with workspace_not_repository otherwise. Changes nothing.",
  },
  'workspace.vcs.commit': {
    params: workspaceVcsCommitParamsSchema,
    result: workspaceVcsCommitResultSchema,
    description: "Commit exactly the listed files in the workspace's own git repository. Only the listed files are staged and committed; it refuses with file_unchanged, foreign_staged or staged_mismatch when the staged set does not match. Operates only on the workspace's own git repository and refuses with workspace_not_repository otherwise.",
  },
  'workspace.vcs.push': {
    params: workspaceVcsPushParamsSchema,
    result: workspaceVcsPushResultSchema,
    description: "Push the current branch to origin only in the workspace's own git repository. Pushes only to origin on the current branch, never force and never with tags, and the workspace repository may hold uncommitted files. Operates only on the workspace's own git repository and refuses with workspace_not_repository otherwise.",
  },
  'workspace.vcs.pull': {
    params: workspaceVcsPullParamsSchema,
    result: workspaceVcsPullResultSchema,
    description: "Fast-forward only pull of the current branch from origin in the workspace's own git repository. The pull requires a clean tree and never merges or rebases. Operates only on the workspace's own git repository and refuses with workspace_not_repository otherwise.",
  },
  'workspace.switch': {
    params: workspaceSwitchParamsSchema,
    result: workspaceSwitchResultSchema,
    description: 'Idle-only workspace hot switch. Rebinds every daemon workspace-scoped service (tasks, taskgraphs, task settings, workspace documents, rpc routes, session host and scheduler) to the requested root and persists workspace.root, keeping the daemon process, instance lock, database, execution runtime and IPC endpoint alive. Refuses with busy while any task, workflow, execution, taskgraph, session turn or in-flight workspace operation remains, and never mutates config on a refused or failed switch.',
  },
  'workspace.inspect': {
    params: workspaceInspectParamsSchema,
    result: workspaceInspectResultSchema,
    description: 'Read-only remote-safe inspection of a workspace root on the daemon host. When no root is given the daemon inspects its own workspace root. The client never stats a remote path locally.',
  },
  'workspace.initialize': {
    params: workspaceInitializeParamsSchema,
    result: workspaceInitializeResultSchema,
    description: 'Remote-safe initialization of a new workspace directory on the daemon host. Only a new or empty directory may be created; a nonempty destination is refused with exists, and the daemon owns the authoritative workspace.root write.',
  },
  'remote.host.list': {
    params: remoteHostListParamsSchema,
    result: remoteHostListResultSchema,
    description: 'List the saved remote hosts from the daemon config. Read-only; never returns a password, private key or other secret.',
  },
  'remote.host.save': {
    params: remoteHostSaveParamsSchema,
    result: remoteHostMutationResultSchema,
    description: 'Remember a remote host in the daemon config. Requires ready: true, the caller attestation that validation, compatibility and remote readiness all succeeded; a failed probe or confirmation must never reach this method.',
  },
  'remote.host.rename': {
    params: remoteHostRenameParamsSchema,
    result: remoteHostMutationResultSchema,
    description: 'Rename a saved remote host display name. Refuses with not_found when the alias is not saved.',
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
  'components.list': {
    params: componentsListParamsSchema,
    result: componentsListResultSchema,
    description: 'Machine-local operation component status (agent-browser, Cua Driver).',
  },
  'components.action': {
    params: componentsActionParamsSchema,
    result: componentsActionResultSchema,
    description: 'User-triggered operation component action: refresh, install, update, repair, authorize, uninstall, enable or disable.',
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
  'session.rename': {
    params: sessionRenameParamsSchema,
    result: sessionRenameResultSchema,
  },
  'session.title.regenerate': {
    params: sessionTitleRegenerateParamsSchema,
    result: sessionTitleRegenerateResultSchema,
  },
  'session.updateMetadata': {
    params: sessionUpdateMetadataParamsSchema,
    result: sessionUpdateMetadataResultSchema,
  },
  'session.prompt.suggest': {
    params: sessionPromptSuggestParamsSchema,
    result: sessionPromptSuggestResultSchema,
  },
  'session.prompt.cancel': {
    params: sessionPromptCancelParamsSchema,
    result: sessionPromptCancelResultSchema,
  },
  'routine.list': { params: routineListParamsSchema, result: routineListResultSchema },
  'routine.create': { params: routineCreateParamsSchema, result: routineCreateResultSchema },
  'routine.update': { params: routineUpdateParamsSchema, result: routineUpdateResultSchema },
  'routine.run': { params: routineRunParamsSchema, result: routineRunResultSchema },
  'routine.delete': { params: routineDeleteParamsSchema, result: routineDeleteResultSchema },
  'agent.list': { params: agentListParamsSchema, result: agentListResultSchema },
  'agent.get': { params: agentGetParamsSchema, result: agentGetResultSchema },
  'agent.create': { params: agentCreateParamsSchema, result: agentCreateResultSchema },
  'agent.memory.list': { params: agentMemoryListParamsSchema, result: agentMemoryListResultSchema },
  'agent.events': { params: agentEventsParamsSchema, result: agentEventsResultSchema },
  'agent.wake': { params: agentWakeParamsSchema, result: agentWakeResultSchema },
  'agent.group.events': { params: agentGroupEventsParamsSchema, result: agentGroupEventsResultSchema },
  'agent.group.send': { params: agentGroupSendParamsSchema, result: agentGroupSendResultSchema },
  'bot.list': { params: botListParamsSchema, result: botListResultSchema },
  'bot.create': { params: botCreateParamsSchema, result: botCreateResultSchema },
  'bot.update': { params: botUpdateParamsSchema, result: botUpdateResultSchema },
  'bot.control': { params: botControlParamsSchema, result: botControlResultSchema },
  'bot.delete': { params: botDeleteParamsSchema, result: botDeleteResultSchema },
  'bot.tick': { params: botTickParamsSchema, result: botTickResultSchema },
  'bot.config.validate': { params: botConfigValidateParamsSchema, result: botConfigValidateResultSchema },
  'bot.items': { params: botItemsParamsSchema, result: botItemsResultSchema },
  'bot.item.get': { params: botItemGetParamsSchema, result: botItemGetResultSchema },
  'bot.item.action': { params: botItemActionParamsSchema, result: botItemActionResultSchema },
  'bot.log': { params: botLogParamsSchema, result: botLogResultSchema },
  'bot.health': { params: botHealthParamsSchema, result: botHealthResultSchema },
}

export function isForemanMethod(method: string): method is ForemanMethod {
  return Object.prototype.hasOwnProperty.call(methodRegistry, method)
}

export function getMethodSchema(method: string): MethodSchema | undefined {
  if (!isForemanMethod(method)) return undefined
  return methodRegistry[method]
}

/** The public description of a registered method, or undefined when unknown. */
export function describeMethod(
  method: string,
): { name: string; description: string; params: JsonSchema } | undefined {
  const schema = getMethodSchema(method)
  if (!schema) return undefined
  return {
    name: method,
    description: schema.description ?? '',
    params: schema.params,
  }
}
