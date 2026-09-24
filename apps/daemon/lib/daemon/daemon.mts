import { timingSafeEqual, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb, query as dbQuery } from '../db/connection.mts'
import { dropTaskRunTelemetryRetiredColumns } from '../db/schema.mts'
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
import { createIpcServer, resolveForemanServiceIpcPath, type IpcServer } from '../control/ipc-server.mts'
import { registerSessionHandlers } from '../server/handlers/session.mts'
import { INVALID_PARAMS, ProtocolError } from '../protocol/errors.mts'
import { TaskService } from '../core/task/service.mts'
import { createSessionService, type SessionService } from '@wrenyard/session'
import { resolveDesktopStateRoot } from '../config/desktop-state.mts'
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
import { TaskSettingsService } from './services/task-settings-service.mts'
import { AutoRoutingQuotaSnapshotService } from './services/auto-routing-snapshot-service.mts'
import {
  evaluateNativeRouteReadiness,
  projectModelAvailability,
  type NativeProviderReadinessSnapshot,
} from './execution/native-provider-readiness.mts'
import { createAgentClients, CodeBuddyClient, type AgentClient, type NativeClientReadiness } from '@wrenyard/clients'
import { ExecService } from '@wrenyard/exec'
import { ProviderService } from '@wrenyard/provider-service'
import { createExecFeatureRegistry } from './execution/exec-features.mts'
import { RuntimeAliasService } from './services/runtime-alias-service.mts'
import RuntimeAliasStore from '../runtime-aliases/store.mts'
import { ForemanConfigManager } from '../config/manager.mts'
import { getForemanEventBus } from '../events/event-bus.mts'
import { readLocalSpeedSamples } from '../events/tps.mts'
import type { ForemanEvent, ForemanEventKind, ForemanEventSeverity } from '../events/event-types.mts'
import { MessageService, type ExternalDeliveryPort } from '../message/message-service.mts'
import { WorkspaceDocService } from './services/workspace-doc-service.mts'
import { createModelGateway, type ModelGateway } from '@wrenyard/gateway'
import { deriveTaskDispatchPlans, createBuiltinCatalog, createBuiltinProviderRuntime, createCodeBuddy } from '@wrenyard/providers'
import { createTaskDispatchResolver, type TaskDispatchResolver } from '../core/task/dispatch-resolver.mts'
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
  /** Deterministic daemon-side task dispatch resolver. Supplies exact constrained
   *  plans to the execution kernel; it performs no service lifecycle mutation. */
  taskDispatchResolver: TaskDispatchResolver
  /** Records the request, closes admission, and resolves shutdownRequested. Never drains or stops. */
  requestShutdown(reason: string, force?: boolean): void
  /** Resolves once any exit entry (RPC, signal, parent message) requested shutdown. */
  readonly shutdownRequested: Promise<void>
  /** Waits for admitted work to finish. An explicit force skips the wait. Never stops the daemon. */
  drain(): Promise<void>
  /** Idempotent close; a second call never restarts cleanup, even after a failed close. */
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

/** Payload of the named startup notification, delivered after a successful start. */
export interface ForemanDaemonStartedInfo {
  /** IPC endpoint the daemon is serving once start() has succeeded. */
  ipcPath: string
}

export interface ForemanDaemonOptions {
  config: ForemanServiceConfig
  configPath?: string
  deps?: ForemanDaemonDeps
  /**
   * Named startup notification invoked once after a successful start, before
   * run() awaits the shutdown request. The bootstrap uses it for the ready logs
   * and the parent-process 'ready' message instead of calling start() again.
   */
  onStarted?: (info: ForemanDaemonStartedInfo) => void
}

/**
 * Concrete resources assembled by one successful start(). Pure data plus the
 * handles the drain and close steps operate on; it holds no lifecycle behavior
 * of its own, so a single ForemanDaemon instance stays the only lifecycle owner.
 */
interface ForemanDaemonResources {
  runtime: ForemanDaemonRuntime
  mcpServer: ForemanMcpServer
  httpServer: Server
  ipcPath: string
  ipcServer: IpcServer
  gateway: ModelGateway
  sessionService: SessionService
  rpcRouter: RpcRouter
  activeSseStreams: Array<{ res: ServerResponse; timer: NodeJS.Timeout; connId: string; conn: McpConnection }>
  connections: Map<string, McpConnection>
  restoreGatewayEnvironment: () => void
}

/**
 * The single daemon instance and the only lifecycle owner. It holds the exit
 * request, the startup latch, the admitted-work drain, the created resources and
 * the one cached close promise. run() is the only lifecycle flow; a shutdown
 * request records itself on this instance at any time — including during
 * startup — and returns without waiting for the process to exit.
 */
export class ForemanDaemon implements RunningForemanDaemon {
  private readonly config: ForemanServiceConfig
  private readonly configPath: string | undefined
  private readonly deps: ForemanDaemonDeps
  private readonly onStarted: ((info: ForemanDaemonStartedInfo) => void) | undefined

  private resources: ForemanDaemonResources | undefined
  private control: DispatchControl | undefined

  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private runPromise: Promise<number> | undefined

  private shutdown = false
  private shutdownForce = false
  private shutdownRequestedResolve: (() => void) | undefined
  private readonly shutdownRequestedPromise: Promise<void>
  private drainPromise: Promise<void> | undefined
  // Wakes the 200ms idle wait the moment an explicit force skips the wait. Reset
  // to undefined once a waiter consumes it so no permanent timer is left behind.
  private drainWakeResolve: (() => void) | undefined
  private drainWaitTimer: NodeJS.Timeout | undefined

  constructor(options: ForemanDaemonOptions) {
    this.config = options.config
    this.configPath = options.configPath
    this.deps = options.deps ?? {}
    this.onStarted = options.onStarted
    this.shutdownRequestedPromise = new Promise<void>((resolve) => {
      this.shutdownRequestedResolve = resolve
    })
  }

  /**
   * Sole sequential daemon flow: start, wait for a shutdown request, drain
   * admitted work, then close. Never runs twice and never rejects; the returned
   * code is the process exit code.
   */
  run(): Promise<number> {
    if (this.runPromise) return this.runPromise
    this.runPromise = (async () => {
      try {
        await this.start()
      } catch (error) {
        writeDaemonLog('error', 'daemon failed to start', error)
        await this.close().catch((closeError: unknown) => {
          writeDaemonLog('warn', 'daemon cleanup after failed start failed', closeError)
        })
        return 1
      }
      try {
        await this.shutdownRequestedPromise
        // Let the IPC shutdown reply reach its transport before close tears
        // down client sockets. This is one turn, not a shutdown scheduler.
        await new Promise<void>((resolve) => setImmediate(resolve))
        await this.drain()
        await this.close()
        return 0
      } catch (error) {
        writeDaemonLog('error', 'daemon shutdown failed', error)
        await this.close().catch((closeError: unknown) => {
          writeDaemonLog('warn', 'daemon stop after shutdown failure failed', closeError)
        })
        return 1
      }
    })()
    return this.runPromise
  }

  /**
   * Startup latch: one in-flight start is shared so a concurrent caller can
   * never bootstrap a second runtime against the same database/IPC endpoint.
   * A shutdown request received during startup is already recorded on this
   * instance, so bootstrap() only has to close admission once it exists. On
   * success the named startup notification fires once; if it throws the start
   * promise rejects so run() treats it as a failed startup and closes the
   * resources instead of running on with no parent ready signal.
   */
  start(): Promise<void> {
    if (this.resources) return Promise.resolve()
    if (!this.startPromise) {
      this.startPromise = this.bootstrap().then(() => {
        const resources = this.resources
        if (!resources || !this.onStarted) return
        this.onStarted({ ipcPath: resources.ipcPath })
      }).finally(() => {
        this.startPromise = undefined
      })
    }
    return this.startPromise
  }

  private async bootstrap(): Promise<void> {
    // Hydrate the durable admission plan BEFORE any database or runtime
    // bootstrap so a persisted planned_restart mode is in force before HTTP,
    // IPC, MCP, or task/workflow dispatch becomes reachable. Construction
    // already validates the snapshot; re-read it here so a malformed plan can
    // never fail bootstrap open.
    const plannedRestartStore = this.deps.plannedRestartStore ?? new PlannedRestartStore()
    plannedRestartStore.snapshot()
    const control = new DispatchControl(plannedRestartStore)
    this.control = control
    // A shutdown requested before admission existed (a signal during very early
    // startup) closes it as soon as the control does; the request itself was
    // recorded on this instance, not forwarded to a second daemon.
    if (this.shutdown) control.requestShutdown()

    let runtime: ForemanDaemonRuntime | undefined
    try {
      runtime = await bootstrapForemanDaemonRuntime(control)
      this.resources = await createForemanDaemonResources(this.config, runtime, this.deps, {
        configPath: this.configPath,
        requestShutdown: this.requestShutdown,
      })
    } catch (error) {
      if (runtime) {
        // Preserve existing runtime resource cleanup (supervisor shutdown + db
        // release) through the one shared teardown. Intentionally NOT performing
        // db/schema rollback, git rollback, drain waiting, plan completion, or
        // admission restoration. Individual cleanup failures are logged by the
        // teardown; its aggregate is swallowed so a cleanup failure can never
        // replace the original startup error the caller sees.
        await teardownDaemonResources({
          supervisor: runtime.supervisor,
          execService: runtime.execService,
          releaseDb: releaseDaemonDb,
        }).catch(() => {})
      }
      // If a durable plan is active, record the startup failure as a recoverable
      // planned_restart failure; admission stays closed (mode unchanged).
      try {
        failActivePlannedRestartOnStartup(plannedRestartStore, error, this.configPath)
      } catch (recordError) {
        writeDaemonLog('warn', 'daemon startup failure recording failed', recordError)
      }
      throw error
    }
  }

  /**
   * Records the request, closes admission, resolves shutdownRequested and wakes
   * a forced drain. Synchronous and idempotent; the force flag only escalates
   * false -> true. RPC, signals and the parent message all bind straight to it.
   */
  readonly requestShutdown = (reason: string, force = false): void => {
    this.shutdown = true
    this.shutdownForce ||= force
    this.control?.requestShutdown()
    const resolve = this.shutdownRequestedResolve
    this.shutdownRequestedResolve = undefined
    resolve?.()
    // A force escalation must not wait out the current 200ms idle sleep; wake
    // the drain loop so it re-evaluates immediately.
    if (this.shutdownForce) {
      const wake = this.drainWakeResolve
      this.drainWakeResolve = undefined
      if (this.drainWaitTimer) clearTimeout(this.drainWaitTimer)
      this.drainWaitTimer = undefined
      wake?.()
    }
  }

  /** Resolves once any exit entry (RPC, signal, parent message) requested shutdown. */
  get shutdownRequested(): Promise<void> {
    return this.shutdownRequestedPromise
  }

  /**
   * Waits for admitted work to finish by polling the existing authoritative idle
   * checks sequentially every 200ms until the daemon is idle, or an explicit
   * force skips the wait entirely. Never runs twice and never closes the daemon.
   */
  readonly drain = (): Promise<void> => {
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = (async () => {
      const resources = this.resources
      const control = this.control
      if (!resources || !control) return
      while (!this.shutdownForce) {
        const status = control.status()
        // These checks touch different subsystems (sqlite, session snapshot, RPC);
        // run them one at a time so a slow check cannot race a sibling.
        const activeGraphs = dbQuery<{ id: string }>(
          `SELECT DISTINCT r.id FROM taskgraph_run r
           LEFT JOIN taskgraph_node_state n ON n.taskgraph_id = r.id
           WHERE r.state = 'running' OR r.cancel_requested = 1
              OR (r.state = 'paused' AND n.state = 'running')
              OR (r.state = 'paused' AND r.on_node_failure = 'cancel' AND n.state = 'failed')
           LIMIT 1`,
        )
        const conversation = (await resources.sessionService.snapshot()).conversation
        const activeConversation = conversation.status === 'ready' && (
          conversation.selectedRunning
          || conversation.sessions.some((session) => session.running)
          || (conversation.turns?.some((turn) => turn.running) ?? false)
        )
        const idle = status.activeTaskCount === 0
          && status.activeWorkflowCount === 0
          && status.activeExecutionCount === 0
          && activeGraphs.length === 0
          && !activeConversation
          && resources.rpcRouter.activeWorkRequestCount === 0
        if (idle) break
        await new Promise<void>((resolve) => {
          this.drainWakeResolve = resolve
          this.drainWaitTimer = setTimeout(() => {
            if (this.drainWakeResolve === resolve) this.drainWakeResolve = undefined
            this.drainWaitTimer = undefined
            resolve()
          }, 200)
        })
      }
    })()
    return this.drainPromise
  }

  /**
   * Alias of close() for the started-daemon surface: a caller that only starts a
   * daemon (tests) stops it directly instead of running the full run() flow.
   */
  readonly stop = (): Promise<void> => this.close()

  /** Idempotent close; a second call never restarts cleanup, even after a failed close. */
  readonly close = (): Promise<void> => {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      const resources = this.resources
      this.resources = undefined
      if (!resources) return
      await teardownDaemonResources({
        httpServer: resources.httpServer,
        sessionService: resources.sessionService,
        gateway: resources.gateway,
        restoreGatewayEnvironment: resources.restoreGatewayEnvironment,
        ipcServer: resources.ipcServer,
        supervisor: resources.runtime.supervisor,
        execService: resources.runtime.execService,
        mcpServer: resources.mcpServer,
        activeSseStreams: resources.activeSseStreams,
        connections: resources.connections,
        releaseDb: releaseDaemonDb,
      })
    })()
    // Cache the promise even on rejection so a second close() rethrows the same
    // failure instead of restarting cleanup against already-torn-down resources.
    this.closePromise.catch(() => {})
    return this.closePromise
  }

  // Resource getters expose the started daemon's resources directly, so there is
  // no separate lifecycle-bearing wrapper object to keep in sync.
  get db(): ForemanDatabase { return this.requireResources().runtime.db }
  get repoWriteLocks(): RepoWriteLocks { return this.requireResources().runtime.repoWriteLocks }
  get supervisor(): AgentExecutionSupervisor { return this.requireResources().runtime.supervisor }
  get runner(): TaskWorkflowRunner { return this.requireResources().runtime.runner }
  get dispatchControl(): DispatchControl {
    if (!this.control) throw new Error('Foreman daemon has not started')
    return this.control
  }
  get mcpServer(): ForemanMcpServer { return this.requireResources().mcpServer }
  get httpServer(): Server { return this.requireResources().httpServer }
  get ipcPath(): string { return this.requireResources().ipcPath }
  get ipcServer(): IpcServer { return this.requireResources().ipcServer }
  get gateway(): ModelGateway { return this.requireResources().gateway }
  get taskDispatchResolver(): TaskDispatchResolver { return this.requireResources().runtime.taskDispatchResolver }

  private requireResources(): ForemanDaemonResources {
    if (!this.resources) throw new Error('Foreman daemon has not started')
    return this.resources
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

/**
 * Compatibility factory for callers that start a daemon without running the full
 * run() flow (tests and support tooling). It creates the single ForemanDaemon
 * instance, awaits start(), and returns that same instance typed as
 * RunningForemanDaemon — there is no second daemon, no second lifecycle, and no
 * plain view holding bound copies of its methods.
 *
 * Production does not use this: the bootstrap constructs `new ForemanDaemon(...)`
 * and awaits `run()` directly.
 */
export async function startForemanDaemon(
  config: ForemanServiceConfig,
  deps: ForemanDaemonDeps = {},
  options: { configPath?: string } = {},
): Promise<RunningForemanDaemon> {
  const daemon = new ForemanDaemon({ config, configPath: options.configPath, deps })
  await daemon.start()
  return daemon
}

/**
 * Assembles and returns the concrete resources one successful start owns. A
 * named, readable data-returning helper — it holds no lifecycle behavior; the
 * ForemanDaemon instance drives start/drain/close over the returned data. The
 * RPC router binds the instance's real requestShutdown exactly once here.
 */
async function createForemanDaemonResources(
  config: ForemanServiceConfig,
  runtime: ForemanDaemonRuntime,
  deps: ForemanDaemonDeps,
  options: { configPath?: string; requestShutdown: (reason: string, force: boolean) => void },
): Promise<ForemanDaemonResources> {
  const operations: OperationHost = {
    agent: runtime.supervisor,
    runner: runtime.runner,
  }

  // One daemon-owned TaskService backs both the task.run.* RPC surface and the
  // session feature's in-process wait/cancel. A session wait therefore observes
  // exactly the runs this daemon accepted, with no second registry.
  const taskService = new TaskService({ workspaceRoot: config.workspaceRoot, operations })
  // Assigned once the session service exists (which needs the bound IPC path).
  // Provider credential changes refresh the session model projection through
  // this holder; the feature additionally watches provider identity itself.
  const sessionRefresh: { current?: SessionService } = {}

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
  // Catalog / provider runtime / canonical task plans / deterministic resolver
  // are constructed once in bootstrap (see bootstrapForemanDaemonRuntime) and
  // reused here so the gateway, client configuration, RPC surface, and the
  // running daemon all share the identical resolver instance.
  const { catalog, providerRuntime, dispatchPlans, taskDispatchResolver } = runtime
  // One daemon-owned RuntimeAliasStore + RuntimeAliasService back the
  // runtime.alias.* IPC surface. The store resolves the
  // XDG_CONFIG_HOME/~/.config/wrenyard/dispatch/config.json path itself, and no
  // alias target is cached: every snapshot/put/remove/resolve reloads at call
  // time so the service never serves a stale copied triple. This single alias
  // owner is constructed before TaskSettingsService and shared with it — task
  // settings resolves alias references freshly through the same instance.
  const runtimeAliasStore = new RuntimeAliasStore()
  const runtimeAliasService = new RuntimeAliasService(runtimeAliasStore)
  // One private current-CodeBuddy-active-snapshot loader bound to the catalog
  // codebuddy provider definition and the existing provider runtime. Every
  // snapshot() request and every exact-codebuddy readiness probe resolves the
  // current login/environment afresh through runtime.codeBuddySnapshot — never
  // a startup-frozen credential or a stale CodeBuddy login/environment wire
  // remap. When no codebuddy provider exists or the runtime exposes no
  // snapshot loader, the loader resolves to undefined so CodeBuddy closes
  // closed everywhere.
  const codebuddyProviderDef = catalog.provider('codebuddy')
  const loadCurrentCodeBuddySnapshot = async () => {
    if (codebuddyProviderDef === undefined) return undefined
    const snapshotLoader = providerRuntime.codeBuddySnapshot
    if (snapshotLoader === undefined) return undefined
    return snapshotLoader(codebuddyProviderDef)
  }
  // One daemon-owned immutable automatic-routing quota snapshot service. All
  // automatic selections (TaskSettingsService run + preview) share this single
  // instance so quota evidence/caching never diverges between paths. The
  // private current-CodeBuddy loader is injected so the service scopes quota
  // queries to the current login/environment and keys its cache by that
  // context; the daemon-owned WRENYARD_DISPATCH_PLANS_JSON stays canonical and
  // never freezes a CodeBuddy login/environment wire remap at startup.
  const autoRoutingQuotaSnapshots = new AutoRoutingQuotaSnapshotService({
    codeBuddySnapshot: loadCurrentCodeBuddySnapshot,
  })
  // Authoritative, non-inference native auth/model readiness now comes from the
  // clients' own native observations (AgentClient.readReadiness), not a Wrenyard
  // subprocess. The daemon boundary only maps each native client to its known
  // canonical provider binding and canonicalizes public model ids; no native
  // credential crosses this boundary and native auth is never promoted into
  // Gateway support. Auth unknown stays an absent entry (never false).
  const loadNativeProviderReadiness = async (): Promise<NativeProviderReadinessSnapshot> => {
    const authByProvider: Record<string, boolean> = {}
    const clients = createAgentClients()
    const codexReadiness = await readClientReadiness(clients.get('codex'))
    if (codexReadiness?.authentication === 'ready') authByProvider.chatgpt = true
    else if (codexReadiness?.authentication === 'missing') authByProvider.chatgpt = false
    const cursorReadiness = await readClientReadiness(clients.get('cursor'))
    if (cursorReadiness?.authentication === 'ready') authByProvider.cursor = true
    else if (cursorReadiness?.authentication === 'missing') authByProvider.cursor = false
    const cursorModelAvailability = cursorReadiness?.authentication === 'ready'
      ? projectModelAvailability(cursorReadiness.modelAvailability, 'cursor')
      : undefined
    return Object.freeze({
      sampledAtMs: Date.now(),
      authByProvider: Object.freeze(authByProvider),
      ...(cursorModelAvailability === undefined ? {} : { cursorModelAvailability }),
    })
  }
  // Client installation comes from each AgentClient.inspect. Enabled follows
  // the registered client; installed is the inspect result.
  const loadClientReadiness = async () => {
    const clientsById: Record<string, { enabled: boolean; installed: boolean }> = {}
    for (const [id, client] of createAgentClients()) {
      const status = await client.inspect()
      clientsById[id] = { enabled: true, installed: status.installation.state === 'installed' }
    }
    return { sampledAtMs: Date.now(), clientsById }
  }
  // One daemon-owned TaskSettingsService shares the already-created resolver,
  // the single alias owner, the shared quota snapshot service, and the
  // authoritative config path; no second catalog/resolver/alias store is
  // constructed.
  const authoritativeConfigPath = new ForemanConfigManager().resolvePath(options.configPath)
  const taskSettingsService = new TaskSettingsService({
    workspaceRoot: config.workspaceRoot,
    configPath: authoritativeConfigPath,
    resolver: taskDispatchResolver,
    aliases: runtimeAliasService,
    quotaSnapshots: autoRoutingQuotaSnapshots,
    nativeProviderReadiness: loadNativeProviderReadiness,
    // The production gate uses each registered client's own inspect state for
    // ALL clients; a client must be enabled AND installed to be admitted.
    clientReadiness: loadClientReadiness,
    // Non-billable readiness: real daemon admission status (never a paid probe)
    // plus the current provider credential/route availability. Unknown quota is
    // surfaced as `unknown` — never fabricated as available or zero. Exact
    // CodeBuddy readiness is bound to one fresh current CodeBuddyActiveSnapshot
    // (see runtimeAvailability), and every other provider keeps the existing
    // credential/route path. The privacy-safe confirmed-free supply fact for an
    // already-read credential plus the exact selected runtime model is included
    // without any token/scope/environment/domain/upstream suffix; no paid/model
    // probes are ever issued.
    daemonAvailability: () => ({
      accepting: runtime.dispatchControl.status().accepting,
      known: true,
    }),
    runtimeAvailability: async ({ client, provider, model, mode }, availabilityContext) => {
      const providerDef = runtime.catalog.provider(provider)
      if (!providerDef) {
        return {
          providerCredential: 'unknown',
          providerLive: 'unknown',
          quota: 'unknown',
          available: false,
        }
      }
      if (providerDef.credentialResolver === 'codex' || providerDef.credentialResolver === 'cursor') {
        // A request-bound automatic context contains the one status sample for
        // that evaluation (null means its bounded query failed). Explicit-mode
        // checks have no context and take one fresh sample here. In either case
        // the actual native runtime remains the credential authority and
        // revalidates the login when execution starts.
        let readiness = availabilityContext?.nativeProviderReadiness ?? undefined
        if (availabilityContext === undefined) {
          try {
            readiness = await loadNativeProviderReadiness()
          } catch {
            readiness = undefined
          }
        }
        const state = evaluateNativeRouteReadiness(readiness, {
          providerId: providerDef.id,
          client,
          mode,
          nativeClients: providerDef.nativeClients ?? [],
          model,
        })
        if (state === 'available') {
          return {
            providerCredential: 'available',
            providerLive: 'available',
            quota: 'unknown',
            available: true,
          }
        }
        if (state === 'missing') {
          return {
            providerCredential: 'missing',
            providerLive: 'unknown',
            quota: 'unknown',
            available: false,
          }
        }
        if (state === 'blocked') {
          return {
            providerCredential: 'available',
            providerLive: 'unavailable',
            quota: 'unknown',
            available: false,
          }
        }
        return {
          providerCredential: 'unknown',
          providerLive: state === 'unsupported' ? 'unavailable' : 'unknown',
          quota: 'unknown',
          available: false,
        }
      }
      if (providerDef.id === 'codebuddy') {
        // Exact codebuddy readiness uses exactly one fresh immutable
        // CodeBuddyActiveSnapshot for the current login/environment. Absent or
        // throwing loads and snapshots without an opaque stable scope fail
        // closed (reported missing); confirmed-free is derived only through
        // that same snapshot.freeSupply(model). There is no fallback to
        // credential()/freeSupply(), and no credential, stable scope,
        // environment, domain, token, or wire model is exposed on the report.
        let activeSnapshot = availabilityContext?.codeBuddySnapshot
        if (availabilityContext === undefined) {
          try {
            activeSnapshot = await loadCurrentCodeBuddySnapshot()
          } catch {
            activeSnapshot = undefined
          }
        }
        if (activeSnapshot === undefined || activeSnapshot.stableScope === undefined) {
          return {
            providerCredential: 'missing',
            providerLive: 'unknown',
            quota: 'unknown',
            available: false,
          }
        }
        const wireModel = activeSnapshot.resolveUpstreamModel(model)
        if (!wireModel) {
          return {
            providerCredential: 'missing',
            providerLive: 'unknown',
            quota: 'unknown',
            available: false,
          }
        }
        const freeSupply = activeSnapshot.freeSupply(model)
        // An iOA login exposes no observable quota pool, so the generic
        // unknown-quota outcome would rank it as if it were exhausted. The
        // environment classification stays inside this branch; only a derived
        // provenance-bearing fact leaves it.
        const quotaFloor = activeSnapshot.environment === 'ioa'
          ? { source: 'codebuddy.credential_environment', ruleId: 'codebuddy.ioa_unknown_quota_floor' }
          : undefined
        return {
          providerCredential: 'available',
          providerLive: 'available',
          quota: 'unknown',
          available: true,
          ...(freeSupply ? { freeSupply } : {}),
          ...(quotaFloor ? { quotaFloor } : {}),
          codeBuddyExecution: {
            expectedScope: activeSnapshot.stableScope,
            expectedEnvironment: activeSnapshot.environment,
            expectedWireModel: wireModel,
          },
        }
      }
      const credential = await runtime.providerRuntime.credential(providerDef)
      const available = credential !== undefined
      const freeSupply = credential === undefined
        ? undefined
        : runtime.providerRuntime.freeSupply?.(providerDef, model, credential)
      return {
        providerCredential: available ? 'available' : 'missing',
        providerLive: available ? 'available' : 'unknown',
        quota: 'unknown',
        available,
        ...(freeSupply ? { freeSupply } : {}),
      }
    },
  })
  // The running task runner resolves execution-time settings through this same
  // service instance (no duplicate service/resolver/provider objects, no paid
  // probes): daemon bootstrap attaches resolveForRun as the runner's resolver.
  runtime.runner.setTaskSettingsResolver((params) => taskSettingsService.resolveForRun(params))
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
  // HTTP listener and IPC transport are exposed. Install the exact canonical
  // task plans and provisional loopback connection first so Wrenyard never falls
  // back to resolving provider/model/protocol data itself.
  let restoreGatewayEnvironment = installGatewayEnvironment({
    ...await gateway.connection(gatewayOrigin(config.service.host, config.service.port)),
    token: gatewayToken,
  }, dispatchPlans)
  const workspaceDocService = new WorkspaceDocService(config.workspaceRoot)
  const clientDiscovery = new InstalledClientDiscovery()
  const clientOwnership = new JsonClientOwnershipStore(join(stateRoot, 'client-configuration', 'ownership.json'))
  const credentialHelperPath = join(
    stateRoot,
    'client-configuration',
    process.platform === 'win32' ? 'gateway-credential-helper.mjs' : 'gateway-credential-helper',
  )
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
  const providerService = new ProviderService({
    catalog, runtime: providerRuntime,
    modelStatus: () => taskSettingsService.modelStatus(),
    localSpeed: readLocalSpeedSamples,
  })
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
    providerList: () => providerService.list(),
    providerConfigure: async (params) => {
      const result = await providerService.configure(params)
      // A new credential can change which models the session/DSh projection
      // admits. Refresh is best-effort: the provider.configure reply must not
      // depend on the session backend being reachable.
      try {
        await sessionRefresh.current?.refreshModels()
      } catch (error) {
        writeDaemonLog('warn', 'session model refresh after provider.configure failed', error)
      }
      return result
    },
    providerQuota: (params) => providerService.quotaSnapshot(params),
    clientConfiguration: {
      snapshot: () => clientConfigurationService.snapshot(),
      plan: ({ clientId, selection }) => clientConfigurationService.plan(clientId, selection),
      apply: ({ plan }) => clientConfigurationService.apply(plan),
      planRestore: ({ clientId }) => clientConfigurationService.planRestore(clientId),
      restore: ({ plan }) => clientConfigurationService.restore(plan),
    },
    taskSettings: taskSettingsService,
    runtimeAlias: runtimeAliasService,
    execService: runtime.execService,
    taskService,
    resolveExecRequest: (params) => {
      const provider = params.provider ?? catalog.clients().find(client => client.id === params.client)?.nativeProvider
      if (!provider) throw new Error('Execution requires a provider')
      if (params.thinking && !['low', 'medium', 'high', 'xhigh', 'max'].includes(params.thinking)) throw new Error('Invalid thinking level')
      const plan = catalog.resolveRun(params.client, provider, params.model, params.thinking as Parameters<typeof catalog.resolveRun>[3])
      if (params.mode && params.mode !== plan.mode) throw new Error('Requested mode does not match the selected client/provider')
      // The native wire spelling is owned by the provider, not by this request:
      // resolve it through the provider runtime so an explicit exec launches the
      // exact product id (e.g. canonical Claude 5 -> its `-1m` row) in every
      // environment. An explicit thinking-mapped substitution still wins, and
      // the public canonical id is preserved for the gateway/id surfaces.
      const providerDefinition = catalog.provider(provider)
      const upstreamModel = plan.upstreamModel
        ?? (providerDefinition ? providerRuntime.resolveUpstreamModel(providerDefinition, plan.model) : plan.model)
      return {
        ...params, provider, canonicalModel: plan.model,
        model: upstreamModel, mode: plan.mode, protocol: plan.protocol,
        thinking: plan.reasoningEffort ?? plan.thinking,
      }
    },
    // Display-name lookup for stats rows. The persisted provider id arrives
    // already normalized by the stats source; the persisted model id is first
    // normalized through the provider's own registry alias map (the same map the
    // Catalog uses to build public ids) so a recognized historical alias still
    // resolves to its current definition when offerings move. When the current
    // offerings no longer list the exact recorded route — for example a provider
    // that dropped an alias — the exact recorded provider/model ids are returned
    // with the best available provider label, so a historical row is never left
    // blank, a missing provider/model identity is never invented, and no client
    // or upstream identifier is consulted.
    resolveTaskRunDisplayNames: (providerId, modelId) => {
      const recordedProvider = typeof providerId === 'string' ? providerId.trim() : ''
      const recordedModel = typeof modelId === 'string' ? modelId.trim() : ''
      if (recordedProvider === '' || recordedModel === '') return undefined
      const provider = catalog.provider(recordedProvider)
      const normalizedModelId = provider?.modelAliases?.[recordedModel] ?? recordedModel
      const model = provider?.models.find((candidate) => candidate.id === normalizedModelId)
      const providerDisplayName = provider?.displayName?.trim()
      const modelDisplayName = model?.displayName?.trim()
      if (model && providerDisplayName && modelDisplayName) {
        const canonicalModel = model.canonicalModel
        const statsModelId = canonicalModel?.id ?? `${recordedProvider}/${normalizedModelId}`
        const statsModelDisplayName = canonicalModel?.displayName ?? modelDisplayName
        return {
          provider_display_name: providerDisplayName,
          model_display_name: modelDisplayName,
          stats_model_key: canonicalModel ? `canonical:${statsModelId}` : `provider-local:${statsModelId}`,
          stats_model_id: statsModelId,
          stats_model_display_name: statsModelDisplayName.trim(),
        }
      }
      // Truthful, exact recorded fallback: the identity is known, only the
      // current definition is not. Keep it provider-local so equal raw model
      // strings from unrelated providers can never collide.
      const statsModelId = `${recordedProvider}/${recordedModel}`
      return {
        provider_display_name: providerDisplayName || recordedProvider,
        model_display_name: recordedModel,
        stats_model_key: `provider-local:${statsModelId}`,
        stats_model_id: statsModelId,
        stats_model_display_name: recordedModel,
      }
    },
    // Protocol-validated RPC shutdown binds once to the instance's real
    // requestShutdown; no local request cache or forwarding indirection.
    shutdown: options.requestShutdown,
  })

  // During drain, preserve status/cancel/signals and the calls required by
  // admitted work. New top-level dispatch and long polling cannot hold the
  // daemon open or create more work after the shutdown request is accepted.
  const blockedDuringShutdown = new Set([
    'taskgraph.create', 'task.run.create', 'exec.start', 'session.send',
    'taskgraph.wait', 'task.run.wait',
  ])
  rpcRouter.setAdmissionGate((method, params) => {
    const longSessionPoll = method === 'session.snapshot'
      && typeof params === 'object' && params !== null
      && 'waitMs' in params && typeof params.waitMs === 'number' && params.waitMs > 0
    if (runtime.dispatchControl.isShutdownRequested && (blockedDuringShutdown.has(method) || longSessionPoll)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'Daemon is shutting down and is not accepting this request.' },
        { code: 'daemon_shutting_down', method },
      )
    }
  }, [
    'taskgraph.create', 'taskgraph.patch', 'taskgraph.signal',
    'task.run.create', 'exec.start', 'session.send', 'message.send',
  ])

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
  // The session feature owns DSH plus conversation persistence. It is rooted at
  // the Desktop userData directory so a CLI-started daemon and the Electron app
  // share exactly one conversation state tree; its gateway connection and task
  // wait/cancel are injected in-process, and DSH MCP tools reach the daemon over
  // this same IPC path like every other client.
  const sessionService = createSessionService({
    stateRoot: resolveDesktopStateRoot(),
    initialWorkspace: {
      status: 'configured',
      source: 'user-config',
      configPath: authoritativeConfigPath,
      path: config.workspaceRoot,
      readOnly: false,
    },
    ipcPath,
    getGatewayConnection: async () => ({
      ...await gateway.connection(gatewayOrigin(config.service.host, boundPort)),
      token: gatewayToken,
    }),
    waitForTaskRun: (taskRunId, signal) => taskService.wait(taskRunId, undefined, signal),
    cancelTaskRun: async (taskRunId) => {
      await taskService.cancel(taskRunId)
    },
  })
  sessionRefresh.current = sessionService
  registerSessionHandlers(rpcRouter, { sessionService })
  let ipcServer: IpcServer | undefined
  try {
    await ensureGatewayCredentialHelper(credentialHelperPath, activeIpcPath)
    ipcServer = await createIpcServer({
      path: ipcPath,
      onMessage: (message) => rpcRouter.handleMessage(message, { transport: 'ipc' }),
    })
  } catch (error) {
    // Tear down every handle already built through the one shared teardown:
    // HTTP, session, gateway + environment restore, IPC (if it was created),
    // MCP and SSE. The runtime supervisor/exec/DB are owned and released by
    // bootstrap's runtime teardown after this throws. Individual failures are
    // logged by the teardown; its aggregate is swallowed so it can never
    // replace the original startup error the caller sees.
    await teardownDaemonResources({
      httpServer,
      sessionService,
      gateway,
      restoreGatewayEnvironment,
      ipcServer,
      mcpServer,
      activeSseStreams,
      connections,
    }).catch(() => {})
    throw error
  }
  if (!ipcServer) throw new Error('failed to start IPC server')
  // Start the DSH-backed session backend only after the IPC router is serving,
  // and never await it: daemon boot (HTTP/MCP/IPC readiness) must not be gated
  // on DSH coming up. A failed start is reported through session.backend.
  void sessionService.start().catch((error: unknown) => {
    writeDaemonLog('error', 'session service start failed', error)
  })
  const runningIpcServer = ipcServer
  // Lifecycle (shutdown latch, drain waits, close) lives on the ForemanDaemon
  // instance; this helper only returns the assembled resources.
  return {
    runtime,
    mcpServer,
    httpServer,
    ipcPath,
    ipcServer: runningIpcServer,
    gateway,
    sessionService,
    rpcRouter,
    activeSseStreams,
    connections,
    restoreGatewayEnvironment,
  }
}

/**
 * Ordered optional handles for the one resource teardown. Every field is a
 * concrete handle the single owner happens to hold; a caller omits whatever it
 * does not own, so a partial start tears down only what it already built. There
 * is no per-handle lifecycle behavior here, only the fixed teardown order.
 */
interface DaemonResourceTeardownHandles {
  /** Started first, awaited last: its async handle teardown overlaps the rest. */
  httpServer?: Server
  sessionService?: SessionService
  gateway?: ModelGateway
  restoreGatewayEnvironment?: () => void
  ipcServer?: IpcServer
  supervisor?: AgentExecutionSupervisor
  execService?: ExecService
  mcpServer?: ForemanMcpServer
  activeSseStreams?: Array<{ res: ServerResponse; timer: NodeJS.Timeout; connId: string; conn: McpConnection }>
  connections?: Map<string, McpConnection>
  /** Released after the HTTP close settles; set only by whoever retained the DB. */
  releaseDb?: () => void
}

/**
 * The single resource teardown shared by normal close and both partial-start
 * failure paths. Every supplied handle is attempted exactly once in the one
 * canonical order (HTTP close start, session, gateway + environment restore,
 * IPC, supervisor, exec, MCP, SSE, await HTTP, DB release). Each failure is
 * logged, every remaining handle still runs, and the first failure is thrown
 * once all handles were attempted so the normal path can surface it.
 */
async function teardownDaemonResources(handles: DaemonResourceTeardownHandles): Promise<void> {
  let firstError: unknown
  let hasError = false
  const recordFailure = (message: string, error: unknown): void => {
    writeDaemonLog('warn', message, error)
    if (!hasError) {
      hasError = true
      firstError = error
    }
  }
  // Start the HTTP close first so its async handle teardown overlaps the
  // synchronous resource shutdowns below; it is awaited near the end.
  const httpClose = handles.httpServer
    ? closeHttpServerIfListening(handles.httpServer).catch((error: unknown) => {
        recordFailure('HTTP server shutdown failed', error)
      })
    : Promise.resolve()
  // Stop the session/DSH backend immediately after: it owns its child process
  // and the conversation persistence it writes, and must not observe a closed
  // gateway or a torn-down supervisor.
  if (handles.sessionService) {
    try {
      await handles.sessionService.close()
    } catch (error) {
      recordFailure('session service shutdown failed', error)
    }
  }
  // A gateway failure must not skip IPC/supervisor/exec/HTTP/DB cleanup: each
  // owned resource is attempted once in order regardless, and the environment
  // restore still runs after the gateway attempt.
  if (handles.gateway) {
    try {
      await handles.gateway.close()
    } catch (error) {
      recordFailure('gateway shutdown failed', error)
    }
  }
  if (handles.restoreGatewayEnvironment) {
    try {
      handles.restoreGatewayEnvironment()
    } catch (error) {
      recordFailure('gateway environment restore failed', error)
    }
  }
  if (handles.ipcServer) {
    try {
      await handles.ipcServer.close()
    } catch (error) {
      recordFailure('IPC server shutdown failed', error)
    }
  }
  if (handles.supervisor) {
    try {
      await handles.supervisor.shutdown()
    } catch (error) {
      recordFailure('supervisor shutdown failed', error)
    }
  }
  // Cancel every live raw prompt execution so no agent child outlives the
  // daemon. The task supervisor's children are already settled above; this
  // covers executions started through the exec RPC/CLI surface.
  if (handles.execService) {
    try {
      await handles.execService.close()
    } catch (error) {
      recordFailure('exec service shutdown failed', error)
    }
  }
  if (handles.mcpServer) {
    try {
      handles.mcpServer.close()
    } catch (error) {
      recordFailure('MCP shutdown failed', error)
    }
  }
  if (handles.activeSseStreams && handles.connections) {
    try {
      // Close all active channel SSE streams and clear timers (Fix 2)
      closeActiveSseStreams(handles.activeSseStreams, handles.connections)
    } catch (error) {
      recordFailure('SSE shutdown failed', error)
    }
  }
  try {
    await httpClose
  } finally {
    if (handles.releaseDb) {
      try {
        handles.releaseDb()
      } catch (error) {
        recordFailure('database release failed', error)
      }
    }
  }

  if (hasError) throw firstError
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
  dispatchPlans: Readonly<Record<string, import('@wrenyard/providers/catalog').DispatchPlan>>,
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

/**
 * One bounded native client observation for the daemon-boundary readiness
 * snapshot. A client without readReadiness, or any failed observation, yields
 * undefined so the caller records it as unknown rather than ready.
 */
async function readClientReadiness(client: AgentClient | undefined): Promise<NativeClientReadiness | undefined> {
  if (client?.readReadiness === undefined) return undefined
  try {
    return await client.readReadiness()
  } catch {
    return undefined
  }
}

interface DaemonRpcRouterOptions {
  startedAt: number
  workspaceRoot: string
  messageService?: MessageService
  operations?: OperationHost
  shutdown?: (reason: string, force: boolean) => void
  dispatchControl?: DispatchControl
  taskgraphService?: TaskGraphService
  workspaceDocService?: WorkspaceDocService
  gatewayConnection?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['gatewayConnection']
  providerList?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['providerList']
  providerConfigure?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['providerConfigure']
  providerQuota?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['providerQuota']
  clientConfiguration?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['clientConfiguration']
  taskSettings?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['taskSettings']
  runtimeAlias?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['runtimeAlias']
  execService?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['execService']
  taskService?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['taskService']
  resolveExecRequest?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['resolveExecRequest']
  resolveTaskRunDisplayNames?: import('../server/handlers/core.mts').CoreRpcHandlerOptions['resolveTaskRunDisplayNames']
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
  /** Shared raw prompt-execution service consumed by the RPC surface and tasks. */
  execService: ExecService
  catalog: import('@wrenyard/providers/catalog').Catalog
  providerRuntime: import('@wrenyard/providers').ProviderRuntime
  /** Canonical task dispatch plans keyed by provider/model:client targets. */
  dispatchPlans: Readonly<Record<string, import('@wrenyard/providers/catalog').DispatchPlan>>
  taskDispatchResolver: TaskDispatchResolver
}

async function bootstrapForemanDaemonRuntime(dispatchControl: DispatchControl): Promise<ForemanDaemonRuntime> {
  const db = initDb(process.env.FOREMAN_DB_PATH)
  retainDaemonDb()

  // Destructive telemetry cleanup belongs to daemon startup, once this process
  // owns the database and the previous daemon has stopped. Ordinary initDb
  // (bootstrapSchema) deliberately leaves legacy columns intact.
  dropTaskRunTelemetryRetiredColumns(db)

  // Catalog + provider runtime are the single source of truth for the daemon.
  // Canonical task dispatch plans and the deterministic resolver are derived
  // here (not in the runtime bootstrap) so the runner is wired with a fully
  // constructed resolver, and the gateway/RPC surfaces reuse the same
  // instances. Plans are derived from the catalog alone
  // (deriveTaskDispatchPlans) rather than resolved against a loaded credential
  // set (resolveRuntimeTaskPlans): the daemon-owned dispatch plans and the
  // installed WRENYARD_DISPATCH_PLANS_JSON stay canonical and never freeze a
  // CodeBuddy login/environment wire remap at startup — the current login is
  // bound afresh when a CodeBuddy dispatch plan is actually used.
  //
  // One CodeBuddy install read supplies both the public product facts and the
  // private account context the provider binds to its credential.
  const install = await new CodeBuddyClient().readInstall()
  const codeBuddy = createCodeBuddy({
    product: {
      status: install.product.status,
      environment: install.product.environment,
      entries: install.product.entries,
      ...(install.product.identity ? { identity: install.product.identity } : {}),
      ...(install.account ? { account: install.account } : {}),
    },
  })
  const catalog = createBuiltinCatalog([codeBuddy])
  const providerRuntime = createBuiltinProviderRuntime({ providers: [codeBuddy] })
  const dispatchPlans = deriveTaskDispatchPlans(catalog)
  const taskDispatchResolver = await createTaskDispatchResolver({
    catalog,
    runtime: providerRuntime,
    // Share response-paired TPS across statistics and automatic routing.
    localSpeed: () => readLocalSpeedSamples(),
  })

  try {
    new WorkflowRunStore(db).markAllNonTerminalCancelled(new Date().toISOString())
    const repoWriteLocks = new RepoWriteLocks()
    // One daemon-owned raw prompt-execution service shared by the RPC surface,
    // the CLI, and the task supervisor. It owns a single client map and a single
    // configured feature registry, so a structured task attempt and an explicit
    // `wrenyard exec` share the exact same launch path and shutdown handling.
    // Its features are explicit environment MCP descriptors (see
    // exec-features.mts); no credential or environment value crosses the public
    // IPC surface.
    const execService = new ExecService({
      clients: createAgentClients(),
      features: createExecFeatureRegistry(),
    })
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      logger: createDaemonSupervisorLogger(),
      catalog,
      execService,
    })
    const runner = new TaskWorkflowRunner({
      db,
      agentExecutionHost: supervisor,
      logger: createDaemonSupervisorLogger(),
      admissionControl: () => dispatchControl.assertAccepting(),
      taskDispatchResolver,
    })
    await supervisor.markInterruptedOnStartup()
    setAgentExecutionSupervisor(supervisor)
    setTaskWorkflowRunner(runner)

    return { db, repoWriteLocks, supervisor, runner, dispatchControl, execService, catalog, providerRuntime, dispatchPlans, taskDispatchResolver }
  } catch (error) {
    releaseDaemonDb()
    throw error
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
