/**
 * IPC contract composition. Each feature owns its own method and notification
 * maps. Conflicting inherited definitions are errors, not overrides.
 */
import type {
  RpcTypedNotification,
  RpcTypedNotificationOf,
  RpcTypedRequest,
  RpcTypedRequestOf,
  RpcTypedResponse,
  RpcTypedSuccessResponse,
  RpcTypedSuccessResponseOf,
} from './common/methods.ts'
import type { ActivityMethods } from './activity/methods.ts'
import type { AgentMethods } from './agent/methods.ts'
import type { BotMethods } from './bot/methods.ts'
import type { ClientMethods } from './client/methods.ts'
import type { ComponentsMethods } from './components/methods.ts'
import type { DaemonMethods } from './daemon/methods.ts'
import type { EventMethods } from './event/methods.ts'
import type { ExecMethods } from './exec/methods.ts'
import type { ProviderMethods } from './provider/methods.ts'
import type { ProjectMethods } from './project/methods.ts'
import type { RoutineMethods } from './routine/methods.ts'
import type { SessionMethods } from './session/index.ts'
import type { StatsMethods } from './stats/methods.ts'
import type { StorageMethods } from './storage/methods.ts'
import type { TaskMethods } from './task/methods.ts'
import type { TaskgraphMethods } from './taskgraph/methods.ts'
import type { WorkspaceMethods } from './workspace/methods.ts'

export interface ProtocolMethods
  extends ActivityMethods,
    AgentMethods,
    BotMethods,
    ClientMethods,
    ComponentsMethods,
    DaemonMethods,
    EventMethods,
    ExecMethods,
    ProviderMethods,
    ProjectMethods,
    RoutineMethods,
    SessionMethods,
    StatsMethods,
    StorageMethods,
    TaskMethods,
    TaskgraphMethods,
    WorkspaceMethods {}
/** No notification channels are part of the composed protocol yet. */
export interface ProtocolNotifications {}

export type ProtocolMethod = keyof ProtocolMethods
export type ProtocolNotification = keyof ProtocolNotifications

/** Requests preserve the method/params relationship, including union arguments. */
export type ProtocolRequest<Method extends ProtocolMethod = ProtocolMethod> =
  RpcTypedRequest<ProtocolMethods, Method>
export type ProtocolSuccessResponse<Method extends ProtocolMethod> =
  RpcTypedSuccessResponse<ProtocolMethods, Method>
export type ProtocolResponse<Method extends ProtocolMethod, ErrorData = unknown> =
  RpcTypedResponse<ProtocolMethods, Method, ErrorData>
export type ProtocolRequestUnion = RpcTypedRequestOf<ProtocolMethods>

/** Responses have no method discriminator. Correlate using the request id. */
export type ProtocolSuccessUnion = RpcTypedSuccessResponseOf<ProtocolMethods>
export type ProtocolTypedNotification<Notification extends ProtocolNotification> =
  RpcTypedNotification<ProtocolNotifications, Notification>
export type ProtocolNotificationUnion = RpcTypedNotificationOf<ProtocolNotifications>

export * from './activity/index.ts'
export * from './agent/index.ts'
export * from './bot/index.ts'
export * from './client/index.ts'
export * from './common/index.ts'
export * from './components/index.ts'
export * from './daemon/index.ts'
export * from './event/index.ts'
export * from './exec/index.ts'
export * from './gateway/index.ts'
export * from './provider/index.ts'
export * from './project/index.ts'
export * from './routine/index.ts'
export * from './session/index.ts'
export * from './stats/index.ts'
export * from './storage/index.ts'
export * from './task/index.ts'
export * from './taskgraph/index.ts'
export * from './workspace/index.ts'
