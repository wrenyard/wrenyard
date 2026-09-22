/**
 * Reusable NDJSON/JSON-RPC transport primitives shared by every Wrenyard IPC
 * client surface: the daemon's typed control client, the CLI and Desktop.
 *
 * This module owns framing, the socket transport and error codes only. The
 * typed daemon method client lives with the daemon because its method registry
 * is the daemon's wire contract.
 */
export {
  createFrameDecoder,
  decodeFrame,
  encodeFrame,
} from './ndjson.ts'
export type {
  FrameDecoder,
  FrameDecoderOptions,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  NdjsonChunk,
} from './types.ts'
export { NdjsonFrameError } from './types.ts'
export {
  connectIpcClientTransport,
  type ConnectIpcClientTransportOptions,
  type IpcClientTransport,
} from './ipc-client.ts'
export {
  JsonRpcClient,
  type JsonRpcClientOptions,
  type JsonRpcClientTransport,
  type JsonRpcRequestOptions,
} from './jsonrpc-client.ts'
export {
  DAEMON_UNAVAILABLE,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  JSON_RPC_ERROR_CODES,
  METHOD_NOT_FOUND,
  OPERATION_TIMEOUT,
  PARSE_ERROR,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  isProtocolError,
  type ProtocolErrorCode,
  type ProtocolErrorDefinition,
} from './errors.ts'
