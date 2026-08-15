import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { deliverToConnection, type McpConnection } from '../../adapters/message/backends/index.mts'
import { foremanPackageRoot, resolveWrenyardSuiteRoot } from '../../layout/suite-root.mts'
import type { MessageEnvelope, MessageDeliveryResult } from '../../message/delivery/types.mts'
import type { MessageSender } from '../../message/protocol.mts'
import type { OperationHost } from '../../core/operations/types.mts'
import { foremanWorkspaceFromEnv } from '../../core/project/manager.mts'
import { methodRegistry } from '../../protocol/registry.mts'
import { RpcRouter } from '../rpc-router.mts'
import { mcpProtocolTools } from '../../protocol/agent-tools.mts'
import type { ProtocolToolSpec } from '../../protocol/agent-tools.mts'
import { registerCoreHandlers } from '../handlers/core.mts'
import { discoverTasks, ensureDiscovered } from '../../workspace/task-loader.mts'
import { startHotReload, type HotReloadHandle } from '../../workspace/hot-reload.mts'
import type { MessageService } from '../../message/message-service.mts'

const PROTOCOL_VERSION = '2024-11-05'
const PROJECT_PARAMETER_DESCRIPTION = "Project qualified name. Resolves to the project's real checkout directory on disk, and identifies its relative path within the workspace. Examples: 'workspace', 'forge', 'foreman', 'ure/service', 'gol/project'"

type JsonRecord = Record<string, unknown>

export interface WorkTranscriptPort {
  transcript(afterSeq?: number, limit?: number, includeArchived?: boolean): Promise<{
    entries: Array<{ seq: number; turn_seq?: number; kind: string; payload: unknown; created_at: string }>
    next_seq: number
    has_more: boolean
    state: string
  }>
}

export interface ForemanMcpServerOptions {
  workspaceRoot?: string
  operations?: OperationHost
  rpcRouter?: RpcRouter
  messageService?: MessageService
  workTranscriptPort?: WorkTranscriptPort
  startedAt?: number
}

interface RpcRequest {
  jsonrpc: string
  id?: unknown
  method: string
  params?: unknown
}

interface RpcResponse {
  jsonrpc: string
  id?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface TextContent {
  type: 'text'
  text: string
}

interface ToolResult {
  content: TextContent[]
  structuredContent?: unknown
  isError?: boolean
}

interface McpRequestContext {
  transport?: 'mcp'
  connectingId?: string
  sender?: MessageSender
}


interface LocalToolDefinition {
  name: string
  description: string
  inputSchema: JsonRecord
}

const protocolToolByName = new Map(mcpProtocolTools.map((tool) => [tool.name, tool]))
const frontProtocolToolNames = new Set(['status', 'worktree_create', 'worktree_remove', 'git_push'])

// Session tools operate on live MCP channel connections held by this transport.
// They are intentionally not Foreman business RPC methods.
const localToolDefinitions: LocalToolDefinition[] = [
  {
    name: 'sessions_list',
    description: 'List active channel-capable sessions (CCC interactive sessions)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'session_send',
    description: 'Send a targeted message to a specific channel-capable session',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'message'],
      properties: {
        session_id: { type: 'string', description: 'Session connection ID' },
        message: { type: 'string', description: 'Message to deliver' },
        title: { type: 'string', description: 'Optional message title (default: "message")' },
        severity: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Severity level (default: info)' },
      },
    },
  },
  {
    name: 'work_send',
    description: 'Send a message to the foreman-work agent. The sender is derived from the MCP connection context (sender query parameter).',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Message text to send to foreman-work' },
        client_message_id: { type: 'string', description: 'Optional client-provided idempotency key' },
        attachments: {
          type: 'array',
          description: 'Attachment descriptors (local filesystem paths to images)',
          items: {
            type: 'object',
            required: ['path'],
            properties: {
              path: { type: 'string', description: 'Absolute path to image file' },
            },
            additionalProperties: false,
          },
        },
      },
    },
  },
  {
    name: 'work_transcript',
    description: 'Read the foreman-work transcript. Requires work.read grant on the sender principal.',
    inputSchema: {
      type: 'object',
      properties: {
        after_seq: { type: 'integer', minimum: 0, description: 'Return events with seq > after_seq' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum entries (default 200)' },
        include_archived: { type: 'boolean', description: 'Include events before the latest compact (default false)' },
      },
    },
  },
]

export class ForemanMcpServer {
  private readonly workspaceRoot: string
  private readonly rpcRouter: RpcRouter
  private readonly messageService?: MessageService
  private readonly workTranscriptPort?: WorkTranscriptPort
  private readonly version: string
  private hotReloadHandle: HotReloadHandle | undefined
  private connections = new Map<string, McpConnection>()

  constructor(options: ForemanMcpServerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? foremanWorkspaceFromEnv() ?? resolveWrenyardSuiteRoot()
    this.rpcRouter = options.rpcRouter ?? this.createDefaultRpcRouter(options)
    this.messageService = options.messageService
    this.workTranscriptPort = options.workTranscriptPort
    this.version = this.readPackageVersion()
  }

  getConnections(): Map<string, McpConnection> {
    return this.connections
  }

  injectConnections(map: Map<string, McpConnection>): void {
    this.connections = map
  }

  async initializeRuntime(): Promise<void> {
    await discoverTasks(this.workspaceRoot)
    this.hotReloadHandle ??= startHotReload(this.workspaceRoot)
  }

  close(): void {
    this.hotReloadHandle?.close()
    this.hotReloadHandle = undefined
  }

  toolDefinitions(): JsonRecord[] {
    const frontProtocolTools = mcpProtocolTools.filter((tool) => frontProtocolToolNames.has(tool.name))
    const remainingProtocolTools = mcpProtocolTools.filter((tool) => !frontProtocolToolNames.has(tool.name))
    return [
      ...frontProtocolTools.map(protocolToolDefinition),
      ...localToolDefinitions.map((tool) => ({ ...tool })),
      ...remainingProtocolTools.map(protocolToolDefinition),
    ]
  }

  async handleToolCall(name: string, args: JsonRecord = {}, context?: string | McpRequestContext): Promise<unknown> {
    const requestContext = normalizeMcpContext(context)
    const protocolTool = protocolToolByName.get(name)
    if (protocolTool) {
      return this.callProtocolTool(protocolTool, args, requestContext)
    }

    switch (name) {
      case 'sessions_list':
        return this.sessionsListTool()
      case 'session_send':
        return this.sessionSendTool(args)
      case 'work_send':
        return this.workSendTool(args, requestContext)
      case 'work_transcript':
        return this.workTranscriptTool(args, requestContext)
      default:
        throw new MethodNotFoundError()
    }
  }

  async handleLine(line: string, context?: string | McpRequestContext): Promise<RpcResponse | null> {
    let req: RpcRequest
    try {
      req = JSON.parse(line) as RpcRequest
    } catch {
      return this.rpcError(undefined, -32700, 'parse error')
    }

    if (typeof req.method === 'string' && req.method.startsWith('notifications/')) return null

    try {
      const result = await this.handleRequest(req, normalizeMcpContext(context))
      return { jsonrpc: '2.0', id: req.id, result }
    } catch (error) {
      const code = error instanceof MethodNotFoundError
        ? -32601
        : error instanceof InvalidParamsError
          ? -32602
          : -32600
      const message = error instanceof MethodNotFoundError ? 'method not found' : errorMessage(error)
      return this.rpcError(req.id, code, message)
    }
  }

  private async handleRequest(req: RpcRequest, context: McpRequestContext): Promise<unknown> {
    switch (req.method) {
      case 'initialize':
        return this.handleInitialize(req, context.connectingId)
      case 'tools/list': {
        await ensureDiscovered(this.workspaceRoot)
        return { tools: this.toolDefinitions() }
      }
      case 'tools/call': {
        const params = requireRecord(req.params ?? {}, 'tools/call params')
        const name = requireString(params, 'name')
        const args = requireRecord(params.arguments ?? {}, 'tools/call arguments')
        try {
          return this.toolOK(await this.handleToolCall(name, args, context))
        } catch (error) {
          if (error instanceof InvalidParamsError) throw error
          return this.toolError(error)
        }
      }
      default:
        throw new MethodNotFoundError()
    }
  }

  private handleInitialize(req: RpcRequest, connectionId?: string): unknown {
    const clientCaps = (req.params as Record<string, unknown> | undefined)?.capabilities as Record<string, unknown> | undefined
    const channelCapable = clientCaps?.['claude/channel'] !== undefined

    if (connectionId) {
      const conn = this.connections.get(connectionId)
      if (conn) conn.channelCapable = channelCapable
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        'claude/channel': {},
      },
      serverInfo: {
        name: 'foreman',
        version: this.version,
      },
    }
  }

  private async callProtocolTool(spec: ProtocolToolSpec, args: JsonRecord, context: McpRequestContext): Promise<unknown> {
    const params = spec.params ? spec.params(args) : args
    const response = await this.rpcRouter.handleMessage({
      jsonrpc: '2.0',
      id: `mcp_${randomBytes(6).toString('hex')}`,
      method: spec.method,
      params,
    }, { ...context, transport: 'mcp' })
    if (!response) throw new Error(`No RPC response for ${spec.method}`)
    if ('error' in response) throw new Error(rpcErrorMessage(response.error))
    return spec.result ? spec.result(response.result) : response.result
  }

  private sessionsListTool(): Array<{
    id: string
    label: string
    cwd: string
    pid: number
    startedAt: string
    host: string
    clientName: string
    clientVersion: string
  }> {
    const list: ReturnType<ForemanMcpServer['sessionsListTool']> = []
    for (const conn of this.connections.values()) {
      if (!conn.channelCapable) continue
      list.push({
        id: conn.id,
        label: conn.label ?? '',
        cwd: conn.cwd ?? '',
        pid: conn.pid ?? 0,
        startedAt: conn.startedAt ?? '',
        host: conn.host ?? '',
        clientName: conn.clientName ?? '',
        clientVersion: conn.clientVersion ?? '',
      })
    }
    return list
  }

  private sessionSendTool(args: JsonRecord): MessageDeliveryResult {
    const sessionId = requireString(args, 'session_id')
    const message = requireString(args, 'message')
    const title = optionalString(args, 'title') ?? 'message'
    const severity = optionalSeverity(args, 'severity')

    const event: MessageEnvelope = {
      id: `mcp_send_${randomBytes(6).toString('hex')}`,
      kind: 'message',
      severity,
      title,
      body: message,
      refs: {},
      ts: new Date().toISOString(),
    }

    return deliverToConnection({ connections: this.connections }, sessionId, event)
  }

  private async workSendTool(args: JsonRecord, context: McpRequestContext): Promise<unknown> {
    const text = requireString(args, 'text')
    const clientMessageId = optionalString(args, 'client_message_id')

    // Parse attachments
    const rawAttachments = args.attachments
    const attachments: Array<{ path: string }> | undefined = Array.isArray(rawAttachments)
      ? rawAttachments.map((a: unknown) => {
          if (typeof a !== 'object' || a === null) throw new InvalidParamsError('each attachment must be an object')
          const record = a as Record<string, unknown>
          if (typeof record.path !== 'string' || !record.path.trim()) throw new InvalidParamsError('each attachment must have a path string')
          return { path: record.path.trim() }
        })
      : undefined

    // Sender comes from MCP context (set via ?sender= query param)
    const senderRole = context.sender?.role
    if (!senderRole) {
      throw new Error('work_send requires a sender principal. Connect with ?sender=<principal>')
    }

    if (!this.messageService) {
      throw new Error('work_send unavailable: message service not configured')
    }

    const result = await this.messageService.send({
      from: senderRole,
      to: 'foreman-work',
      text,
      ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
      ...(attachments ? { attachments } : {}),
    })

    // Return the spec shape: { message_id, accepted, target_seq, queue_depth, attachments }
    if ('ok' in result && !result.ok) {
      throw new Error(`work_send failed: ${(result as { error: string }).error}`)
    }

    const sendResult = result as { message_id: string; accepted: boolean; target_seq?: number; queue_depth?: number; attachments?: unknown }
    return {
      message_id: sendResult.message_id,
      accepted: sendResult.accepted,
      ...(sendResult.target_seq !== undefined ? { target_seq: sendResult.target_seq } : {}),
      ...(sendResult.queue_depth !== undefined ? { queue_depth: sendResult.queue_depth } : {}),
      ...(sendResult.attachments ? { attachments: sendResult.attachments } : {}),
    }
  }

  private async workTranscriptTool(args: JsonRecord, context: McpRequestContext): Promise<unknown> {
    // Sender must exist and have work.read grant
    const senderRole = context.sender?.role
    if (!senderRole) {
      throw new Error('work_transcript requires a sender principal. Connect with ?sender=<principal>')
    }
    if (!this.messageService?.canReadWork(senderRole)) {
      throw new Error(`work_transcript forbidden for principal '${senderRole}'`)
    }

    if (!this.workTranscriptPort) {
      throw new Error('work_transcript unavailable: Work service not started')
    }

    const afterSeq = typeof args.after_seq === 'number' ? args.after_seq : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    const includeArchived = args.include_archived === true

    const result = await this.workTranscriptPort.transcript(afterSeq, limit, includeArchived)
    const entries = result.entries.map((e) => {
      const payload = typeof e.payload === 'object' && e.payload !== null ? e.payload as Record<string, unknown> : {}
      const attachmentResults = payload.attachments
      return {
        seq: e.seq,
        ...(e.turn_seq !== undefined ? { turn_seq: e.turn_seq } : {}),
        kind: e.kind,
        payload: e.payload,
        ...(Array.isArray(attachmentResults) && attachmentResults.length > 0
          ? { attachments: attachmentResults }
          : {}),
        created_at: e.created_at,
      }
    })
    return {
      entries,
      next_seq: result.next_seq,
      has_more: result.has_more,
      state: result.state,
    }
  }

  private createDefaultRpcRouter(options: ForemanMcpServerOptions): RpcRouter {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: options.startedAt ?? Date.now(),
      workspaceRoot: this.workspaceRoot,
      messageService: options.messageService,
      operations: options.operations,
    })
    return router
  }

  private readPackageVersion(): string {
    try {
      const pkg = JSON.parse(readFileSync(join(foremanPackageRoot, 'package.json'), 'utf-8')) as { version?: unknown }
      return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : '0.0.0'
    } catch {
      return '0.0.0'
    }
  }

  private toolOK(value: unknown): ToolResult {
    const structuredContent = structuredToolContent(value)
    return {
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      ...(structuredContent === undefined ? {} : { structuredContent }),
    }
  }

  private toolError(error: unknown): ToolResult {
    return {
      content: [{ type: 'text', text: errorMessage(error) }],
      isError: true,
    }
  }

  private rpcError(id: unknown, code: number, message: string): RpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }
  }
}

function protocolToolDefinition(spec: ProtocolToolSpec): JsonRecord {
  const schema = methodRegistry[spec.method].params as JsonRecord
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: withProjectDescriptions(schema),
  }
}

function withProjectDescriptions(schema: JsonRecord): JsonRecord {
  const copy = JSON.parse(JSON.stringify(schema)) as JsonRecord
  const properties = copy.properties
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const project = (properties as JsonRecord).project
    if (project && typeof project === 'object' && !Array.isArray(project)) {
      ;(project as JsonRecord).description ??= PROJECT_PARAMETER_DESCRIPTION
    }
  }
  return copy
}

function normalizeMcpContext(context: string | McpRequestContext | undefined): McpRequestContext {
  if (typeof context === 'string') return { connectingId: context }
  if (!context || typeof context !== 'object') return {}
  return {
    ...(typeof context.connectingId === 'string' && context.connectingId.trim()
      ? { connectingId: context.connectingId.trim() }
      : {}),
    ...(isSender(context.sender) ? { sender: context.sender } : {}),
  }
}

function isSender(value: unknown): value is MessageSender {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { role?: unknown }).role === 'string'
    && Boolean((value as { role: string }).role.trim())
}

class MethodNotFoundError extends Error {}

class InvalidParamsError extends Error {}

function requireRecord(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidParamsError(`${name} must be an object`)
  }
  return value as JsonRecord
}

function requireString(args: JsonRecord, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new InvalidParamsError(`${key} is required`)
  return value.trim()
}

function optionalString(args: JsonRecord, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new InvalidParamsError(`${key} must be a string`)
  const trimmed = value.trim()
  return trimmed || undefined
}

function optionalSeverity(args: JsonRecord, key: string): MessageEnvelope['severity'] {
  const value = optionalString(args, key)
  if (!value) return 'info'
  if (value === 'info' || value === 'success' || value === 'warning' || value === 'error') return value
  throw new InvalidParamsError(`${key} must be one of: info, success, warning, error`)
}

function structuredToolContent(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!Object.hasOwn(value, 'task_run_id')) return undefined
  const output = (value as JsonRecord).output
  return output && typeof output === 'object' ? output : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function rpcErrorMessage(error: { message: string; data?: unknown }): string {
  const data = error.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const detailMessage = (data as { message?: unknown }).message
    if (typeof detailMessage === 'string' && detailMessage.trim()) return detailMessage
  }
  return error.message
}
