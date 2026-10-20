/**
 * JSON-RPC 2.0 envelopes.
 *
 * The wire shape is unchanged from the existing Foreman protocol: a `2.0`
 * version tag, a method name, optional params, and an id of
 * `string | number | null`. Error codes keep the standard JSON-RPC numeric
 * values in this module; protocol-specific codes live in `./errors.ts`.
 *
 * These are TYPES ONLY. Nothing here parses, validates, or dispatches a
 * message. A future transport adapter owns validation.
 */

/** Request/response correlation id. `null` is allowed by JSON-RPC 2.0. */
export type JsonRpcId = string | number | null

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0'
  method: string
  params?: TParams
  id: JsonRpcId
}

/** A request without an id, which by JSON-RPC 2.0 must not be answered. */
export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0'
  method: string
  params?: TParams
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0'
  result: TResult
  id: JsonRpcId
}

export interface JsonRpcErrorObject<TData = unknown> {
  code: number
  message: string
  data?: TData
}

export interface JsonRpcErrorResponse<TData = unknown> {
  jsonrpc: '2.0'
  error: JsonRpcErrorObject<TData>
  id: JsonRpcId
}

export type JsonRpcMessage<TParams = unknown> =
  | JsonRpcRequest<TParams>
  | JsonRpcNotification<TParams>

export type JsonRpcResponse<TResult = unknown, TData = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse<TData>

/** Loose record shape used to type runtime JSON-schema literals. */
export type JsonRecord = Record<string, unknown>

/**
 * Minimal JSON-schema form used to `satisfies`-check `as const` schema
 * literals; intentionally permissive, not a validating schema engine.
 */
export type JsonSchema = boolean | JsonRecord

/**
 * Canonical Wrenyard IPC protocol version.
 *
 * Clients send it in the `health.ping` handshake; clients validate the
 * daemon's echoed value against it, and the daemon validates the client's
 * value against it. Increment only for an incompatible wire change.
 */
export const WRENYARD_PROTOCOL_VERSION = 2
