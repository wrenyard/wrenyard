import {
  DAEMON_UNAVAILABLE,
  ProtocolError,
} from '../protocol/errors.mts'
import {
  connectIpcClientTransport,
  type IpcClientTransport,
} from '../transport/ipc-client.mts'
import type { NdjsonChunk } from '../transport/types.mts'
import { ForemanClient } from './foreman-client.mts'
import { JsonRpcClient } from './jsonrpc-client.mts'

export interface ConnectIpcForemanClientOptions {
  path: string
  timeoutMs?: number
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
