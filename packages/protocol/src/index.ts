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
import type { ExecMethods } from './exec/methods.ts'
import type { ProviderMethods } from './provider/methods.ts'
import type { SessionNotifications } from './session/events.ts'
import type { SessionMethods } from './session/methods.ts'

export interface ProtocolMethods extends SessionMethods, ExecMethods, ProviderMethods {}
export interface ProtocolNotifications extends SessionNotifications {}

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

export * from './common/index.ts'
export * from './session/index.ts'
export * from './exec/index.ts'
export * from './provider/index.ts'
