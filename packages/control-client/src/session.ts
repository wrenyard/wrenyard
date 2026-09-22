/**
 * Typed Wrenyard session control client.
 *
 * This is the IPC transport surface for the `session.*` protocol: it owns
 * framing, request/response correlation and reconnect, and returns the frozen
 * `@wrenyard/protocol/session` results unchanged. It never builds a
 * ConversationSnapshot itself and never imports the session feature package —
 * the daemon is the only owner of conversation state.
 */
import type {
  SessionBackendResult,
  SessionCancelParams,
  SessionCancelResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionSelectModelParams,
  SessionSelectModelResult,
  SessionSelectParams,
  SessionSelectResult,
  SessionSendParams,
  SessionSendResult,
  SessionSetWorkspaceParams,
  SessionSetWorkspaceResult,
  SessionSnapshotParams,
  SessionSnapshotResult,
  SessionSummaryModelResult,
  SessionSummaryModelSetParams,
} from '@wrenyard/protocol/session'
import {
  connectIpcClientTransport,
  JsonRpcClient,
  type IpcClientTransport,
  type NdjsonChunk,
} from './transport/index.ts'

export interface SessionClientOptions {
  /** Filesystem path of the daemon control socket. */
  ipcPath: string
}

interface SessionConnection {
  readonly transport: IpcClientTransport
  readonly rpc: JsonRpcClient
}

/**
 * JSON-RPC 2.0 client for the daemon's `session.*` methods.
 *
 * The constructor is synchronous: the socket is opened lazily on the first
 * request. A dropped connection rejects in-flight requests and is discarded so
 * the next request reconnects. Callers re-read a full snapshot after
 * reconnecting; this client never replays a prompt or cancels a turn on its
 * own.
 */
export class SessionClient {
  private readonly ipcPath: string
  private connection: SessionConnection | undefined
  private connecting: Promise<SessionConnection> | undefined
  private generation = 0
  private closed = false

  constructor(options: SessionClientOptions) {
    this.ipcPath = options.ipcPath
  }

  /** Versioned conversation snapshot; optionally waits for a revision change. */
  snapshot(params: SessionSnapshotParams = {}): Promise<SessionSnapshotResult> {
    return this.call<SessionSnapshotResult>('session.snapshot', params)
  }

  select(params: SessionSelectParams): Promise<SessionSelectResult> {
    return this.call<SessionSelectResult>('session.select', params)
  }

  create(params: SessionCreateParams = {}): Promise<SessionCreateResult> {
    return this.call<SessionCreateResult>('session.create', params)
  }

  selectModel(params: SessionSelectModelParams): Promise<SessionSelectModelResult> {
    return this.call<SessionSelectModelResult>('session.selectModel', params)
  }

  send(params: SessionSendParams): Promise<SessionSendResult> {
    return this.call<SessionSendResult>('session.send', params)
  }

  cancel(params: SessionCancelParams = {}): Promise<SessionCancelResult> {
    return this.call<SessionCancelResult>('session.cancel', params)
  }

  setWorkspace(params: SessionSetWorkspaceParams): Promise<SessionSetWorkspaceResult> {
    return this.call<SessionSetWorkspaceResult>('session.setWorkspace', params)
  }

  getSummaryModel(): Promise<SessionSummaryModelResult> {
    return this.call<SessionSummaryModelResult>('session.summary.model.get', {})
  }

  setSummaryModel(params: SessionSummaryModelSetParams): Promise<SessionSummaryModelResult> {
    return this.call<SessionSummaryModelResult>('session.summary.model.set', params)
  }

  /** Daemon-owned session backend diagnostics. */
  backend(): Promise<SessionBackendResult> {
    return this.call<SessionBackendResult>('session.backend', {})
  }

  /** Drop the connection and reject every in-flight request. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.generation += 1
    const connection = this.connection
    this.connection = undefined
    this.connecting = undefined
    connection?.rpc.close(new Error('SessionClient closed'))
    connection?.transport.close()
  }

  private call<TResult>(method: string, params: unknown): Promise<TResult> {
    return this.acquire().then((connection) => connection.rpc.request<TResult>(method, params))
  }

  private acquire(): Promise<SessionConnection> {
    if (this.closed) return Promise.reject(new Error('SessionClient is closed'))
    if (this.connection) return Promise.resolve(this.connection)
    let connecting = this.connecting
    if (!connecting) {
      const generation = ++this.generation
      connecting = this.open(generation)
      this.connecting = connecting
      const settle = (): void => {
        if (this.generation === generation) this.connecting = undefined
      }
      connecting.then(settle, settle)
    }
    return connecting
  }

  private async open(generation: number): Promise<SessionConnection> {
    let rpc: JsonRpcClient | undefined
    let failed: Error | undefined
    const buffered: NdjsonChunk[] = []
    const invalidate = (error: Error): void => {
      failed ??= error
      rpc?.close(error)
      if (this.generation !== generation) return
      this.connection = undefined
      this.connecting = undefined
    }

    const transport = await connectIpcClientTransport({
      path: this.ipcPath,
      onChunk: (chunk) => {
        if (rpc) rpc.handleIncoming(chunk)
        else buffered.push(chunk)
      },
      onError: (error) => invalidate(error),
      onClose: () => invalidate(new Error('IPC connection closed')),
    })

    rpc = new JsonRpcClient({ transport })
    for (const chunk of buffered) rpc.handleIncoming(chunk)

    if (failed || this.closed || this.generation !== generation) {
      transport.close()
      throw failed ?? new Error('SessionClient closed')
    }

    const connection: SessionConnection = { transport, rpc }
    this.connection = connection
    return connection
  }
}
