import { chmodSync, existsSync, realpathSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  createFrameDecoder,
  encodeFrame,
  protocolVersionMismatchMessage,
  WRENYARD_PROTOCOL_VERSION,
} from '@wrenyard/control-client/transport'

export interface IpcServerOptions {
  path: string
  onMessage: (message: unknown) => unknown | Promise<unknown | undefined> | undefined
}

/** The handshake method; carries the client's expected protocol version. */
const HANDSHAKE_METHOD = 'health.ping'

/**
 * Server-local JSON-RPC codes for the handshake. The client only surfaces the
 * message text, so these stay private to the IPC server.
 */
const PROTOCOL_VERSION_MISMATCH_CODE = -32008
const HANDSHAKE_REQUIRED_CODE = -32009

function methodAndId(message: unknown): { method?: string; id: unknown } {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { id: undefined }
  }
  const record = message as { method?: unknown; id?: unknown }
  return {
    method: typeof record.method === 'string' ? record.method : undefined,
    id: record.id,
  }
}

function protocolVersionParam(message: unknown): number | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const params = (message as { params?: unknown }).params
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined
  const value = (params as { protocolVersion?: unknown }).protocolVersion
  return typeof value === 'number' ? value : undefined
}

function rejectConnection(socket: Socket, id: unknown, code: number, message: string): void {
  if (socket.destroyed) return
  if (id === undefined) {
    // A notification has no reply channel; fail closed by dropping the socket.
    socket.destroy()
    return
  }
  // Flush the JSON-RPC error before half-closing so the client can report the
  // required mismatch/handshake message instead of a bare disconnect.
  socket.end(encodeFrame({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }))
}

export interface IpcServer {
  readonly path: string
  close(): Promise<void>
  dispose(): Promise<void>
}

export interface ForemanIpcPathOptions {
  path?: string
}

function isWindowsPipePath(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\')
}

function normalizePipeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-')
}

export function resolveIpcPath(name: string, baseDir?: string): string {
  if (process.platform === 'win32') {
    if (isWindowsPipePath(name)) return name
    return `\\\\.\\pipe\\${normalizePipeName(name)}`
  }

  if (isAbsolute(name)) return name
  if (baseDir) return join(baseDir, `${name}.sock`)
  return name
}

export function resolveForemanServiceIpcPath(options: ForemanIpcPathOptions): string {
  const configuredPath = options.path?.trim()
  if (configuredPath) {
    return process.platform === 'win32'
      ? resolveIpcPath(configuredPath)
      : resolveIpcPath(configuredPath, shortIpcBaseDir())
  }

  return resolveIpcPath('wrenyard', shortIpcBaseDir())
}

function shortIpcBaseDir(): string | undefined {
  if (process.platform === 'win32') return undefined

  try {
    return realpathSync('/tmp')
  } catch {
    return realpathSync(tmpdir())
  }
}

function removeUnixSocket(path: string): void {
  if (process.platform === 'win32') return
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code !== 'ENOENT') throw error
  }
}

async function prepareUnixSocket(path: string): Promise<void> {
  if (process.platform === 'win32' || !existsSync(path)) return

  if (await isUnixSocketActive(path)) {
    const error = new Error(`IPC endpoint is already in use: ${path}`) as NodeJS.ErrnoException
    error.code = 'EADDRINUSE'
    throw error
  }

  removeUnixSocket(path)
}

function isUnixSocketActive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    let settled = false

    function finish(active: boolean): void {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(active)
    }

    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(100, () => finish(false))
  })
}

export async function createIpcServer(options: IpcServerOptions): Promise<IpcServer> {
  const sockets = new Set<Socket>()
  let closed = false

  await prepareUnixSocket(options.path)

  const server = createServer((socket) => {
    sockets.add(socket)

    // Every connection must complete the version-checked health.ping handshake
    // before it may issue business requests. A mismatched (or otherwise
    // non-numeric) client version, and any business request sent first, fail
    // closed by rejecting the request and destroying the socket.
    let handshaken = false

    socket.on('error', () => {
      sockets.delete(socket)
      socket.destroy()
    })

    const decoder = createFrameDecoder({
      onMessage: (message) => {
        if (socket.destroyed || socket.writableEnded) return
        if (!handshaken) {
          const { method, id } = methodAndId(message)
          if (method !== HANDSHAKE_METHOD) {
            rejectConnection(
              socket,
              id,
              HANDSHAKE_REQUIRED_CODE,
              'IPC handshake required before business requests',
            )
            return
          }

          const clientVersion = protocolVersionParam(message)
          if (clientVersion !== undefined && clientVersion !== WRENYARD_PROTOCOL_VERSION) {
            rejectConnection(
              socket,
              id,
              PROTOCOL_VERSION_MISMATCH_CODE,
              protocolVersionMismatchMessage(clientVersion, WRENYARD_PROTOCOL_VERSION),
            )
            return
          }

          // A version-tagged ping completes the handshake; a plain ping stays
          // read-only and does not unlock business requests.
          if (clientVersion !== undefined) handshaken = true
        }
        void handleMessage(socket, message)
      },
      onError: (error) => {
        socket.destroy(error)
      },
    })

    socket.on('data', (chunk) => {
      try {
        decoder.write(chunk)
      } catch (error) {
        socket.destroy(error as Error)
      }
    })
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  async function handleMessage(socket: Socket, message: unknown): Promise<void> {
    try {
      const response = await options.onMessage(message)
      if (response !== undefined && !socket.destroyed) {
        socket.write(encodeFrame(response))
      }
    } catch (error) {
      socket.destroy(error as Error)
    }
  }

  function close(): Promise<void> {
    if (closed) return Promise.resolve()
    closed = true

    for (const socket of sockets) {
      socket.destroy()
    }

    return new Promise((resolve, reject) => {
      server.close((error) => {
        removeUnixSocket(options.path)
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  return new Promise((resolve, reject) => {
    function handleError(error: Error): void {
      server.off('listening', handleListening)
      removeUnixSocket(options.path)
      reject(error)
    }

    function handleListening(): void {
      server.off('error', handleError)
      // On non-Windows platforms, lock down the socket to owner-only access
      if (process.platform !== 'win32') {
        try {
          chmodSync(options.path, 0o600)
        } catch (error) {
          reject(error)
          return
        }
      }
      resolve({
        path: options.path,
        close,
        dispose: close,
      })
    }

    server.once('error', handleError)
    server.once('listening', handleListening)
    server.listen(options.path)
  })
}
