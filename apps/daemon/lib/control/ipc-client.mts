import {
  connectIpcClientTransport,
  JsonRpcClient,
  ProtocolError,
  PROTOCOL_ERROR_CODES,
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

function ipcConnectionClosedError(path: string): ProtocolError {
  return new ProtocolError(DAEMON_UNAVAILABLE, {
    message: `IPC connection closed: ${path}`,
  })
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

  jsonRpcClient = new JsonRpcClient({ transport })
  for (const chunk of pendingChunks) {
    jsonRpcClient.handleIncoming(chunk)
  }

  return new ForemanClient(jsonRpcClient, { transport })
}
