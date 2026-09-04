import { timingSafeEqual, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../db/connection.mts'
import type { ForemanDatabase } from '../db/types.mts'
import { MessageStore } from '../db/stores/message-store.mts'
import { WorkflowRunStore } from '../db/stores/workflow-run-store.mts'
import type { OperationHost } from '../core/operations/types.mts'
import type { ForemanServiceConfig } from '../config/index.mts'
import { resolveToken } from '../config/index.mts'
import { ForemanMcpServer } from '../server/mcp/server.mts'
import { resolvePortConflict } from './startup/port-guard.mts'
import { RpcRouter } from '../server/rpc-router.mts'
import { registerCoreHandlers } from '../server/handlers/core.mts'
import { createIpcServer, resolveForemanServiceIpcPath, type IpcServer } from '../transport/ipc-server.mts'
import { setAgentExecutionSupervisor } from '../core/operations/primitives/agent.mts'
import { setTaskWorkflowRunner } from '../core/operations/primitives/runner.mts'
import { AgentExecutionSupervisor, type SupervisorLogger } from './execution/agent-supervisor.mts'
import { TaskWorkflowRunner } from './execution/task-workflow-runner.mts'
import { handleRestApiRequest } from '../server/http/rest-api.mts'
import { RepoWriteLocks } from './execution/repo-write-locks.mts'
import { DispatchControl } from './dispatch-control.mts'
import { PlannedRestartStore } from './planned-restart-store.mts'
import { MessageDeliveryHub, type BackendFactory } from '../message/delivery/hub.mts'
import { createBackend, createTransport, deliverToConnection, type BackendDeps, type McpConnection, type TransportFactory } from '../adapters/message/backends/index.mts'
import type { ChannelConfig, MessageEnvelope, MessageDeliveryResult, MessageDeliveryRegistryConfig } from '../message/delivery/types.mts'
import { createTaskGraphService } from './services/taskgraph-service.mts'
import { TaskGraphService } from '../core/taskgraph/index.mts'
import { getForemanEventBus } from '../events/event-bus.mts'
import type { ForemanEvent, ForemanEventKind, ForemanEventSeverity } from '../events/event-types.mts'
import { MessageService, type ExternalDeliveryPort } from '../message/message-service.mts'
import { WorkspaceDocService } from './services/workspace-doc-service.mts'
import { createModelGateway, type ModelGateway } from '@wrenyard/gateway'
import { createBuiltinCatalog, createBuiltinProviderRuntime, resolveBuiltinDispatchPlans } from '@wrenyard/providers'
import { ForemanEventStore } from '../events/event-store.mts'
import { foremanStateRoot } from '../config/state.mts'
import { ClientConfigurationService } from '../client-configuration/service.mts'
import { InstalledClientDiscovery } from '../client-configuration/discovery.mts'
import { JsonClientOwnershipStore } from '../client-configuration/ownership-store.mts'
import { ClaudeAppAdapter, WRENYARD_CLAUDE_PROFILE_ID } from '../client-configuration/adapters/claude-app.mts'
import { ClaudeCodeAdapter } from '../client-configuration/adapters/claude-code.mts'
import { CodexSharedAdapter } from '../client-configuration/adapters/codex-shared.mts'
import { GrokBuildAdapter } from '../client-configuration/adapters/grok-build.mts'
import {
  DaemonGatewayClientSource,
  ensureGatewayCredentialHelper,
  loadOrCreateGatewayCredential,
} from '../client-configuration/gateway-source.mts'

export interface RunningForemanDaemon {
  db: ForemanDatabase
  repoWriteLocks: RepoWriteLocks
  supervisor: AgentExecutionSupervisor
  runner: TaskWorkflowRunner
  dispatchControl: DispatchControl
  mcpServer: ForemanMcpServer
  httpServer: Server
  ipcPath: string
  ipcServer: IpcServer
  gateway: ModelGateway
  stop(): Promise<void>
}

export interface ForemanDaemonDeps {
  messageTransportFactory?: TransportFactory
  deliveryBackendFactory?: BackendFactory
  /**
   * Inject the durable planned-restart store. When omitted the daemon uses the
   * default store rooted at the Foreman state directory. The store is read and
   * validated before any runtime bootstrap so a persisted planned_restart plan
   * is in force before HTTP, IPC, MCP, or task/workflow dispatch becomes
   * reachable.
   */
  plannedRestartStore?: PlannedRestartStore
}

export interface ForemanDaemonOptions {
  config: ForemanServiceConfig
  configPath?: string
  deps?: ForemanDaemonDeps
  onShutdownRequest?: (reason: string) => void | Promise<void>
}

export class ForemanDaemon {
  private readonly config: ForemanServiceConfig
  private readonly configPath: string | undefined
  private readonly deps: ForemanDaemonDeps
  private readonly onShutdownRequest: ((reason: string) => void | Promise<void>) | undefined
  private running: RunningForemanDaemon | undefined

  constructor(options: ForemanDaemonOptions) {
    this.config = options.config
    this.configPath = options.configPath
    this.deps = options.deps ?? {}
    this.onShutdownRequest = options.onShutdownRequest
  }

  async start(): Promise<RunningForemanDaemon> {
    if (this.running) return this.running
    this.running = await startForemanDaemon(this.config, this.deps, {
      configPath: this.configPath,
      onShutdownRequest: this.onShutdownRequest,
    })
    return this.running
  }

  async stop(): Promise<void> {
    const current = this.running
    if (!current) return
    this.running = undefined
    await current.stop()
  }

  get current(): RunningForemanDaemon | undefined {
    return this.running
  }
}

let activeDaemonDbUsers = 0

function createExternalDeliveryPort(
  config: ForemanServiceConfig,
  deps: ForemanDaemonDeps,
  messageStore: MessageStore,
): ExternalDeliveryPort {
  const deliveryDeps: BackendDeps = { peers: config.messageDelivery?.peers }
  const transportFactory = deps.messageTransportFactory
    ?? ((routeId, route) => createTransport(routeId, route, deliveryDeps))

  return {
    async deliver(deliveryId, messageId, routeId, transport, envelope) {
      const route = config.message.routes?.[routeId]
      if (!route || route.transport !== transport) {
        const error = `message route '${routeId}' is not configured for transport '${transport}'`
        messageStore.markFailed(deliveryId, error, new Date().toISOString())
        return { deliveryId, status: 'failed', ok: false, error }
      }

      try {
        const result = await transportFactory(routeId, route).deliver({
          id: `foreman:message:${messageId}`,
          kind: 'message',
          severity: 'info',
          title: 'Foreman message',
          body: envelope.text,
          refs: { taskId: messageId },
          origin: { channel: 'foreman-message', sender: envelope.from },
          ts: new Date().toISOString(),
        }, routeId)
        if (!result.ok) throw new Error(result.error ?? 'message delivery failed')
        messageStore.markDelivered(deliveryId, new Date().toISOString())
        return { deliveryId, status: 'delivered', ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        messageStore.markFailed(deliveryId, message, new Date().toISOString())
        return { deliveryId, status: 'failed', ok: false, error: message }
      }
    },
  }
}

export async function startForemanDaemon(
  config: ForemanServiceConfig,
  deps: ForemanDaemonDeps = {},
  options: { configPath?: string; onShutdownRequest?: (reason: string) => void | Promise<void> } = {},
): Promise<RunningForemanDaemon> {
  // Hydrate the durable admission plan BEFORE any database or runtime bootstrap
  // so a persisted planned_restart mode is in force before HTTP, IPC, MCP, or
  // task/workflow dispatch becomes reachable. Construction already validates the
  // snapshot; re-read it here so a malformed plan can never fail bootstrap open.
  const plannedRestartStore = deps.plannedRestartStore ?? new PlannedRestartStore()
  plannedRestartStore.snapshot()
  const dispatchControl = new DispatchControl(plannedRestartStore)

  let runtime: ForemanDaemonRuntime | undefined
  try {
    runtime = await bootstrapForemanDaemonRuntime(dispatchControl)
    return await startForemanDaemonWithRuntime(config, runtime, deps, options)
  } catch (error) {
    if (runtime) {
      // Preserve existing runtime resource cleanup (supervisor shutdown + db
      // release). Intentionally NOT performing db/schema rollback, git
      // rollback, drain waiting, plan completion, or admission restoration.
      await cleanupFailedDaemonStart(runtime)
    }
    // If a durable plan is active, record the startup failure as a recoverable
    // planned_restart failure; admission stays closed (mode unchanged).
    failActivePlannedRestartOnStartup(plannedRestartStore, error, options.configPath)
    throw error
  }
}

async function startForemanDaemonWithRuntime(
  config: ForemanServiceConfig,
  runtime: ForemanDaemonRuntime,
  deps: ForemanDaemonDeps,
  options: { configPath?: string; onShutdownRequest?: (reason: string) => void | Promise<void> },
): Promise<RunningForemanDaemon> {
  const operations: OperationHost = {
    agent: runtime.supervisor,
    runner: runtime.runner,
  }

  // Single shared TaskGraphService used by all RPC transports.
  const taskgraphWorkspaceRoot = config.workspaceRoot
  const taskgraphService = createTaskGraphService({
    workspaceRoot: taskgraphWorkspaceRoot,
    operations,
    eventSink: (event) => {
      const severity: ForemanEventSeverity = event.type === 'taskgraph.node.failed'
        ? 'error'
        : event.type === 'taskgraph.done'
          ? 'success'
          : event.type === 'taskgraph.paused'
            ? 'warning'
            : 'info'
      const foremanEvent: ForemanEvent = {
        id: event.event_id,
        kind: event.type as ForemanEventKind,
        source: 'foreman.taskgraph',
        severity,
        refs: {
          taskgraphId: event.taskgraph_id,
          ...(event.refs?.task_run_id ? { taskRunId: event.refs.task_run_id } : {}),
        },
        data: {
          seq: event.seq,
          structure_revision: event.structure_revision,
          ...(event.refs ? { refs: event.refs } : {}),
          ...event.data,
        },
        occurredAt: event.occurred_at,
      }
      return getForemanEventBus().publish(foremanEvent)
    },
  })
  let messageService: MessageService

  const messageStore = new MessageStore(runtime.db)
  messageService = new MessageService({
    registry: config.message,
    store: messageStore,
  })
  messageService.setExternalDeliveryPort(createExternalDeliveryPort(config, deps, messageStore))

  // Construct the legacy event-delivery hub. Its config still says channels,
  // but the hub treats them as route ids internally.
  const deliveryConfig = config.messageDelivery
  let deliveryHub: MessageDeliveryHub | null = null
  // Shared connection map: the MCP server populates it, cc-channel backend reads it.
  const connections = new Map<string, McpConnection>()
  // Track active SSE streams for clean shutdown (Fix 2)
  const activeSseStreams: Array<{ res: ServerResponse; timer: NodeJS.Timeout; connId: string; conn: McpConnection }> = []
  const deliveryDeps: BackendDeps = {
    connections,
    peers: deliveryConfig?.peers,
  }
  if (deliveryConfig && deliveryConfig.enabled) {
    const backendFactory = deps.deliveryBackendFactory ?? ((name: string, cfg: ChannelConfig) => createBackend(name, cfg, deliveryDeps))
    deliveryHub = new MessageDeliveryHub(deliveryConfig, backendFactory)
  }

  const startedAt = Date.now()
  let boundPort = config.service.port
  const stateRoot = foremanStateRoot()
  const gatewayToken = await loadOrCreateGatewayCredential(join(stateRoot, 'gateway', 'credential'))
  const catalog = createBuiltinCatalog()
  const dispatchPlans = resolveBuiltinDispatchPlans(catalog)
  const providerRuntime = createBuiltinProviderRuntime()
  const gatewayEventStore = new ForemanEventStore(runtime.db)
  const gateway = createModelGateway({
    catalog,
    providers: providerRuntime,
    onRequestCompleted: async (event) => {
      const foremanEvent: ForemanEvent = {
        id: `gateway_${randomBytes(12).toString('hex')}`,
        kind: 'gateway.request.completed',
        source: 'wrenyard.gateway',
        severity: event.status >= 500 ? 'error' : event.status >= 400 ? 'warning' : 'info',
        refs: {},
        data: { ...event },
        occurredAt: new Date().toISOString(),
      }
      gatewayEventStore.append(foremanEvent)
      await getForemanEventBus().publish(foremanEvent)
    },
  })
  // Recovered tasks can dispatch during startup reconciliation, before the
  // HTTP listener and IPC transport are exposed. Install the exact daemon
  // plan and provisional loopback connection first so Forge never falls back
  // to resolving provider/model/protocol data itself.
  let restoreGatewayEnvironment = installGatewayEnvironment({
    ...await gateway.connection(gatewayOrigin(config.service.host, config.service.port)),
    token: gatewayToken,
  }, dispatchPlans)
  let stopFromShutdownRequest: ((reason: string) => Promise<void>) | undefined
  const workspaceDocService = new WorkspaceDocService(config.workspaceRoot)
  const clientDiscovery = new InstalledClientDiscovery()
  const clientOwnership = new JsonClientOwnershipStore(join(stateRoot, 'client-configuration', 'ownership.json'))
  const credentialHelperPath = join(stateRoot, 'client-configuration', 'gateway-credential-helper')
  let activeIpcPath = resolveForemanServiceIpcPath({
    port: config.service.port,
    path: config.service.ipc?.path,
  })
  const clientGateway = new DaemonGatewayClientSource({
    catalog,
    providers: providerRuntime,
    connection: async () => {
      const connection = await gateway.connection(gatewayOrigin(config.service.host, boundPort))
      return {
        openaiChatBaseUrl: connection.openaiChatBaseUrl,
        openaiResponsesBaseUrl: connection.openaiResponsesBaseUrl,
        anthropicBaseUrl: connection.anthropicBaseUrl,
      }
    },
    credential: () => gatewayToken,
    credentialHelperPath,
  })
  const home = homedir()
  const claudeLibrary = join(home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary')
  const capability = async (surfaceId: 'claude-app' | 'claude-code') => {
    const surface = (await clientDiscovery.list()).find((entry) => entry.id === surfaceId)
    return {
      supported: surface?.installed === true && surface.compatibility === 'supported',
      ...(surface?.compatibility === 'externally-managed' ? { externallyManaged: true } : {}),
      ...(surface?.detail ? { detail: surface.detail } : {}),
    }
  }
  const clientConfigurationService = new ClientConfigurationService(
    clientDiscovery,
    [
      new ClaudeAppAdapter({
        metaPath: join(claudeLibrary, '_meta.json'),
        profilePath: join(claudeLibrary, `${WRENYARD_CLAUDE_PROFILE_ID}.json`),
        store: clientOwnership,
        capabilityProbe: () => capability('claude-app'),
      }),
      new ClaudeCodeAdapter({
        settingsPath: join(home, '.claude', 'settings.json'),
        store: clientOwnership,
        capabilityProbe: () => capability('claude-code'),
      }),
      new CodexSharedAdapter({
        configPath: join(home, '.codex', 'config.toml'),
        catalogPath: join(stateRoot, 'client-configuration', 'codex-models.json'),
        store: clientOwnership,
      }),
      new GrokBuildAdapter({ configPath: join(home, '.grok', 'config.toml'), store: clientOwnership }),
    ],
    clientGateway,
  )
  const rpcRouter = createDaemonRpcRouter({
    startedAt,
    workspaceRoot: config.workspaceRoot,
    messageService,
    operations,
    dispatchControl: runtime.dispatchControl,
    taskgraphService,
    workspaceDocService,
    gatewayConnection: async () => ({
      ...await gateway.connection(gatewayOrigin(config.service.host, boundPort)),
      token: gatewayToken,
    }),
    providerList: async () => ({
      providers: await Promise.all(catalog.providers().map(async (provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description ?? '',
        setupHint: provider.setupHint ?? '',
        configured: (await providerRuntime.credential(provider)) !== undefined,
        authMode: provider.credentialResolver === 'forge-managed' ? 'api-key' as const
          : provider.credentialResolver ? 'native' as const : 'none' as const,
        protocols: (provider.protocols ?? []).map((capability) => capability.protocol),
        models: provider.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.taskOnly === undefined ? {} : { taskOnly: model.taskOnly }),
        })),
      }))),
    }),
    providerConfigure: async ({ providerId, key }) => {
      const provider = catalog.provider(providerId)
      if (!provider) throw new Error(`unknown provider: ${providerId}`)
      await providerRuntime.configureApiKey(provider, key)
      return { ok: true as const }
    },
    clientConfiguration: {
      snapshot: () => clientConfigurationService.snapshot(),
      plan: ({ clientId, selection }) => clientConfigurationService.plan(clientId, selection),
      apply: ({ plan }) => clientConfigurationService.apply(plan),
      planRestore: ({ clientId }) => clientConfigurationService.planRestore(clientId),
      restore: ({ plan }) => clientConfigurationService.restore(plan),
    },
    shutdown: async (reason) => {
      if (options.onShutdownRequest) {
        await options.onShutdownRequest(reason)
        return
      }
      await stopFromShutdownRequest?.(reason)
    },
  })

  // Begin idempotent taskgraph startup reconciliation exactly once before any
  // IPC/HTTP/MCP handler or transport is exposed. Every persisted actionable
  // graph (running, cancel_requested, paused with a live node, or an
  // unconverged cancel-policy failure) recovers here instead of lazily on a
  // later graph RPC. Recovery errors stay isolated per graph and never create
  // a second service instance or a background timer.
  await taskgraphService.reconcileStartup()

  await messageService.drainPendingDeliveries()

  const mcpServer = new ForemanMcpServer({
    workspaceRoot: config.workspaceRoot,
    operations,
    rpcRouter,
  })
  mcpServer.injectConnections(connections)
  await mcpServer.initializeRuntime()
  const httpServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname.startsWith('/gateway/')) {
      if (!gatewayRequestAuthorized(request, gatewayToken)) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid Wrenyard Gateway token' } }))
        return
      }
      void gateway.handle(request, response).then((handled) => {
        if (!handled && !response.headersSent) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, error: 'not_found' }))
        }
      }).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, error: 'gateway_error' }))
        } else {
          response.destroy()
        }
      })
      return
    }
    if (pathname === '/mcp') {
      void handleMcpHttpRequest(request, response, mcpServer, {
        deliveryConfig,
        connections,
        contextFromRequest: messageMcpContextFromRequest,
      })
      return
    }
    if (pathname === '/message/deliver' && request.method === 'POST') {
      void handleMessageDeliveryRequest(request, response, deliveryHub, deliveryConfig, connections)
      return
    }
    if (pathname === '/mcp/channel/events' && request.method === 'GET') {
      void handleChannelEvents(request, response, connections, deliveryConfig, activeSseStreams)
      return
    }
    // Channel connections endpoints (D4)
    if (pathname === '/channel/connections' && request.method === 'GET') {
      void handleChannelConnections(request, response, connections, deliveryConfig?.auth)
      return
    }
    const channelMessageMatch = /^\/channel\/connections\/([^/]+)\/message$/.exec(pathname)
    if (channelMessageMatch && request.method === 'POST') {
      void handleChannelConnectionMessage(request, response, channelMessageMatch[1], connections, deliveryConfig?.auth)
      return
    }
    // REST compatibility endpoints and /api/v1/* use the daemon-owned RpcRouter.
    if (handleRestApiRequest(request, response, { rpcRouter, startedAt })) {
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'not_found' }))
  })
  // Bind with single-instance defense — retry up to 5 times on EADDRINUSE
  let bound = false
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(config.service.port, config.service.host, () => {
          httpServer.off('error', reject)
          resolve()
        })
      })
      bound = true
      break
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        await resolvePortConflict(config.service.port)
        // resolvePortConflict exits if a healthy instance exists;
        // if it returns, the zombie was killed and port should be free — retry
        continue
      }
      throw error
    }
  }
  if (!bound) {
    // All retries exhausted — resolvePortConflict returned but port never freed
    throw new Error(`failed to bind port ${config.service.port} after clearing conflict`)
  }
  const boundAddress = httpServer.address()
  boundPort = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : config.service.port
  const gatewayConnection = {
    ...await gateway.connection(gatewayOrigin(config.service.host, boundPort)),
    token: gatewayToken,
  }
  restoreGatewayEnvironment()
  restoreGatewayEnvironment = installGatewayEnvironment(gatewayConnection, dispatchPlans)
  const ipcPath = resolveForemanServiceIpcPath({
    port: boundPort,
    path: config.service.ipc?.path,
  })
  activeIpcPath = ipcPath
  await ensureGatewayCredentialHelper(credentialHelperPath, activeIpcPath)
  let ipcServer: IpcServer | undefined
  try {
    ipcServer = await createIpcServer({
      path: ipcPath,
      onMessage: (message) => rpcRouter.handleMessage(message, { transport: 'ipc' }),
    })
  } catch (error) {
    await cleanupFailedDaemonResources({
      activeSseStreams,
      connections,
      httpServer,
      ipcServer,
      mcpServer,
      gateway,
      restoreGatewayEnvironment,
    })
    throw error
  }
  if (!ipcServer) throw new Error('failed to start IPC server')
  let stopped = false
  const runningIpcServer = ipcServer
  const runningDaemon: RunningForemanDaemon = {
    db: runtime.db,
    repoWriteLocks: runtime.repoWriteLocks,
    supervisor: runtime.supervisor,
    runner: runtime.runner,
    dispatchControl: runtime.dispatchControl,
    mcpServer,
    gateway,
    httpServer,
    ipcPath,
    ipcServer: runningIpcServer,
    stop: async () => {
      if (stopped) return
      stopped = true
      let ipcError: unknown
      let supervisorError: unknown
      const httpClose = closeHttpServerIfListening(httpServer)
      await gateway.close()
      restoreGatewayEnvironment()
      try {
        await runningIpcServer.close()
      } catch (error) {
        ipcError = error
        writeDaemonLog('warn', 'IPC server shutdown failed', error)
      }
      try {
        await runtime.supervisor.shutdown()
      } catch (error) {
        supervisorError = error
        writeDaemonLog('warn', 'supervisor shutdown failed', error)
      }

      try {
        mcpServer.close()
        // Close all active channel SSE streams and clear timers (Fix 2)
        closeActiveSseStreams(activeSseStreams, connections)
        await httpClose
      } finally {
        releaseDaemonDb()
      }

      if (ipcError) throw ipcError
      if (supervisorError) throw supervisorError
    },
  }
  stopFromShutdownRequest = async () => {
    await runningDaemon.stop()
  }
  return runningDaemon
}

interface FailedDaemonResourceCleanupOptions {
  activeSseStreams: Array<{ res: ServerResponse; timer: NodeJS.Timeout; connId: string; conn: McpConnection }>
  connections: Map<string, McpConnection>
  httpServer: Server
  ipcServer?: IpcServer
  mcpServer: ForemanMcpServer
  gateway: ModelGateway
  restoreGatewayEnvironment?: () => void
}

async function cleanupFailedDaemonResources(options: FailedDaemonResourceCleanupOptions): Promise<void> {
  await options.gateway.close()
  options.restoreGatewayEnvironment?.()
  if (options.ipcServer) {
    try {
      await options.ipcServer.close()
    } catch (error) {
      writeDaemonLog('warn', 'IPC server startup cleanup failed', error)
    }
  }

  try {
    options.mcpServer.close()
    closeActiveSseStreams(options.activeSseStreams, options.connections)
    await closeHttpServerIfListening(options.httpServer)
  } catch (error) {
    writeDaemonLog('warn', 'HTTP server startup cleanup failed', error)
  }
}

function closeActiveSseStreams(
  activeSseStreams: Array<{ res: ServerResponse; timer: NodeJS.Timeout; connId: string; conn: McpConnection }>,
  connections: Map<string, McpConnection>,
): void {
  for (const entry of activeSseStreams) {
    clearInterval(entry.timer)
    try {
      connections.delete(entry.connId)
    } catch { /* ignore */ }
    try {
      if (!entry.res.writableEnded) entry.res.end()
    } catch { /* ignore */ }
    try { entry.res.destroy() } catch { /* ignore */ }
  }
  activeSseStreams.length = 0
}

function closeHttpServerIfListening(httpServer: Server): Promise<void> {
  if (!httpServer.listening) return Promise.resolve()

  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function gatewayOrigin(configuredHost: string, port: number): string {
  const host = configuredHost === '0.0.0.0' || configuredHost === '::' ? '127.0.0.1' : configuredHost
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${authority}:${port}`
}

type DaemonGatewayConnection = import('@wrenyard/gateway').GatewayConnection & { token: string }

function installGatewayEnvironment(
  connection: DaemonGatewayConnection,
  dispatchPlans: Readonly<Record<string, import('@wrenyard/catalog').DispatchPlan>>,
): () => void {
  const values: Record<string, string> = {
    WRENYARD_GATEWAY_OPENAI_CHAT_URL: connection.openaiChatBaseUrl,
    WRENYARD_GATEWAY_OPENAI_RESPONSES_URL: connection.openaiResponsesBaseUrl,
    WRENYARD_GATEWAY_ANTHROPIC_URL: connection.anthropicBaseUrl,
    WRENYARD_GATEWAY_TOKEN: connection.token,
    WRENYARD_GATEWAY_MODELS_JSON: JSON.stringify(connection.models),
    WRENYARD_DISPATCH_PLANS_JSON: JSON.stringify(dispatchPlans),
  }
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function gatewayRequestAuthorized(request: IncomingMessage, expectedToken: string): boolean {
  const remoteAddress = request.socket.remoteAddress ?? ''
  if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') return false
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const provided = pathname.startsWith('/gateway/anthropic/')
    ? request.headers['x-api-key']
    : request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice('Bearer '.length)
      : undefined
  if (typeof provided !== 'string') return false
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expectedToken)
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)
}

interface DaemonRpcRouterOptions {
  startedAt: number
  workspaceRoot: string
  messageService?: MessageService
  operations?: OperationHost
  shutdown?: (reason: string) => void | Promise<void>
  dispatchControl?: DispatchControl
  taskgraphService?: TaskGraphService
  workspaceDocService?: WorkspaceDocService
  gatewayConnection?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['gatewayConnection']
  providerList?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['providerList']
  providerConfigure?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['providerConfigure']
  clientConfiguration?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['clientConfiguration']
}

function createDaemonRpcRouter(options: DaemonRpcRouterOptions): RpcRouter {
  const router = new RpcRouter()
  registerCoreHandlers(router, { ...options, messageService: options.messageService, workspaceDocService: options.workspaceDocService })
  return router
}

interface ForemanDaemonRuntime {
  db: ForemanDatabase
  repoWriteLocks: RepoWriteLocks
  supervisor: AgentExecutionSupervisor
  runner: TaskWorkflowRunner
  dispatchControl: DispatchControl
}

async function bootstrapForemanDaemonRuntime(dispatchControl: DispatchControl): Promise<ForemanDaemonRuntime> {
  const db = initDb(process.env.FOREMAN_DB_PATH)
  retainDaemonDb()

  try {
    new WorkflowRunStore(db).markAllNonTerminalCancelled(new Date().toISOString())
    const repoWriteLocks = new RepoWriteLocks()
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      logger: createDaemonSupervisorLogger(),
    })
    const runner = new TaskWorkflowRunner({
      db,
      agentExecutionHost: supervisor,
      logger: createDaemonSupervisorLogger(),
      admissionControl: () => dispatchControl.assertAccepting(),
    })
    await supervisor.markInterruptedOnStartup()
    setAgentExecutionSupervisor(supervisor)
    setTaskWorkflowRunner(runner)

    return { db, repoWriteLocks, supervisor, runner, dispatchControl }
  } catch (error) {
    releaseDaemonDb()
    throw error
  }
}

async function cleanupFailedDaemonStart(runtime: ForemanDaemonRuntime): Promise<void> {
  runtime.supervisor.stopAcceptingNew()
  try {
    await runtime.supervisor.shutdown()
  } catch (error) {
    writeDaemonLog('warn', 'supervisor startup cleanup failed', error)
  } finally {
    releaseDaemonDb()
  }
}

// Internal fallback error code used when a startup failure carries no
// platform/application error code of its own.
const DAEMON_START_FAILED_CODE = 'daemon_start_failed'

function daemonStartFailureErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return DAEMON_START_FAILED_CODE
}

/**
 * Records a startup failure as a recoverable planned_restart failure when a
 * durable plan is active. The admission mode is preserved as planned_restart
 * (so admission stays closed) while phase/recovery metadata is recorded. The
 * pre-existing plan fields (old_head, new_head, coordinator_pid,
 * config_path, checkout_path) are merged rather than erased; the daemon's own
 * config path is added only when the plan has none.
 */
function failActivePlannedRestartOnStartup(
  store: PlannedRestartStore,
  error: unknown,
  configPath: string | undefined,
): void {
  const snapshot = store.snapshot()
  if (snapshot.mode !== 'planned_restart' || !snapshot.plan) return
  const plan = snapshot.plan
  store.failPlan(plan.operation_id, {
    error_code: daemonStartFailureErrorCode(error),
    error_message: error instanceof Error ? error.message : String(error),
    failed_at: new Date().toISOString(),
    old_head: plan.old_head ?? null,
    new_head: plan.new_head ?? null,
    coordinator_pid: plan.coordinator_pid ?? null,
    config_path: plan.config_path ?? configPath ?? null,
    checkout_path: plan.checkout_path ?? null,
  })
}

function retainDaemonDb(): void {
  activeDaemonDbUsers += 1
}

function releaseDaemonDb(): void {
  if (activeDaemonDbUsers > 0) activeDaemonDbUsers -= 1
  if (activeDaemonDbUsers === 0) closeDb()
}

function createDaemonSupervisorLogger(): SupervisorLogger {
  return {
    debug(message, meta) {
      if (process.env.FOREMAN_DEBUG === '1') writeDaemonLog('debug', message, meta)
    },
    info: (message, meta) => writeDaemonLog('info', message, meta),
    warn: (message, meta) => writeDaemonLog('warn', message, meta),
    error: (message, meta) => writeDaemonLog('error', message, meta),
  }
}

function writeDaemonLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const suffix = meta === undefined ? '' : ` ${formatLogMeta(meta)}`
  process.stderr.write(`[foreman-daemon] ${level}: ${message}${suffix}\n`)
}

function formatLogMeta(meta: unknown): string {
  if (meta instanceof Error) return meta.stack ?? meta.message
  try {
    return JSON.stringify(meta) ?? String(meta)
  } catch {
    return String(meta)
  }
}

interface LineMcpServer {
  handleLine(line: string, context?: unknown): Promise<unknown | null>
}

// handleMcpHttpRequest handles one-shot HTTP POST MCP requests.
// These are NOT channel-capable — only long-lived transports (stdio,
// persistent SSE/stream) may receive cc-channel deliveries. Therefore
// no McpConnection is registered here.
async function handleMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  server: LineMcpServer,
  opts?: {
    deliveryConfig?: MessageDeliveryRegistryConfig
    connections?: Map<string, McpConnection>
    contextFromRequest?: (request: IncomingMessage) => unknown
  },
): Promise<void> {
  setMcpCorsHeaders(response, request.headers.origin)
  response.setHeader('Content-Type', 'text/event-stream')
  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }
  if (request.method?.toUpperCase() !== 'POST') {
    response.statusCode = 405
    response.setHeader('Allow', 'POST')
    response.end()
    return
  }
  const connId = extractMcpConnId(request)

  // BLOCKER (a): When channel connection header is present, enforce auth
  // BEFORE honoring it — same checkAuth() policy as message delivery.
  if (connId && opts) {
    if (!checkAuth(request, response, opts.deliveryConfig?.auth)) return

    // BLOCKER (b): Reject unknown or non-channel connIds — generic 403
    const connections = opts.connections
    if (!connections || !connections.has(connId)) {
      sendJson(response, 403, { ok: false, error: 'forbidden', message: 'access denied' })
      return
    }

    // BLOCKER (c): X-Foreman-Channel-Token is REQUIRED when connId present.
    // Validate connId + nonce pair with timing-safe comparison. Missing or
    // wrong token -> 403, no exceptions.
    const nonceHeader = request.headers['x-foreman-channel-token']
    if (typeof nonceHeader !== 'string' || !nonceHeader.trim()) {
      sendJson(response, 403, { ok: false, error: 'forbidden', message: 'access denied' })
      return
    }
    const conn = connections.get(connId)!
    const storedNonce = (conn as McpConnection & { _nonce?: string })._nonce
    if (!storedNonce) {
      sendJson(response, 403, { ok: false, error: 'forbidden', message: 'access denied' })
      return
    }
    const expectedBuf = Buffer.from(storedNonce)
    const providedBuf = Buffer.from(nonceHeader.trim())
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      sendJson(response, 403, { ok: false, error: 'forbidden', message: 'access denied' })
      return
    }
  }

  const body = await readRequestBody(request)
  const result = await server.handleLine(body, mcpRequestContext(connId, opts?.contextFromRequest?.(request)))
  if (!result) {
    response.statusCode = 202
    response.removeHeader('Content-Type')
    response.end()
    return
  }
  response.write(`data: ${JSON.stringify(result)}\n\n`)
  response.end()
}

function mcpRequestContext(connId: string | undefined, requestContext: unknown): unknown {
  const transportContext = { transport: 'mcp' }
  if (!connId) {
    if (!requestContext || typeof requestContext !== 'object' || Array.isArray(requestContext)) return transportContext
    return {
      ...(requestContext as Record<string, unknown>),
      ...transportContext,
    }
  }
  if (!requestContext || typeof requestContext !== 'object' || Array.isArray(requestContext)) {
    return { ...transportContext, connectingId: connId }
  }
  return {
    ...(requestContext as Record<string, unknown>),
    ...transportContext,
    connectingId: connId,
  }
}

function messageMcpContextFromRequest(request: IncomingMessage): unknown {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  const sender = optionalSearchParam(parsed, 'sender') ?? optionalSearchParam(parsed, 'client') ?? optionalSearchParam(parsed, 'from')
  if (!sender) return undefined
  return {
    sender: {
      role: sender,
    },
  }
}

function optionalSearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim()
  return value || undefined
}

function setMcpCorsHeaders(response: ServerResponse, origin?: string): void {
  if (origin && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  } else {
    response.setHeader('Access-Control-Allow-Origin', 'http://localhost')
  }
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'content-type')
  response.setHeader('Cache-Control', 'no-cache')
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    let body = ''
    request.setEncoding('utf-8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => resolveBody(body))
    request.on('error', reject)
  })
}

// readRequestBodyBounded reads the request body up to maxBytes, aborting
// immediately (destroying the request and responding 413) if exceeded.
// Returns the body string; rejects with the sent status if the cap is hit.
function readRequestBodyBounded(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
  limitError?: { error: string; message: string },
): Promise<string> {
  const cap = maxBytes
  return new Promise<string>((resolveBody, reject) => {
    let body = ''
    let overCap = false
    request.setEncoding('utf-8')
    request.on('data', (chunk) => {
      if (overCap) return
      body += chunk
      if (Buffer.byteLength(body, 'utf8') > cap) {
        overCap = true
        request.destroy()
        sendJson(response, 413, limitError ?? { error: 'body too large', message: 'request body exceeds size limit' })
        reject(new Error('body too large'))
      }
    })
    request.on('end', () => {
      if (!overCap) {
        resolveBody(body)
      }
    })
    request.on('error', (err) => {
      if (!overCap) {
        reject(err)
      }
    })
  })
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function extractMcpConnId(request: IncomingMessage): string | undefined {
  const raw = request.headers['x-foreman-channel-connection']
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return undefined
}

export function normalizeHops(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  if (value < 0) return undefined
  return Math.floor(value)
}

// checkAuth validates loopback or Bearer token auth for message/channel endpoints.
// Returns true if authorized; returns false after sending error response.
export function checkAuth(
  request: IncomingMessage,
  response: ServerResponse,
  authCfg: MessageDeliveryRegistryConfig['auth'] | undefined,
): boolean {
  if (authCfg) {
    const expectedToken = resolveToken(authCfg)
    if (!expectedToken) {
      sendJson(response, 500, { error: 'message delivery auth misconfigured' })
      return false
    }
    const authHeader = request.headers['authorization'] ?? ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    // Timing-safe compare: length check first (fast reject), then constant-time.
    const expectedBuf = Buffer.from(expectedToken)
    const providedBuf = Buffer.from(bearer)
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      sendJson(response, 401, { ok: false, error: 'unauthorized', message: 'invalid or missing bearer token' })
      return false
    }
    return true
  }
  // No auth configured: loopback only
  const remoteAddress = request.socket.remoteAddress ?? ''
  const isLoopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  if (!isLoopback) {
    sendJson(response, 403, { ok: false, error: 'forbidden', message: 'message delivery endpoint restricted to loopback without auth configuration' })
    return false
  }
  return true
}

export async function handleMessageDeliveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hub: MessageDeliveryHub | null,
  deliveryConfig: MessageDeliveryRegistryConfig | undefined,
  connections: Map<string, McpConnection>,
): Promise<void> {
  if (!checkAuth(request, response, deliveryConfig?.auth)) return

  if (!hub) {
    sendJson(response, 503, { ok: false, error: 'unavailable', message: 'message delivery hub not configured' })
    return
  }

  try {
    const body = await readRequestBody(request)
    const parsed = JSON.parse(body) as Record<string, unknown>

    // Support two compatibility shapes: {event, channel?/channels?} (full event)
    // or {message, ...} (flat). Internally these names are event-delivery route ids.
    let event: MessageEnvelope
    let emitOptions: { channels?: string[] } = {}

    if (parsed.event && typeof parsed.event === 'object') {
      // Full event shape
      const rawEvent = parsed.event as Record<string, unknown>
      event = {
        id: (rawEvent.id as string) ?? `http_${Date.now()}`,
        kind: (rawEvent.kind as MessageEnvelope['kind']) ?? 'message',
        severity: (['info', 'success', 'warning', 'error'].includes(rawEvent.severity as string) ? rawEvent.severity : 'info') as MessageEnvelope['severity'],
        title: (rawEvent.title as string) ?? 'HTTP Message',
        body: (rawEvent.body as string) ?? '',
        refs: (rawEvent.refs as MessageEnvelope['refs']) ?? {},
        ts: (rawEvent.ts as string) ?? new Date().toISOString(),
        ...(rawEvent.media ? { media: rawEvent.media as string } : {}),
        ...(rawEvent.origin ? { origin: rawEvent.origin as MessageEnvelope['origin'] } : {}),
      }
      if (rawEvent.hops !== undefined) {
        const normalizedHops = normalizeHops(rawEvent.hops)
        if (normalizedHops === undefined) {
          sendJson(response, 400, { error: 'invalid hops' })
          return
        }
        event = { ...event, hops: normalizedHops }
      }
      if (Array.isArray(parsed.channels)) {
        emitOptions = { ...emitOptions, channels: parsed.channels as string[] }
      } else if (typeof parsed.channel === 'string') {
        emitOptions = { ...emitOptions, channels: [parsed.channel as string] }
      }
    } else {
      // Flat message shape
      const message = (parsed.message as string) ?? JSON.stringify(parsed)
      const title = (parsed.title as string) ?? 'Foreman Message'
      const severity = optionalMessageSeverity(parsed.severity)
      const channels = optionalMessageChannels(parsed.channels ?? parsed.channel)
      const origin = parsed.origin as MessageEnvelope['origin'] | undefined
      let hops: number | undefined
      if (parsed.hops !== undefined) {
        const normalized = normalizeHops(parsed.hops)
        if (normalized === undefined) {
          sendJson(response, 400, { error: 'invalid hops' })
          return
        }
        hops = normalized
      }
      event = {
        id: `http_${Date.now()}`,
        kind: 'message',
        severity,
        title,
        body: message,
        refs: {},
        ts: new Date().toISOString(),
        ...(origin ? { origin } : {}),
        ...(hops !== undefined ? { hops } : {}),
      }
      if (channels) {
        emitOptions = { ...emitOptions, channels }
      }
    }

    // Attach originating connection info for session stamp (D5)
    const connId = extractMcpConnId(request)
    if (connId) {
      const conn = connections.get(connId)
      if (conn) {
        event.refs = {
          ...event.refs,
          originSession: {
            id: conn.id,
            ...(conn.label ? { label: conn.label } : {}),
            ...(conn.host ? { host: conn.host } : {}),
          },
        }
      }
    }

    // Anti-loop: if hops >= 1, refuse remote event-delivery routes.
    const hops = event.hops ?? 0
    if (hops >= 1 && deliveryConfig) {
      const { resolveDeliveryRoutes } = await import('../message/delivery/router.mts')
      const resolved = resolveDeliveryRoutes(event, emitOptions.channels, deliveryConfig)

      const nonRemoteRoutes: string[] = []
      const remoteRoutes: string[] = []
      for (const name of resolved.routes) {
        if (deliveryConfig.channels[name]?.backend === 'remote') {
          remoteRoutes.push(name)
        } else {
          nonRemoteRoutes.push(name)
        }
      }

      const nonRemoteDeliveries: MessageDeliveryResult[] = nonRemoteRoutes.length > 0
        ? await hub.emit(event, { channels: nonRemoteRoutes })
        : []

      const hopLimitDeliveries: MessageDeliveryResult[] = remoteRoutes.map((routeId) => ({
        channel: routeId,
        backend: 'remote',
        ok: false,
        error: 'hop-limit',
      }))

      const allDeliveries = [...nonRemoteDeliveries, ...hopLimitDeliveries]
      sendJson(response, 200, { ok: true, deliveries: allDeliveries })
      return
    }

    const results = await hub.emit(event, emitOptions)
    sendJson(response, 200, { ok: true, deliveries: results })
  } catch (error) {
    sendJson(response, 400, { ok: false, error: (error as Error).message })
  }
}

// handleChannelEvents is the daemon-side SSE subscription endpoint for cc-channel
// bridges. It registers a long-lived connection in the shared connections map,
// accepts metadata via X-Foreman-Channel-Meta, and removes the entry on close.
export async function handleChannelEvents(
  request: IncomingMessage,
  response: ServerResponse,
  connections: Map<string, McpConnection>,
  deliveryConfig: MessageDeliveryRegistryConfig | undefined,
  activeSseStreams?: Array<{ res: ServerResponse; timer: NodeJS.Timeout; connId: string; conn: McpConnection }>,
): Promise<void> {
// Auth check — same policy as message delivery.
  if (!checkAuth(request, response, deliveryConfig?.auth)) return

  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const rawConnId = url.searchParams.get('connId')
  const connId = rawConnId?.trim()
  if (!connId) {
    sendJson(response, 400, { error: 'missing connId query parameter' })
    return
  }

  // Collision: if an existing connection has the same connId, close the old
  // stream and replace it. This lets a reconnecting bridge immediately take over.
  const existing = connections.get(connId)
  if (existing) {
    const close = (existing as unknown as Record<string, unknown>)._close
    if (typeof close === 'function') {
      try { close() } catch { /* best effort */ }
    }
  }

  // Parse metadata from X-Foreman-Channel-Meta header
  // Fix 4: strict meta validation — reject oversized or invalid metadata
  const metaHeader = request.headers['x-foreman-channel-meta']
  let meta: Record<string, unknown> = {}
  if (typeof metaHeader === 'string') {
    // Total raw header ≤ 2KB
    if (Buffer.byteLength(metaHeader, 'utf8') > 2048) {
      sendJson(response, 400, { error: 'metadata header exceeds 2KB limit' })
      return
    }
    try {
      const parsedMeta = JSON.parse(metaHeader) as unknown
      if (!parsedMeta || typeof parsedMeta !== 'object' || Array.isArray(parsedMeta)) {
        sendJson(response, 400, { error: 'metadata must be a JSON object' })
        return
      }
      meta = parsedMeta as Record<string, unknown>
    } catch {
      sendJson(response, 400, { error: 'metadata header is not valid JSON' })
      return
    }

    // Per-field caps: label/host/clientName/clientVersion ≤ 128, cwd ≤ 512
    if (typeof meta.label === 'string' && Buffer.byteLength(meta.label, 'utf8') > 128) {
      sendJson(response, 400, { error: 'metadata field label exceeds 128 bytes' })
      return
    }
    if (typeof meta.host === 'string' && Buffer.byteLength(meta.host, 'utf8') > 128) {
      sendJson(response, 400, { error: 'metadata field host exceeds 128 bytes' })
      return
    }
    if (typeof meta.clientName === 'string' && Buffer.byteLength(meta.clientName, 'utf8') > 128) {
      sendJson(response, 400, { error: 'metadata field clientName exceeds 128 bytes' })
      return
    }
    if (typeof meta.clientVersion === 'string' && Buffer.byteLength(meta.clientVersion, 'utf8') > 128) {
      sendJson(response, 400, { error: 'metadata field clientVersion exceeds 128 bytes' })
      return
    }
    if (typeof meta.cwd === 'string' && Buffer.byteLength(meta.cwd, 'utf8') > 512) {
      sendJson(response, 400, { error: 'metadata field cwd exceeds 512 bytes' })
      return
    }
    // pid must be a positive safe integer
    if (meta.pid !== undefined && meta.pid !== null) {
      if (typeof meta.pid !== 'number' || !Number.isInteger(meta.pid) || meta.pid < 1 || meta.pid > Number.MAX_SAFE_INTEGER) {
        sendJson(response, 400, { error: 'metadata field pid must be a positive safe integer' })
        return
      }
    }
    // startedAt must parse as ISO date
    if (typeof meta.startedAt === 'string') {
      const parsed = new Date(meta.startedAt)
      if (isNaN(parsed.getTime()) || parsed.toISOString() !== new Date(meta.startedAt).toISOString()) {
        // The toISOString comparison catches non-ISO strings that Date can still parse
        sendJson(response, 400, { error: 'metadata field startedAt must be a valid ISO 8601 date' })
        return
      }
    }
    // Unknown keys are silently dropped (existing behavior)
  }

  // SSE response setup
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write('\n')

  // Generate per-connection proxy nonce (BLOCKER 1c)
  const nonce = randomBytes(16).toString('hex')

  // Create the McpConnection with SSE-based sendNotification
  const conn = {
    id: connId,
    channelCapable: true,
    _nonce: nonce,
    sendNotification(message: { method: string; params: Record<string, unknown> }) {
      try {
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: message.method, params: message.params })}\n\n`)
      } catch {
        // stream likely closed; ignore write errors
      }
    },
    _close: () => {
      if (!response.writableEnded) response.end()
    },
    label: typeof meta.label === 'string' ? meta.label : undefined,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
    pid: typeof meta.pid === 'number' ? meta.pid : undefined,
    startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : undefined,
    clientName: typeof meta.clientName === 'string' ? meta.clientName : undefined,
    clientVersion: typeof meta.clientVersion === 'string' ? meta.clientVersion : undefined,
    host: typeof meta.host === 'string' ? meta.host : undefined,
  } as unknown as McpConnection

  connections.set(connId, conn)

  // Send nonce as the FIRST SSE event — internal control event, NOT forwarded to stdout by bridge
  try {
    response.write(`data: ${JSON.stringify({ method: 'channel/registered', params: { nonce } })}\n\n`)
  } catch {
    // stream may already be closed; ignore
  }

  // Heartbeat: SSE comment ping every ~25s to keep intermediaries alive
  const heartbeat = setInterval(() => {
    if (response.writableEnded) return
    response.write(': heartbeat\n\n')
  }, 25_000)

  // Track this active SSE stream for clean shutdown (Fix 2)
  const sseEntry = { res: response, timer: heartbeat, connId, conn }
  if (activeSseStreams) activeSseStreams.push(sseEntry)

  // Cleanup on close or error
  const cleanup = () => {
    clearInterval(heartbeat)
    if (activeSseStreams) {
      const idx = activeSseStreams.indexOf(sseEntry)
      if (idx >= 0) activeSseStreams.splice(idx, 1)
    }
    if (connections.get(connId) === conn) {
      connections.delete(connId)
    }
    if (!response.writableEnded) response.end()
  }

  request.on('close', cleanup)
  request.on('error', cleanup)
  response.on('close', cleanup)
}

// handleChannelConnections returns a JSON array of channel-capable connections.
export async function handleChannelConnections(
  request: IncomingMessage,
  response: ServerResponse,
  connections: Map<string, McpConnection>,
  authCfg: MessageDeliveryRegistryConfig['auth'] | undefined,
): Promise<void> {
  if (!checkAuth(request, response, authCfg)) return

  const list: Array<{
    id: string
    label: string
    cwd: string
    pid: number
    startedAt: string
    host: string
    clientName: string
    clientVersion: string
  }> = []

  for (const conn of connections.values()) {
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

  sendJson(response, 200, list)
}

// handleChannelConnectionMessage delivers a message to a specific channel connection.
export async function handleChannelConnectionMessage(
  request: IncomingMessage,
  response: ServerResponse,
  connId: string,
  connections: Map<string, McpConnection>,
  authCfg: MessageDeliveryRegistryConfig['auth'] | undefined,
): Promise<void> {
  if (!checkAuth(request, response, authCfg)) return

  // Read and validate body with bounded reader (Fix 3 — aborts on cap)
  let rawBody: string
  try {
    rawBody = await readRequestBodyBounded(request, response, 16 * 1024, {
      error: 'body too large',
      message: 'message body exceeds 16KB limit',
    })
  } catch {
    // readRequestBodyBounded already sent 413; nothing further to do
    return
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
    return
  }

  const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
  if (!message) {
    sendJson(response, 400, { ok: false, error: 'missing required field: message' })
    return
  }

  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : 'message'
  const severityRaw = typeof parsed.severity === 'string' ? parsed.severity.trim() : 'info'
  const severity = (['info', 'success', 'warning', 'error'].includes(severityRaw) ? severityRaw : 'info') as MessageEnvelope['severity']

  const event: MessageEnvelope = {
    id: `chan_${randomBytes(6).toString('hex')}`,
    kind: 'message',
    severity,
    title,
    body: message,
    refs: {},
    ts: new Date().toISOString(),
  }

  const delivery = deliverToConnection({ connections }, connId, event)

  if (delivery.ok) {
    sendJson(response, 200, delivery)
  } else if (delivery.error === 'no-such-connection') {
    sendJson(response, 404, delivery)
  } else {
    sendJson(response, 500, delivery)
  }
}

function optionalMessageSeverity(value: unknown): MessageEnvelope['severity'] {
  const valid = ['info', 'success', 'warning', 'error']
  if (typeof value === 'string' && valid.includes(value)) return value as MessageEnvelope['severity']
  return 'info'
}

function optionalMessageChannels(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }
  return undefined
}
