import { createConnection, type Socket } from 'node:net'

/**
 * Daemon-side stdio bridge for the remote SSH relay.
 *
 * The remote SSH relay runs this bridge on the target host as
 * `node daemon.mjs --stdio-bridge --connect-to <ipcPath>`. It byte-bridges the
 * relay's stdin/stdout to the remote daemon's owner-only IPC endpoint, so raw
 * NDJSON frames pass through untouched and the client's protocol-v2 handshake,
 * timeouts and cancellation are preserved exactly as they are locally.
 *
 * Safety rules:
 *  - `--connect-to` must be an owner-only IPC endpoint: a Unix domain socket on
 *    POSIX or a Windows named pipe. Any network form (`tcp://`, `http://`, ...)
 *    is refused, so this process is never a public listener.
 *  - Nothing but protocol bytes is ever written to stdout; diagnostics go to
 *    stderr, so the frame stream cannot be corrupted.
 *  - Buffering is bounded per direction; a peer that exceeds the bound is
 *    dropped instead of growing memory without limit.
 *  - No credential handling: the bridge forwards bytes only.
 *  - stdin EOF, a socket error, a signal and a socket close all release the
 *    descriptors this process opened.
 */

export type StdioBridgeErrorCode =
  | 'invalid_endpoint'
  | 'public_listener_forbidden'

export class StdioBridgeError extends Error {
  readonly code: StdioBridgeErrorCode

  constructor(code: StdioBridgeErrorCode, message: string) {
    super(message)
    this.name = 'StdioBridgeError'
    this.code = code
  }
}

const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024

/**
 * Fail closed unless the endpoint is an owner-only local IPC endpoint. Any URL
 * scheme (`tcp://`, `http://`, `https://`, ...) names a network endpoint and is
 * refused outright.
 */
export function assertBridgeEndpoint(path: string): void {
  if (!path) {
    throw new StdioBridgeError('invalid_endpoint', '缺少 --connect-to 端点路径')
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new StdioBridgeError('public_listener_forbidden', `不允许网络端点：${path}`)
  }
}

export interface StdioBridgeArgs {
  /** Owner-only daemon IPC endpoint to bridge to. */
  connectTo: string
}

/**
 * Parse the bridge argv (`--connect-to <path>`). A missing value or any unknown
 * argument returns `undefined`, so a mis-invocation fails closed instead of
 * silently bridging the wrong peer.
 */
export function parseStdioBridgeArgs(args: readonly string[]): StdioBridgeArgs | undefined {
  let connectTo: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--connect-to') {
      const value = args[index + 1]
      if (typeof value !== 'string' || value === '') return undefined
      connectTo = value
      index += 1
      continue
    }
    const prefix = '--connect-to='
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length)
      if (!value) return undefined
      connectTo = value
      continue
    }
    return undefined
  }
  return connectTo ? { connectTo } : undefined
}

export interface StdioBridgeOptions {
  /** Owner-only daemon IPC endpoint: a Unix socket or a Windows named pipe. */
  connectTo: string
  /** Inbound byte stream (defaults to `process.stdin`). */
  stdin?: NodeJS.ReadableStream
  /** Outbound byte stream (defaults to `process.stdout`). */
  stdout?: NodeJS.WritableStream
  /** Bounded per-direction buffer; a larger backlog drops the bridge. */
  maxBufferedBytes?: number
}

/**
 * Drop a stream's handle so a finished bridge never blocks process exit: always
 * release the reference, and optionally destroy the stream when it is a source
 * this process OWNS (never the outbound sink, whose pending bytes must flush).
 */
function releaseStream(stream: unknown, destroy: boolean): void {
  const candidate = stream as { unref?: () => void; destroy?: (error?: Error) => void }
  if (typeof candidate.unref === 'function') {
    try {
      candidate.unref()
    } catch {
      // Best effort: an already-torn-down stream rejects the call.
    }
  }
  if (destroy && typeof candidate.destroy === 'function') {
    try {
      candidate.destroy()
    } catch {
      // Best effort: the process may already be tearing the stream down.
    }
  }
}

/**
 * Run one stdio<->IPC bridge. Resolves with the process exit code once the
 * tunnel has ended (stdin EOF, socket close, error or signal) and every handle
 * this call opened has been released. Never writes to stdout except the byte
 * stream itself.
 */
export async function runStdioBridge(options: StdioBridgeOptions): Promise<number> {
  const { connectTo } = options
  assertBridgeEndpoint(connectTo)
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES

  return await new Promise<number>((resolve) => {
    let settled = false
    let socketClosing = false
    let inboundBuffered = 0
    let outboundBuffered = 0
    const socket: Socket = createConnection(connectTo)

    const finalize = (code: number): void => {
      if (settled) return
      settled = true
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      stdin.off('data', onStdinData)
      stdin.off('end', onStdinEnd)
      stdin.off('error', onStdinError)
      stdout.off('drain', onStdoutDrain)
      stdin.pause()
      if (!socket.destroyed) socket.destroy()
      // Detach the process's own descriptors so the event loop can drain and the
      // process exits without orphaning stdin/stdout: the inbound source is
      // owned and destroyed, the outbound sink is only released so its last
      // bytes flush.
      releaseStream(stdin, true)
      releaseStream(stdout, false)
      resolve(code)
    }

    const shutdown = (code: number): void => {
      if (socketClosing) {
        finalize(code)
        return
      }
      socketClosing = true
      finalize(code)
    }

    function onSignal(): void {
      shutdown(0)
    }
    function onStdinData(chunk: Buffer): void {
      if (socket.destroyed) return
      inboundBuffered += chunk.length
      if (inboundBuffered > maxBuffered) {
        process.stderr.write('[wrenyard-stdio-bridge] 入站缓冲超过上限，连接关闭\n')
        shutdown(1)
        return
      }
      const ok = socket.write(chunk, () => { inboundBuffered -= chunk.length })
      if (!ok) stdin.pause()
    }
    function onStdinEnd(): void {
      if (!socket.destroyed) socket.end()
    }
    function onStdinError(): void {
      shutdown(1)
    }
    function onSocketData(chunk: Buffer): void {
      if (settled) return
      outboundBuffered += chunk.length
      if (outboundBuffered > maxBuffered) {
        process.stderr.write('[wrenyard-stdio-bridge] 出站缓冲超过上限，连接关闭\n')
        shutdown(1)
        return
      }
      const ok = stdout.write(chunk, () => { outboundBuffered -= chunk.length })
      if (!ok) socket.pause()
    }
    function onSocketDrain(): void {
      stdin.resume()
    }
    function onStdoutDrain(): void {
      if (!socket.destroyed) socket.resume()
    }
    function onSocketEnd(): void {
      stdout.end()
      shutdown(0)
    }
    function onSocketClose(): void {
      shutdown(0)
    }
    function onSocketError(error: Error): void {
      process.stderr.write(
        `[wrenyard-stdio-bridge] 连接远程 daemon 失败：${error instanceof Error ? error.message : String(error)}\n`,
      )
      shutdown(1)
    }

    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    stdin.on('data', onStdinData)
    stdin.on('end', onStdinEnd)
    stdin.on('error', onStdinError)
    stdout.on('drain', onStdoutDrain)
    socket.on('data', onSocketData)
    socket.on('drain', onSocketDrain)
    socket.on('end', onSocketEnd)
    socket.on('close', onSocketClose)
    socket.on('error', onSocketError)
  })
}
