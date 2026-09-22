/** Type-only method descriptors. Feature maps do not need index signatures. */
import type {
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from './jsonrpc.ts'

export interface RpcMethod<Params, Result> {
  readonly params: Params
  readonly result: Result
}

export interface RpcNotification<Params> {
  readonly params: Params
}

export type RpcMethodName<Methods> = keyof Methods & string
export type MethodParamsOf<Descriptor> =
  Descriptor extends { readonly params: infer Params } ? Params : never
export type MethodResultOf<Descriptor> =
  Descriptor extends { readonly result: infer Result } ? Result : never
export type RpcParamsOf<Methods, Method extends RpcMethodName<Methods>> =
  MethodParamsOf<Methods[Method]>
export type RpcResultOf<Methods, Method extends RpcMethodName<Methods>> =
  MethodResultOf<Methods[Method]>

/** Only descriptors allowing undefined may omit params. */
type ParamsField<Params> = undefined extends Params
  ? { params?: Params }
  : { params: Params }

/** Mapping also preserves correlation when Method itself is a union. */
export type RpcTypedRequest<Methods, Method extends RpcMethodName<Methods>> = {
  [Key in Method]: Omit<JsonRpcRequest, 'method' | 'params'>
    & { method: Key }
    & ParamsField<RpcParamsOf<Methods, Key>>
}[Method]

/** Responses have no method field; the client correlates them by request id. */
export type RpcTypedSuccessResponse<Methods, Method extends RpcMethodName<Methods>> =
  JsonRpcSuccessResponse<RpcResultOf<Methods, Method>>

export type RpcTypedResponse<
  Methods,
  Method extends RpcMethodName<Methods>,
  ErrorData = unknown,
> = RpcTypedSuccessResponse<Methods, Method> | JsonRpcErrorResponse<ErrorData>

export type RpcTypedRequestOf<Methods> = RpcTypedRequest<Methods, RpcMethodName<Methods>>
export type RpcTypedSuccessResponseOf<Methods> = {
  [Key in RpcMethodName<Methods>]: RpcTypedSuccessResponse<Methods, Key>
}[RpcMethodName<Methods>]

export type RpcNotificationParamsOf<
  Notifications,
  Name extends keyof Notifications & string,
> = MethodParamsOf<Notifications[Name]>

export type RpcTypedNotification<
  Notifications,
  Name extends keyof Notifications & string,
> = {
  [Key in Name]: Omit<JsonRpcNotification, 'method' | 'params'>
    & { method: Key }
    & ParamsField<RpcNotificationParamsOf<Notifications, Key>>
}[Name]

export type RpcTypedNotificationOf<Notifications> =
  RpcTypedNotification<Notifications, keyof Notifications & string>
