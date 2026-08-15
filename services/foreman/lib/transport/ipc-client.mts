import { connect, type Socket } from 'node:net'
import {
  DAEMON_UNAVAILABLE,
  ProtocolError,
} from '../protocol/errors.mts'
import type { NdjsonChunk } from './types.mts'

export interface IpcClientTransport {
  send(frame: string): Promise<void>
  close(): void
  dispose(): void
}

export interface ConnectIpcClientTransportOptions {
  path: string
  onChunk: (chunk: NdjsonChunk) => void
  onError?: (error: Error) => void
  onClose?: () => void
  timeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

function daemonUnavailable(message: string, cause?: unknown): ProtocolError {
  return new ProtocolError(DAEMON_UNAVAILABLE, {
    message,
    cause: cause instanceof Error ? cause.message : cause,
  })
}

export function connectIpcClientTransport(
  options: ConnectIpcClientTransportOptions,
): Promise<IpcClientTransport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const socket = connect(options.path)
    let settled = false
    let closed = false

    const timeout = setTimeout(() => {
      fail(daemonUnavailable(`Timed out connecting to IPC endpoint: ${options.path}`))
    }, timeoutMs)

    function cleanupConnectListeners(): void {
      clearTimeout(timeout)
      socket.off('connect', handleConnect)
      socket.off('error', handleConnectError)
    }

    function fail(error: Error): void {
      if (settled) return
      settled = true
      closed = true
      cleanupConnectListeners()
      socket.destroy()
      reject(error)
    }

    function handleConnectError(error: Error): void {
      fail(daemonUnavailable(`Unable to connect to IPC endpoint: ${options.path}`, error))
    }

    function handleRuntimeError(error: Error): void {
      options.onError?.(error)
    }

    function handleRuntimeClose(): void {
      closed = true
      options.onClose?.()
    }

    function close(): void {
      if (closed) return
      closed = true
      socket.end()
      socket.destroy()
    }

    function handleConnect(): void {
      if (settled) return
      settled = true
      cleanupConnectListeners()

      socket.on('data', options.onChunk)
      socket.on('error', handleRuntimeError)
      socket.on('close', handleRuntimeClose)

      resolve({
        send(frame: string): Promise<void> {
          if (closed || socket.destroyed) {
            return Promise.reject(new Error('IPC client transport is closed'))
          }

          return new Promise((sendResolve) => {
            socket.write(frame, () => {
              sendResolve()
            })
          })
        },

        close,

        dispose: close,
      })
    }

    socket.once('connect', handleConnect)
    socket.once('error', handleConnectError)
  })
}
