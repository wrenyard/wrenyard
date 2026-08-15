import { chmodSync, existsSync, realpathSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createFrameDecoder, encodeFrame } from './ndjson.mts'

export interface IpcServerOptions {
  path: string
  onMessage: (message: unknown) => unknown | Promise<unknown | undefined> | undefined
}

export interface IpcServer {
  readonly path: string
  close(): Promise<void>
  dispose(): Promise<void>
}

export interface ForemanIpcPathOptions {
  port?: number
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

    socket.on('error', () => {
      sockets.delete(socket)
      socket.destroy()
    })

    const decoder = createFrameDecoder({
      onMessage: (message) => {
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
