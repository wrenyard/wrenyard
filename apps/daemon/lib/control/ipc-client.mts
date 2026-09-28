import {
  connectIpcClientTransport,
  JsonRpcClient,
  ProtocolError,
  PROTOCOL_ERROR_CODES,
  protocolVersionMismatchMessage,
  WRENYARD_PROTOCOL_VERSION,
  type IpcClientTransport,
  type NdjsonChunk,
} from '@wrenyard/control-client/transport'
import { ForemanClient } from './client.mts'

export interface ConnectIpcForemanClientOptions {
  path: string
  timeoutMs?: number
}

const DAEMON_UNAVAILABLE = {
  code: PROTOCOL_ERROR_CODES.DAEMON_UNAVAILABLE,
  message: 'Daemon unavailable',
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000

function ipcConnectionClosedError(path: string): ProtocolError {
  return new ProtocolError(DAEMON_UNAVAILABLE, {
    message: `IPC connection closed: ${path}`,
  })
}

/**
 * Complete the version-checked `health.ping` handshake before any business
 * request is issued. A missing or different daemon `protocolVersion` fails
 * closed: pending requests are rejected and the transport is closed.
 */
async function performHandshake(
  rpc: JsonRpcClient,
  transport: IpcClientTransport,
  timeoutMs?: number,
): Promise<void> {
  try {
    const result = await rpc.request<{ protocolVersion?: unknown }>(
      'health.ping',
      { protocolVersion: WRENYARD_PROTOCOL_VERSION },
      { timeoutMs: timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS },
    )
    const daemonVersion = result && typeof result === 'object'
      ? (result as { protocolVersion?: unknown }).protocolVersion
      : undefined
    if (daemonVersion !== WRENYARD_PROTOCOL_VERSION) {
      throw new Error(
        protocolVersionMismatchMessage(WRENYARD_PROTOCOL_VERSION, daemonVersion),
      )
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    rpc.close(failure)
    transport.close()
    throw failure
  }
}

export async function connectIpcForemanClient(
  options: ConnectIpcForemanClientOptions,
): Promise<ForemanClient> {
  const pendingChunks: NdjsonChunk[] = []
  let jsonRpcClient: JsonRpcClient | undefined

  function closeJsonRpcClient(error: Error): void {
    jsonRpcClient?.close(error)
  }

  const transport: IpcClientTransport = await connectIpcClientTransport({
    path: options.path,
    timeoutMs: options.timeoutMs,
    onChunk: (chunk) => {
      if (jsonRpcClient) {
        jsonRpcClient.handleIncoming(chunk)
        return
      }
      pendingChunks.push(chunk)
    },
    onError: (error) => {
      closeJsonRpcClient(error)
    },
    onClose: () => {
      closeJsonRpcClient(ipcConnectionClosedError(options.path))
    },
  })

  // The explicit handshake below is authoritative, so disable the automatic
  // one to avoid a second health.ping on the same connection.
  jsonRpcClient = new JsonRpcClient({ transport, handshake: false })
  for (const chunk of pendingChunks) {
    jsonRpcClient.handleIncoming(chunk)
  }

  await performHandshake(jsonRpcClient, transport, options.timeoutMs)

  return new ForemanClient(jsonRpcClient, { transport })
}
