/**
 * Protocol error constants.
 *
 * Only the numeric codes already in use on the wire are declared here. The
 * session-not-found code is `-32003`, matching the existing Foreman protocol
 * table. Every other session error variant is modeled WITHOUT a numeric code
 * in `../session/errors.ts` until a runtime adapter defines the mapping.
 *
 * These are TYPES/CONSTANTS ONLY. No error class, no throw path, no mapping
 * from a failure to a code.
 */

export interface JsonRpcErrorDefinition<TData = unknown> {
  readonly code: number
  readonly message: string
  readonly data?: TData
}

/**
 * Known numeric protocol error codes. Values must not collide with the
 * standard `JSON_RPC_ERROR_CODES` (-32600..-32700) range.
 */
export const PROTOCOL_ERROR_CODES = {
  /** Existing Foreman code: the addressed session does not exist. */
  SESSION_NOT_FOUND: -32003,
} as const

export type ProtocolErrorCode =
  typeof PROTOCOL_ERROR_CODES[keyof typeof PROTOCOL_ERROR_CODES]

/** Known error definitions, ready to embed in a `JsonRpcErrorObject`. */
export const SESSION_NOT_FOUND = {
  code: PROTOCOL_ERROR_CODES.SESSION_NOT_FOUND,
  message: 'Session not found',
} as const satisfies JsonRpcErrorDefinition
