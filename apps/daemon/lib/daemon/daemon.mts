import { createRoutingAvailability, createAuxiliaryAvailability } from './services/model-routing-availability.mts'
import { createAuxiliarySelector, readAuxiliaryRoutingSettings } from './services/auxiliary-routing.mts'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { closeDb, getDb, initDb, query as dbQuery } from '../db/connection.mts'
import { dropTaskRunTelemetryRetiredColumns } from '../db/schema.mts'
import type { ForemanDatabase } from '../db/types.mts'
import { WorkflowRunStore } from '../db/stores/workflow-run-store.mts'
import type { OperationHost } from '../core/operations/types.mts'
import type { ForemanServiceConfig } from '../config/index.mts'
import { updateForemanConfigData } from '../config/writer.mts'
import { RpcRouter } from '../server/rpc-router.mts'
import { registerCoreHandlers, readProcessIdentity, type CoreRpcHandlerOptions } from '../server/handlers/core.mts'
import { createIpcServer, type IpcServer } from '../control/ipc-server.mts'
import { registerSessionHandlers } from '../server/handlers/session.mts'
import { registerScheduleHandlers } from '../server/handlers/schedule.mts'
import { registerBotHandlers } from '../server/handlers/bot.mts'
import { INVALID_PARAMS, ProtocolError } from '../protocol/errors.mts'
import type { WorkspaceSwitchResult } from '../protocol/registry.mts'
import { TaskService } from '../core/task/service.mts'
import { createSession, type Session } from '@wrenyard/session'
import { resolveWrenyardIpcPath } from '@wrenyard/control'
import { createDaemonSessionHost } from './services/session-host.mts'
import { createScheduler, type Scheduler } from './services/scheduler.mts'
import { createBotHost, type BotHost } from './services/bot/host.mts'
import { setAgentExecutionSupervisor } from '../core/operations/primitives/agent.mts'
import { setTaskWorkflowRunner } from '../core/operations/primitives/runner.mts'
import { AgentExecutionSupervisor, type SupervisorLogger } from './execution/agent-supervisor.mts'
import { TaskWorkflowRunner } from './execution/task-workflow-runner.mts'
import type { TaskRouteStateHooks } from '../types.mts'
import { RepoWriteLocks } from './execution/repo-write-locks.mts'
import { acquireInstanceLock, releaseInstanceLock } from './instance-lock.mts'
import { createTaskGraphService } from './services/taskgraph-service.mts'
import { TaskGraphService } from '../core/taskgraph/index.mts'
import { TaskSettingsService } from './services/task-settings-service.mts'
import { AutoRoutingQuotaSnapshotService } from './services/auto-routing-snapshot-service.mts'
import {
  evaluateNativeRouteReadiness,
  projectModelAvailability,
  type NativeProviderReadinessSnapshot,
} from './execution/native-provider-readiness.mts'
import { createAgentClients, CodeBuddyClient, readCodexGatewayCredential, refreshCodexGatewayCredential, type AgentClient, type NativeClientReadiness } from '@wrenyard/clients'
import { ExecService } from '@wrenyard/exec'
import { ProviderService } from '@wrenyard/provider-service'
import { OperationComponents } from './services/operation-components.mts'
import { OperationAdapter } from './execution/operation-adapter.mts'
import { RuntimeAliasService } from './services/runtime-alias-service.mts'
import { RemoteHostRegistryService } from '../remote/host-registry.mts'
import { createWorkspaceControl } from './services/workspace-control.mts'
import RuntimeAliasStore from '../runtime-aliases/store.mts'
import { ForemanConfigManager } from '../config/manager.mts'
import { getForemanEventBus } from '../events/event-bus.mts'
import { readLocalSpeedSamples } from '../events/tps.mts'
import type { ForemanEvent, ForemanEventKind, ForemanEventSeverity } from '../events/event-types.mts'
import { WorkspaceDocService } from './services/workspace-doc-service.mts'
import { createModelGateway, type ModelGateway, type RouteStatus } from '@wrenyard/gateway'
import { deriveTaskDispatchPlans, createBuiltinCatalog, createBuiltinProviderRuntime, createCodeBuddy } from '@wrenyard/providers'
import { REASONING_EFFORTS, parseRunSyntax, type ReasoningEffort } from '@wrenyard/providers/catalog'
import { createTaskDispatchResolver, type TaskDispatchResolver } from '../core/task/dispatch-resolver.mts'
import { ForemanEventStore } from '../events/event-store.mts'
import { foremanStateRoot } from '../config/state.mts'

export interface RunningForemanDaemon {
  db: ForemanDatabase
  repoWriteLocks: RepoWriteLocks
  supervisor: AgentExecutionSupervisor
  runner: TaskWorkflowRunner
  httpServer: Server
  ipcPath: string
  ipcServer: IpcServer
  gateway: ModelGateway
  /** Deterministic daemon-side task dispatch resolver. Supplies exact constrained
   *  plans to the execution kernel; it performs no service lifecycle mutation. */
  taskDispatchResolver: TaskDispatchResolver
  /** Daemon-owned task service; a forced shutdown cancels its admitted runs. */
  taskService: TaskService
  /** Daemon-owned taskgraph service; a forced shutdown cancels its active graphs. */
  taskgraphService: TaskGraphService
  /**
   * Idle-only workspace hot switch. Rebinds every workspace-scoped service to the
   * requested root and persists workspace.root while this process, its instance
   * lock, database, execution runtime and IPC endpoint stay alive. Never throws
   * for an expected refusal: the structured result carries the outcome and the
   * daemon's reason verbatim.
   */
  switchWorkspace(root: string): Promise<WorkspaceSwitchResult>
  /** Records the request, closes admission, and resolves shutdownRequested. Never drains or stops. */
  requestShutdown(reason: string, force?: boolean): void
  /** Resolves once any exit entry (RPC, signal, parent message) requested shutdown. */
  readonly shutdownRequested: Promise<void>
  /** Waits for admitted work to finish. An explicit force skips the wait. Never stops the daemon. */
  drain(): Promise<void>
  /** Idempotent close; a second call never restarts cleanup, even after a failed close. */
  stop(): Promise<void>
}

export interface ForemanDaemonDeps {}

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
   * Set when the effective workspace root is pinned outside the config by
   * `WRENYARD_WORKSPACE` or the daemon's `--work-dir` CLI flag. A pinned root is
   * owned by whoever launched the process, so the in-process switch refuses with
   * an explicit `pinned` outcome instead of silently fighting the pin.
   */
  workspacePinSource?: 'environment' | 'cli'
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
  httpServer: Server
  ipcPath: string
  ipcServer: IpcServer
  gateway: ModelGateway
  session: Session
  /** Daemon-owned scheduled-prompt service; stopped first on shutdown so it
   *  starts no new turns during drain. */
  scheduler: Scheduler
  /** Daemon-owned Bot mode host; stopped with the scheduler so it starts no new
   *  bot step during drain or a workspace switch. */
  botHost: BotHost
  rpcRouter: RpcRouter
  /** Daemon-owned task service, retained so a forced shutdown can cancel every
   *  admitted task run through the same service the RPC surface uses. */
  taskService: TaskService
  /** Daemon-owned taskgraph service, retained so a forced shutdown can cancel
   *  every active graph through its existing signal API. */
  taskgraphService: TaskGraphService
  restoreGatewayEnvironment: () => void
  /**
   * Rebind every workspace-scoped resource to a new root and persist the
   * authoritative `workspace.root`. `session`, `scheduler`, `taskService` and
   * `taskgraphService` on this object are replaced by the current bindings, so
   * close() always tears down the live workspace. Created by
   * createForemanDaemonResources, where every shared dependency already lives;
   * it reuses the same assembly code as startup instead of duplicating it.
   */
  rebindWorkspace: (requestedRoot: string) => Promise<WorkspaceSwitchResult>
}

/** The workspace-scoped services one root owns; replaced whole on a switch. */
interface WorkspaceScopedResources {
  workspaceRoot: string
  taskService: TaskService
  taskgraphService: TaskGraphService
  taskSettingsService: TaskSettingsService
  workspaceDocService: WorkspaceDocService
  session: Session
  scheduler: Scheduler
  /** Bot mode host for this workspace; replaced whole on a hot switch. */
  botHost: BotHost
}

/**
 * The single daemon instance and the only lifecycle owner. It holds the exit
 * request, the single-instance lock, the admitted-work drain and the created
 * resources. run() is the only lifecycle flow; a shutdown request records
 * itself on this instance at any time — including during startup — and returns
 * without waiting for the process to exit.
 */
export class ForemanDaemon implements RunningForemanDaemon {
  private readonly config: ForemanServiceConfig
  private readonly configPath: string | undefined
  private readonly deps: ForemanDaemonDeps
  private readonly onStarted: ((info: ForemanDaemonStartedInfo) => void) | undefined
  /** Non-undefined when WRENYARD_WORKSPACE / --work-dir pins the workspace root. */
  private readonly workspacePinSource: 'environment' | 'cli' | undefined
  /**
   * The workspace-switch gate. Entered synchronously before any await, so a
   * second switch and every new admitting/workspace-mutating request is refused
   * for the whole switch instead of racing the state swap.
   */
  private switching = false

  private resources: ForemanDaemonResources | undefined
  /** Held outside resources so a shutdown requested during startup still stops it. */
  private scheduler: Scheduler | undefined
  /** Bot host held outside resources for the same reason as the scheduler. */
  private botHost: BotHost | undefined
  private readonly lockPath: string
  private lockHeld = false

  private shutdownRequestedFlag = false
  private shutdownForce = false
  private shutdownRequestedResolve: (() => void) | undefined
  private readonly shutdownRequestedPromise: Promise<void>

  constructor(options: ForemanDaemonOptions) {
    this.config = options.config
    this.configPath = options.configPath
    this.deps = options.deps ?? {}
    this.onStarted = options.onStarted
    // An explicit pin wins; otherwise the pin is detected from the launch
    // environment so a daemon started with WRENYARD_WORKSPACE or --work-dir
    // refuses the hot switch even when the bootstrap did not say so.
    this.workspacePinSource = options.workspacePinSource
      ?? detectWorkspacePinSource(this.configPath, this.config)
    this.lockPath = join(foremanStateRoot(), 'daemon.lock')
    this.shutdownRequestedPromise = new Promise<void>((resolve) => {
      this.shutdownRequestedResolve = resolve
    })
  }

  /**
   * Sole daemon flow: start, wait for a shutdown request, drain admitted work,
   * then close. The returned code is the process exit code.
   */
  async run(): Promise<number> {
    let code = 0
    try {
      await this.start()
      await this.shutdownRequestedPromise
      // Let the shutdown reply reach its transport before close tears down sockets.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await this.drain()
      // A forced shutdown does not wait for admitted work to finish on its own:
      // drain returns as soon as force is set, so cancel every active graph and
      // admitted task run and await terminal cancellation (which terminates the
      // linked agent child) before close() tears down resources and the DB.
      // A force escalated during a normal drain lands here too, because the
      // drain loop exits within one tick of the flag being set.
      if (this.shutdownForce) await this.cancelActiveWork()
    } catch (error) {
      writeDaemonLog('error', 'daemon failed', error)
      code = 1
    }
    try {
      await this.close()
    } catch (error) {
      writeDaemonLog('warn', 'daemon close failed', error)
      code = 1
    }
    return code
  }

  /**
   * Acquires the single-instance lock as its first step, then bootstraps. A
   * second start on an already-started instance is a no-op. The named startup
   * notification fires once after a successful start; if it throws, start()
   * rejects so run() closes the resources instead of running on with no parent
   * ready signal. The lock is held until close().
   */
  async start(): Promise<void> {
    if (this.resources) return
    acquireInstanceLock(this.lockPath, {
      pid: process.pid,
      mode: readProcessIdentity().mode,
      startedAt: new Date().toISOString(),
    })
    this.lockHeld = true

    let runtime: ForemanDaemonRuntime | undefined
    try {
      runtime = await bootstrapForemanDaemonRuntime()
      this.resources = await createForemanDaemonResources(this.config, runtime, {
        configPath: this.configPath,
        requestShutdown: this.requestShutdown,
        isIdle: () => this.isIdle(),
        isShuttingDown: () => this.shutdownRequestedFlag,
        isSwitching: () => this.switching,
        workspaceSwitch: (root) => this.switchWorkspace(root),
        workspacePinned: () => this.workspacePinSource !== undefined,
        onScheduler: (scheduler) => { this.scheduler = scheduler },
        onBotHost: (botHost) => { this.botHost = botHost },
      })
    } catch (error) {
      if (runtime) {
        // Preserve existing runtime resource cleanup (supervisor shutdown + db
        // release) through the one shared teardown. Individual cleanup failures
        // are logged by the teardown; its aggregate is swallowed so a cleanup
        // failure can never replace the original startup error the caller sees.
        await teardownDaemonResources({
          supervisor: runtime.supervisor,
          execService: runtime.execService,
          releaseDb: releaseDaemonDb,
        }).catch(() => {})
      }
      throw error
    }
    const resources = this.resources
    if (resources && this.onStarted) this.onStarted({ ipcPath: resources.ipcPath })
  }

  /**
   * Records the request, closes admission and resolves shutdownRequested.
   * Synchronous and idempotent; the force flag only escalates false -> true.
   * RPC, signals and the parent message all bind straight to it.
   */
  readonly requestShutdown = (reason: string, force = false): void => {
    // Stop the scheduler first: no scheduled fire may start a new turn once a
    // shutdown is requested, and drain only waits for admitted work. This runs
    // even before resources exist, so a request during startup stops the
    // scheduler the instance was handed. The bot host is stopped the same way:
    // no bot step may start once a shutdown is requested.
    this.scheduler?.stop()
    this.botHost?.stop()
    this.shutdownForce ||= force
    this.shutdownRequestedFlag = true
    this.resolveShutdownRequested()
  }

  private resolveShutdownRequested = (): void => {
    const resolve = this.shutdownRequestedResolve
    this.shutdownRequestedResolve = undefined
    resolve?.()
  }

  /** Resolves once any exit entry (RPC, signal, parent message) requested shutdown. */
  get shutdownRequested(): Promise<void> {
    return this.shutdownRequestedPromise
  }

  /**
   * True when no admitted work remains. Missing resources (never started or
   * already closed) count as not idle. Never throws; each authoritative check
   * runs sequentially so a slow check cannot race a sibling.
   */
  async isIdle(): Promise<boolean> {
    const resources = this.resources
    if (!resources) return false
    const counts = readDaemonActiveCounts()
    const activeGraphs = dbQuery<{ id: string }>(
      `SELECT DISTINCT r.id FROM taskgraph_run r
       LEFT JOIN taskgraph_node_state n ON n.taskgraph_id = r.id
       WHERE r.state = 'running' OR r.cancel_requested = 1
          OR (r.state = 'paused' AND n.state = 'running')
          OR (r.state = 'paused' AND r.on_node_failure = 'cancel' AND n.state = 'failed')
       LIMIT 1`,
    )
    return counts.activeTaskCount === 0
      && counts.activeWorkflowCount === 0
      && counts.activeExecutionCount === 0
      && activeGraphs.length === 0
      && !resources.session.hasRunningTurns()
      // An in-flight scheduler tick is work in progress: a switch must not stage
      // over a schedule that is mid-fire. A bot tick or reconciliation is the
      // same kind of work for the bot host.
      && !resources.scheduler.ticking
      && !resources.botHost.ticking
      && resources.rpcRouter.activeWorkRequestCount === 0
  }
  /**
   * Idle-only workspace hot switch. The gate is entered synchronously before
   * any await so a second switch and every new admitting/workspace-mutating
   * request is refused for the whole operation, then the daemon is required to
   * be idle — no queued/running task, workflow, execution, taskgraph, session
   * turn or in-flight workspace operation — before any state is touched.
   *
   * Never throws for an expected refusal; the structured result reports busy,
   * shutting_down, pinned, invalid or unavailable with an actionable message.
   * The gate is released on every path, including a failed rebind.
   */
  async switchWorkspace(root: string): Promise<WorkspaceSwitchResult> {
    if (this.shutdownRequestedFlag) {
      return { ok: false, outcome: 'shutting_down', message: 'Daemon 正在关闭，无法切换工作区' }
    }
    if (this.workspacePinSource !== undefined) {
      return {
        ok: false,
        outcome: 'pinned',
        message: this.workspacePinSource === 'environment'
          ? '当前工作区由 WRENYARD_WORKSPACE 环境变量管理，无法在运行中切换；请调整启动环境后重启 daemon'
          : '当前工作区由 daemon 的 --work-dir 启动参数管理，无法在运行中切换；请去掉该参数后重启 daemon',
      }
    }
    if (this.switching) {
      return { ok: false, outcome: 'busy', message: '另一个工作区切换正在进行，请稍后重试' }
    }
    this.switching = true
    try {
      const resources = this.resources
      if (!resources) return { ok: false, outcome: 'unavailable', message: 'daemon 尚未启动' }
      if (!(await this.isIdle())) {
        return { ok: false, outcome: 'busy', message: '后台仍有任务或正在维护，请完成后再切换工作区' }
      }
      if (this.shutdownRequestedFlag) {
        return { ok: false, outcome: 'shutting_down', message: 'Daemon 正在关闭，无法切换工作区' }
      }
      try {
        return await resources.rebindWorkspace(root)
      } catch (error) {
        // The rebind stages before publishing, so an unexpected failure leaves
        // the previous root and config in place; report it as a structured
        // outcome rather than a protocol error.
        return {
          ok: false,
          outcome: 'error',
          message: `切换工作区失败，已保留原工作区：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    } finally {
      // Released on every path: a refused switch, a failed rebind and a thrown
      // persistence error all leave the daemon able to serve and switch again.
      this.switching = false
    }
  }

  /**
   * Waits for admitted work to finish by polling isIdle() every 200ms until the
   * daemon is idle, or an explicit force skips the wait entirely. Never closes
   * the daemon. A force takes effect within one 200ms tick.
   */
  async drain(): Promise<void> {
    while (!this.shutdownForce && this.resources && !(await this.isIdle())) await sleep(200)
  }

  /**
   * Forced-shutdown step run once drain has been skipped or escalated. Cancels
   * session first, then active graphs and their bound task runs, then every
   * remaining admitted task run, awaiting terminal cancellation so no agent
   * child outlives the daemon and the DB is
   * only closed after cancellation has converged. The services use their
   * existing cancellation APIs and bound their own work; a failure is logged
   * rather than aborting teardown so close() still runs. Normal (non-forced)
   * shutdown never calls this.
   */
  private async cancelActiveWork(): Promise<void> {
    const resources = this.resources
    if (!resources) return
    try {
      await resources.session.close()
    } catch (error) {
      writeDaemonLog('warn', 'session force cancellation failed', error)
    }
    try {
      await resources.taskgraphService.cancelActive()
    } catch (error) {
      writeDaemonLog('warn', 'taskgraph force cancellation failed', error)
    }
    try {
      await resources.taskService.cancelActive()
    } catch (error) {
      writeDaemonLog('warn', 'task force cancellation failed', error)
    }
  }

  /**
   * Alias of close() for the started-daemon surface: a caller that only starts a
   * daemon (tests) stops it directly instead of running the full run() flow.
   */
  readonly stop = (): Promise<void> => this.close()

  /** Idempotent close; a second call never restarts cleanup, even after a failed close. */
  readonly close = async (): Promise<void> => {
    const resources = this.resources
    this.resources = undefined
    try {
      if (resources) {
        await teardownDaemonResources({
          httpServer: resources.httpServer,
          session: resources.session,
          scheduler: resources.scheduler,
          botHost: resources.botHost,
          gateway: resources.gateway,
          restoreGatewayEnvironment: resources.restoreGatewayEnvironment,
          ipcServer: resources.ipcServer,
          supervisor: resources.runtime.supervisor,
          execService: resources.runtime.execService,
          releaseDb: releaseDaemonDb,
        })
      }
    } finally {
      // Release even when start() failed before resources existed, so a failed
      // bootstrap can never leave this process owning the lock.
      if (this.lockHeld) {
        releaseInstanceLock(this.lockPath)
        this.lockHeld = false
      }
    }
  }

  // Resource getters expose the started daemon's resources directly, so there is
  // no separate lifecycle-bearing wrapper object to keep in sync.
  get db(): ForemanDatabase { return this.requireResources().runtime.db }
  get repoWriteLocks(): RepoWriteLocks { return this.requireResources().runtime.repoWriteLocks }
  get supervisor(): AgentExecutionSupervisor { return this.requireResources().runtime.supervisor }
  get runner(): TaskWorkflowRunner { return this.requireResources().runtime.runner }
  get httpServer(): Server { return this.requireResources().httpServer }
  get ipcPath(): string { return this.requireResources().ipcPath }
  get ipcServer(): IpcServer { return this.requireResources().ipcServer }
  get gateway(): ModelGateway { return this.requireResources().gateway }
  get taskDispatchResolver(): TaskDispatchResolver { return this.requireResources().runtime.taskDispatchResolver }
  get taskService(): TaskService { return this.requireResources().taskService }
  get taskgraphService(): TaskGraphService { return this.requireResources().taskgraphService }

  private requireResources(): ForemanDaemonResources {
    if (!this.resources) throw new Error('Foreman daemon has not started')
    return this.resources
  }
}

let activeDaemonDbUsers = 0

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
  try {
    await daemon.start()
  } catch (error) {
    await daemon.close().catch((closeError: unknown) => {
      writeDaemonLog('warn', 'daemon cleanup after failed start failed', closeError)
    })
    throw error
  }
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
  options: {
    configPath?: string
    requestShutdown: (reason: string, force: boolean) => void
    isIdle?: () => Promise<boolean>
    isShuttingDown: () => boolean
    /** True while a workspace hot switch holds the gate; refuses new work. */
    isSwitching?: () => boolean
    /** Daemon-owned workspace hot switch backing the workspace.switch RPC. */
    workspaceSwitch?: (root: string) => Promise<WorkspaceSwitchResult>
    /** True when WRENYARD_WORKSPACE / --work-dir pins the workspace root. */
    workspacePinned?: () => boolean
    /** Receives the scheduler as soon as it exists, before the IPC server. */
    onScheduler?: (scheduler: Scheduler) => void
    /** Receives the bot host as soon as it exists, before the IPC server. */
    onBotHost?: (botHost: BotHost) => void
  },
): Promise<ForemanDaemonResources> {
  const operations: OperationHost = {
    agent: runtime.supervisor,
    runner: runtime.runner,
  }

  const startedAt = Date.now()
  // The gateway listens on a random loopback port assigned at bind time; the URL
  // and every injected value derive from that actual bound port.
  let boundPort = 0
  // Per-start in-memory gateway token. Random, never written to disk, no helper.
  const gatewayToken = randomBytes(32).toString('hex')
  // Catalog / provider runtime / canonical task plans / deterministic resolver
  // are constructed once in bootstrap (see bootstrapForemanDaemonRuntime) and
  // reused here so the gateway, RPC surface, and the running daemon all share
  // the identical resolver instance.
  const { catalog, providerRuntime, dispatchPlans, taskDispatchResolver } = runtime
  // One daemon-owned RuntimeAliasStore + RuntimeAliasService back the
  // runtime.alias.* IPC surface. The store resolves the
  // WRENYARD_CONFIG_HOME/~/.config/wrenyard/dispatch/config.json path itself, and no
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
  const runtimeAvailability = createRoutingAvailability({ catalog, providerRuntime, loadNativeProviderReadiness, loadCurrentCodeBuddySnapshot })
  const gatewayEventStore = new ForemanEventStore(runtime.db)
  const gateway = createModelGateway({
    catalog,
    providers: providerRuntime,
    onRouteStateChanged: async (event) => {
      // Only safe structured facts are emitted: the fault reason, circuit phase,
      // the retry/probe instants and the latest probe outcome. No prompt, body,
      // credential or raw upstream text is ever carried on this event.
      const foremanEvent: ForemanEvent = {
        id: `gateway_route_${randomBytes(12).toString('hex')}`,
        kind: 'gateway.route.state.changed', source: 'wrenyard.gateway',
        severity: event.state === 'available' ? 'info' : 'warning', refs: {},
        data: {
          publicModel: event.publicModel,
          provider: event.provider,
          scope: event.scope,
          ...(event.quotaPoolId === undefined ? {} : { quotaPoolId: event.quotaPoolId }),
          state: event.state,
          ...(event.faultKind === undefined ? {} : { faultKind: event.faultKind }),
          phase: event.phase,
          ...(event.until === undefined ? {} : { until: event.until }),
          ...(event.nextProbeAt === undefined ? {} : { nextProbeAt: event.nextProbeAt }),
          ...(event.nextRetryAt === undefined ? {} : { nextRetryAt: event.nextRetryAt }),
          ...(event.probe === undefined ? {} : { probe: event.probe }),
          status: event.status,
          reason: event.reason,
        },
        occurredAt: new Date().toISOString(),
      }
      gatewayEventStore.append(foremanEvent)
      await getForemanEventBus().publish(foremanEvent)
    },
    onRequestCompleted: async (event) => {
      const foremanEvent: ForemanEvent = {
        id: `gateway_${randomBytes(12).toString('hex')}`,
        kind: 'gateway.request.completed',
        source: 'wrenyard.gateway',
        severity: event.status >= 500 ? 'error' : event.status >= 400 ? 'warning' : 'info',
        refs: {},
        // The route fault reason, phase, retry (until/next probe) and probe
        // outcome are safe structured facts; the attempt id is a gateway-only
        // correlation marker, never a prompt, body or credential.
        data: {
          protocol: event.protocol,
          ...(event.role === undefined ? {} : { role: event.role }),
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          ...(event.publicModel === undefined ? {} : { publicModel: event.publicModel }),
          ...(event.provider === undefined ? {} : { provider: event.provider }),
          ...(event.routeState === undefined ? {} : { routeState: event.routeState }),
          ...(event.routeUntil === undefined ? {} : { routeUntil: event.routeUntil }),
          ...(event.faultReason === undefined ? {} : { faultReason: event.faultReason }),
          ...(event.routePhase === undefined ? {} : { routePhase: event.routePhase }),
          ...(event.nextProbeAt === undefined ? {} : { nextProbeAt: event.nextProbeAt }),
          ...(event.probeOutcome === undefined ? {} : { probeOutcome: event.probeOutcome }),
          ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
          ...(event.reasoningEffort === undefined ? {} : { reasoningEffort: event.reasoningEffort }),
          ...(event.reasoningParameters === undefined ? {} : { reasoningParameters: event.reasoningParameters }),
          status: event.status,
          durationMs: event.durationMs,
          ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.tps_samples === undefined ? {} : { tps_samples: event.tps_samples }),
          ...(event.upstream === undefined ? {} : { upstream: event.upstream }),
        },
        occurredAt: new Date().toISOString(),
      }
      gatewayEventStore.append(foremanEvent)
      await getForemanEventBus().publish(foremanEvent)
    },
  })
  // The session feature invokes allowlisted workspace methods through this one
  // router, so the router exists before the workspace bindings are assembled.
  const rpcRouter = new RpcRouter()
  const sessionStateRoot = foremanStateRoot()
  const ipcPath = resolveWrenyardIpcPath(process.env, { config })
  // The single shared gateway connection snapshot, used by the session gateway,
  // the IPC gateway.connection surface and the environment injection below.
  const gatewayConnectionSnapshot = async (): Promise<DaemonGatewayConnection> => ({
    ...await gateway.connection(gatewayOrigin(boundPort)),
    token: gatewayToken,
  })

  // The task path reuses this same gateway/circuit (no second circuit and no
  // new persistence): a native task attempt admits its exact route once before
  // launch, reports success after a schema-validated delivery (settling a due
  // half-open probe), a route-local fault after a terminal structured-output
  // failure (settling the held probe with its backoff), and a cancelled release
  // for any other exit.
  //
  // The task route key is client-qualified (`provider/model:client`), so it is
  // its own circuit route and would not otherwise see a fault recorded on the
  // shared `provider/model` route a session call uses. Admission therefore also
  // checks the shared route first, so a pinned task or a selection-to-launch
  // race can never launch while that shared circuit still refuses the route.
  const taskRouteState: TaskRouteStateHooks = {
    admit: (provider, model, mode) => {
      const shared = blockedSharedTaskRoute(gateway, provider, model, mode)
      if (shared !== undefined) return { kind: 'blocked', status: shared }
      return gateway.admitRoute(provider, model)
    },
    success: (provider, model, guard, lease) => gateway.completeRouteSuccess(provider, model, guard, lease),
    fault: (provider, model, guard, kind, lease) => gateway.reportNativeRouteFault(provider, model, kind, guard, lease),
    cancel: (lease) => gateway.releaseNativeProbe(lease),
  }

  /**
   * One workspace-scoped binding set: the task, taskgraph, task-settings,
   * document and session services plus the scheduler for one root. Startup and
   * every hot switch assemble their bindings through this exact helper, so a
   * switched-to workspace is wired identically to a freshly started daemon and
   * no construction is duplicated.
   */
  const createBindings = async (workspaceRoot: string): Promise<WorkspaceScopedResources> => {
    // One daemon-owned TaskService backs both the task.run.* RPC surface and the
    // session feature's in-process wait/cancel. A session wait therefore observes
    // exactly the runs this daemon accepted, with no second registry.
    const taskService = new TaskService({ workspaceRoot, operations })
    // Single shared TaskGraphService used by all RPC transports.
    const taskgraphService = createTaskGraphService({
      workspaceRoot,
      operations,
      eventSink: projectTaskGraphForemanEvent,
    })
    const taskSettingsService = new TaskSettingsService({
      workspaceRoot,
      configPath: authoritativeConfigPath,
      resolver: taskDispatchResolver,
      aliases: runtimeAliasService,
      quotaSnapshots: autoRoutingQuotaSnapshots,
      // The same shared Gateway instance and route-status callable already used
      // by session and auxiliary routing: Task automatic candidates and explicit
      // availability observe the one in-memory route circuit, with no second
      // Gateway or duplicated circuit state.
      routeStatus: model => gateway.routeStatus(model),
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
        accepting: !options.isShuttingDown(),
        known: true,
      }),
      runtimeAvailability,
    })
    const workspaceDocService = new WorkspaceDocService(workspaceRoot)
    // The session feature owns the append-only ledger, the workspace document
    // surface and per-role automatic auxiliary selection. Its gateway connection and task
    // wait/cancel are injected in-process, and DSH MCP tools reach the daemon over
    // this same IPC path like every other client. The ledger is stored under a
    // workspace-hashed directory, so a new root opens a new ledger and the old
    // workspace's history stays intact on disk.
    const session = createSession(createDaemonSessionHost({
      workspaceRoot,
      stateRoot: sessionStateRoot,
      gateway: gatewayConnectionSnapshot,
      taskService,
      router: rpcRouter,
      routeStatus: model => gateway.routeStatus(model),
      beginRouteAttempt: (publicModel, attemptId) => gateway.beginRouteAttempt(publicModel, attemptId),
      reportRouteFault: (publicModel, attemptId, kind) => gateway.reportRouteFault(publicModel, attemptId, kind),
      completeRouteAttempt: (publicModel, attemptId) => gateway.completeRouteAttempt(publicModel, attemptId),
      selectAuxiliary: createAuxiliarySelector({ catalog, quotaSnapshots: autoRoutingQuotaSnapshots,
        // The Gateway model directory is the only source of per-model protocols.
        gatewayModels: async () => (await gateway.connection(gatewayOrigin(boundPort))).models,
        routeStatus: model => gateway.routeStatus(model),
        runtimeAvailability: createAuxiliaryAvailability(runtimeAvailability, catalog, providerRuntime),
        localSpeed: readLocalSpeedSamples, readSettings: () => readAuxiliaryRoutingSettings(authoritativeConfigPath) }),
      // The session's main inference validates against the same product-wired
      // catalog already injected into the gateway/provider.list surface, so a
      // CodeBuddy model is only offered after the daemon read the real install.
      resolveInferenceProvider: id => catalog.provider(id),
    }))
    // The daemon-owned scheduler persists to the same state root as the session
    // ledger and fires due schedules into that session through its in-process
    // `send`. It is workspace-scoped, so no scheduled prompt can fire into
    // another workspace's sessions. It shares the daemon's single diagnostic sink.
    const scheduler = createScheduler({
      statePath: join(sessionStateRoot, 'schedules.json'),
      session,
      workspaceRoot,
      log: writeDaemonLog,
      // Admission gate: the daemon suppresses scheduler fires while a hot switch
      // or shutdown is staging, so a suppressed scheduler cannot start a prompt
      // after isIdle was observed.
      canRun: () => !options.isShuttingDown() && options.isSwitching?.() !== true,
    })
    // The bot host shares the same workspace scope, the same in-process session
    // and the same admission gate as the scheduler, and persists into the same
    // daemon database, so a stopped bot stays stopped across a restart.
    const botHost = createBotHost({
      db: runtime.db,
      workspaceRoot,
      session,
      log: writeDaemonLog,
      canRun: () => !options.isShuttingDown() && options.isSwitching?.() !== true,
      // bot.health reports the device and daemon it runs on: hostname/platform/
      // arch from this process plus the same suite identity health.ping reports.
      identity: () => {
        const identity = readProcessIdentity()
        return {
          hostname: hostname(),
          platform: process.platform,
          arch: process.arch,
          daemonVersion: identity.version,
          mode: identity.mode,
        }
      },
      // bot.health reports the managed operation components (browser, desktop)
      // so the Bot page can show when a required component is not ready. The
      // host only ever reads the cached list, never refreshes it.
      operationComponents: runtime.operationComponents,
    })
    return {
      workspaceRoot,
      taskService,
      taskgraphService,
      taskSettingsService,
      workspaceDocService,
      session,
      scheduler,
      botHost,
    }
  }

  /** Point the core RPC options at one binding set, before re-registering routes. */
  const applyBindings = (bindings: WorkspaceScopedResources): void => {
    coreOptions.workspaceRoot = bindings.workspaceRoot
    coreOptions.taskService = bindings.taskService
    coreOptions.taskgraphService = bindings.taskgraphService
    coreOptions.taskSettings = bindings.taskSettingsService
    coreOptions.workspaceDocService = bindings.workspaceDocService
  }

  /**
   * (Re)register every workspace-scoped route against the current options and
   * bindings. `registerCoreHandlers` overwrites the task/taskgraph/task.settings/
   * project/workspace.vcs/workspace.doc/workspace.switch handlers in place, so a
   * switch rebinds the routes without a second router or a second construction.
   */
  const registerWorkspaceRoutes = (bindings: WorkspaceScopedResources): void => {
    registerCoreHandlers(rpcRouter, coreOptions)
    registerSessionHandlers(rpcRouter, { session: bindings.session })
    registerScheduleHandlers(rpcRouter, { scheduler: bindings.scheduler })
    registerBotHandlers(rpcRouter, { host: bindings.botHost })
  }

  let coreOptions: CoreRpcHandlerOptions
  let workspaceScoped = await createBindings(config.workspaceRoot)
  const providerService = new ProviderService({
    catalog, runtime: providerRuntime,
    // Live indirection: provider.list always reports the CURRENT workspace's
    // task settings, so a switch is visible without rebuilding the service.
    modelStatus: () => workspaceScoped.taskSettingsService.modelStatus(),
    localSpeed: readLocalSpeedSamples,
  })
  // Daemon-owned saved-remote-host registry backing remote.host.list/save/rename.
  // It is independent of the active workspace and persists only to the daemon
  // config, through the same atomic mode-0600 writer as every other config write.
  const remoteHostRegistry = new RemoteHostRegistryService({ configPath: authoritativeConfigPath })
  // Remote-safe workspace control backing workspace.inspect/workspace.initialize.
  // It reads the live workspace root so a hot switch is observed without ever
  // rebuilding the helper, and refuses while the daemon is pinned, switching or
  // shutting down.
  const workspaceControl = createWorkspaceControl({
    currentRoot: () => workspaceScoped.workspaceRoot,
    isPinned: () => options.workspacePinned?.() === true,
    isShuttingDown: options.isShuttingDown,
    isSwitching: () => options.isSwitching?.() === true,
  })
  coreOptions = {
    startedAt,
    workspaceRoot: config.workspaceRoot,
    operations,
    isShuttingDown: options.isShuttingDown,
    isSwitching: options.isSwitching,
    workspaceSwitch: options.workspaceSwitch,
    remoteHostRegistry,
    workspaceInspect: (root) => workspaceControl.inspect(root),
    workspaceInitialize: (root) => workspaceControl.initialize(root),
    daemonActiveWork: readDaemonActiveCounts,
    taskgraphService: workspaceScoped.taskgraphService,
    workspaceDocService: workspaceScoped.workspaceDocService,
    gatewayConnection: gatewayConnectionSnapshot,
    providerList: () => providerService.list(),
    providerConfigure: (params) => providerService.configure(params),
    providerQuota: (params) => providerService.quotaSnapshot(params),
    taskSettings: workspaceScoped.taskSettingsService,
    runtimeAlias: runtimeAliasService,
    execService: runtime.execService,
    operationComponents: runtime.operationComponents,
    operationAdapter: runtime.operationAdapter,
    taskService: workspaceScoped.taskService,
    resolveExecRequest: (params) => {
      const provider = params.provider ?? catalog.clients().find(client => client.id === params.client)?.nativeProvider
      if (!provider) throw new Error('Execution requires a provider')
      // A precise execution reasoning effort is an EXACT combination request: it
      // must be a legal public level AND be supported verbatim by the exact
      // client/provider/model route (catalog.reasoningEfforts), never silently
      // adapted downstream. Only then is the run resolved (which may still adapt
      // an omitted request to the route's highest usable level).
      const expectedReasoningEffort = params.reasoningEffort as ReasoningEffort
      if (params.reasoningEffort === undefined) throw new Error("Execution requires reasoningEffort")
      if (params.reasoningEffort !== undefined) {
        if (!(REASONING_EFFORTS as readonly string[]).includes(params.reasoningEffort)) {
          throw new Error('Invalid reasoning effort')
        }        const supported = catalog.reasoningEfforts(params.client, provider, params.model)
        if (!supported.includes(expectedReasoningEffort)) {
          throw new Error(`Reasoning effort '${expectedReasoningEffort}' is not supported by ${provider}/${params.model}`)
        }
      }
      const plan = catalog.resolveRun(params.client, provider, params.model, expectedReasoningEffort)
      if (params.mode && params.mode !== plan.mode) throw new Error('Requested mode does not match the selected client/provider')
      // The native wire spelling is owned by the provider, not by this request:
      // resolve it through the provider runtime so an explicit exec launches the
      // exact product id (e.g. canonical Claude 5 -> its `-1m` row) in every
      // environment. An explicit reasoning-effort-mapped substitution still wins,
      // and the public canonical id is preserved for the gateway/id surfaces.
      const providerDefinition = catalog.provider(provider)
      const upstreamModel = plan.upstreamModel
        ?? (providerDefinition ? providerRuntime.resolveUpstreamModel(providerDefinition, plan.model) : plan.model)
      return {
        ...params, provider, canonicalModel: plan.model,
        model: upstreamModel, mode: plan.mode, protocol: plan.protocol,
        ...(plan.reasoningEffort === undefined ? {} : { reasoningEffort: plan.reasoningEffort }),
        ...(plan.clientReasoningEffort === undefined ? {} : { clientReasoningEffort: plan.clientReasoningEffort }),
        ...(plan.clientReasoningEnvironment === undefined ? {} : { clientReasoningEnvironment: plan.clientReasoningEnvironment }),
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
    isIdle: options.isIdle,
  }
  // Bind every workspace-scoped route before anything can reach them, and hand
  // the initial scheduler to the daemon instance before the IPC server exists so
  // a shutdown that arrives during startup can still stop it. The running task
  // runner resolves execution-time settings through the current task settings
  // service (no duplicate service/resolver/provider objects, no paid probes);
  // the switch re-points the same resolver at the new workspace.
  registerWorkspaceRoutes(workspaceScoped)
  runtime.runner.setTaskSettingsResolver((params) => workspaceScoped.taskSettingsService.resolveForRun(params))
  runtime.runner.setTaskRouteState(taskRouteState)
  options.onScheduler?.(workspaceScoped.scheduler)
  options.onBotHost?.(workspaceScoped.botHost)

  // During drain, preserve status/cancel/signals and the calls required by
  // admitted work. New top-level dispatch and long polling cannot hold the
  // daemon open or create more work after the shutdown request is accepted.
  const blockedDuringShutdown = new Set([
    'taskgraph.create', 'task.run.create', 'exec.start', 'session.send',
    'bot.create', 'bot.update', 'bot.control', 'bot.delete', 'bot.tick', 'bot.item.action',
  ])
  // The same rule while a workspace hot switch holds the gate: no new admitting
  // work and no new workspace-mutating request may start, so the state swap
  // cannot be raced by an operation that captured the previous root. The switch
  // method itself is deliberately absent: a concurrent switch is refused by the
  // gate's owner with an actionable `busy` result instead of a protocol error.
  const blockedDuringSwitch = new Set([
    'taskgraph.create', 'taskgraph.patch', 'taskgraph.signal',
    'task.run.create', 'exec.start', 'session.send',
    'session.create', 'session.interrupt', 'session.delete', 'session.rename',
    'project.register', 'project.pull', 'project.push', 'project.commit',
    'project.worktree.create', 'project.worktree.remove', 'project.worktree.merge', 'project.worktree.rebase',
    'workspace.vcs.commit', 'workspace.vcs.push', 'workspace.vcs.pull',
    'workspace.doc.create', 'workspace.doc.update', 'workspace.doc.edit', 'workspace.doc.delete',
    'schedule.create', 'schedule.update', 'schedule.run', 'schedule.delete',
    'runtime.alias.put', 'runtime.alias.remove',
    'bot.create', 'bot.update', 'bot.control', 'bot.delete', 'bot.tick', 'bot.item.action',
  ])
  // In-flight requests that mutate workspace-scoped state or admit work count
  // against idleness, so a switch also waits for / refuses while a project,
  // document, VCS, session or scheduler mutation is still running. Long polling
  // (session.events with a wait) is never tracked: it would hold drain open.
  const trackedWorkMethods = [
    'taskgraph.create', 'taskgraph.patch', 'taskgraph.signal',
    'task.run.create', 'exec.start', 'session.send',
    'session.create', 'session.interrupt', 'session.delete', 'session.rename',
    'project.register', 'project.pull', 'project.push', 'project.commit',
    'project.worktree.create', 'project.worktree.remove', 'project.worktree.merge', 'project.worktree.rebase',
    'workspace.vcs.commit', 'workspace.vcs.push', 'workspace.vcs.pull',
    'workspace.doc.create', 'workspace.doc.update', 'workspace.doc.edit', 'workspace.doc.delete',
    'schedule.create', 'schedule.update', 'schedule.run', 'schedule.delete',
    'runtime.alias.put', 'runtime.alias.remove',
    'bot.create', 'bot.update', 'bot.control', 'bot.delete', 'bot.tick', 'bot.item.action',
  ]
  rpcRouter.setAdmissionGate((method, params) => {
    const longSessionPoll = method === 'session.events'
      && typeof params === 'object' && params !== null
      && 'waitMs' in params && typeof params.waitMs === 'number' && params.waitMs > 0
    if (options.isShuttingDown() && (blockedDuringShutdown.has(method) || longSessionPoll)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'Daemon is restarting and does not accept new work; retry after it is back (usually a few seconds).' },
        { code: 'daemon_shutting_down', method },
      )
    }
    if (options.isSwitching?.() === true && (blockedDuringSwitch.has(method) || longSessionPoll)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'Daemon is switching workspace and does not accept this request; retry once the switch finishes.' },
        { code: 'workspace_switch_in_progress', method },
      )
    }
  }, trackedWorkMethods)

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
    // The daemon exposes no other HTTP surface: everything outside /gateway/*
    // is not found. The public API is the owner-only IPC channel.
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'not_found' }))
  })
  // Bind one random loopback port. There is no port configuration and no
  // EADDRINUSE retry: the OS assigns a free port on 127.0.0.1:0.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  const boundAddress = httpServer.address()
  boundPort = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : 0
  const gatewayConnection = {
    ...await gateway.connection(gatewayOrigin(boundPort)),
    token: gatewayToken,
  }
  // Install the canonical task plans and the loopback gateway connection before
  // startup reconciliation so a recovered task never resolves provider/model or
  // protocol data itself.
  const restoreGatewayEnvironment = installGatewayEnvironment(gatewayConnection, dispatchPlans)

  // Begin idempotent taskgraph startup reconciliation exactly once before any
  // IPC handler or transport is exposed. Every persisted actionable graph
  // (running, cancel_requested, paused with a live node, or an unconverged
  // cancel-policy failure) recovers here instead of lazily on a later graph RPC.
  // Recovery errors stay isolated per graph and never create a second service
  // instance or a background timer.
  await workspaceScoped.taskgraphService.reconcileStartup()

  let ipcServer: IpcServer | undefined
  try {
    ipcServer = await createIpcServer({
      path: ipcPath,
      onMessage: (message) => rpcRouter.handleMessage(message, { transport: 'ipc' }),
    })
  } catch (error) {
    // Tear down every handle already built through the one shared teardown:
    // HTTP, session, gateway + environment restore, IPC (if it was created).
    // The runtime supervisor/exec/DB are owned and released by bootstrap's
    // runtime teardown after this throws. Individual failures are logged by the
    // teardown; its aggregate is swallowed so it can never replace the original
    // startup error the caller sees.
    await teardownDaemonResources({
      httpServer,
      session: workspaceScoped.session,
      gateway,
      restoreGatewayEnvironment,
      ipcServer,
    }).catch(() => {})
    throw error
  }
  if (!ipcServer) throw new Error('failed to start IPC server')
  const runningIpcServer = ipcServer
  // Begin scheduled-prompt polling only after the IPC server is listening, so
  // the scheduler never fires into a session whose clients cannot reach it yet.
  // A shutdown requested during startup skips start entirely: no interval is
  // armed and the stopped scheduler stays stopped.
  if (!options.isShuttingDown()) await workspaceScoped.scheduler.start()
  // Begin bot polling only after the IPC server is listening too, for the same
  // reason: a bot step must never drive a session no client can reach yet.
  if (!options.isShuttingDown()) await workspaceScoped.botHost.start()

  /**
   * Rebind every workspace-scoped resource to a new root and persist the
   * authoritative workspace.root. Ordering is staging-first: the complete new
   * binding set is built, the previous scheduler is flushed and the new snapshot
   * prepared (no schedule fires), shutdown/idleness are rechecked, then the config
   * is written, the live handles and routes are swapped, the previous workspace
   * is retired, and only then does the new scheduler tick. A failure before the
   * swap discards the staged bindings and leaves the previous root and config
   * usable. Staging the target session may begin (or resume interrupting) stale
   * ledger recovery for the target workspace, so the pre-publish guard also
   * refuses while a target turn is running or recovering — that recovery work
   * never crosses the publish boundary. The process, instance lock, DB,
   * execution runtime, gateway and IPC endpoint are never touched.
   */
  async function rebindWorkspace(requestedRoot: string): Promise<WorkspaceSwitchResult> {
    let targetRoot: string
    try {
      targetRoot = await resolveWorkspaceSwitchTarget(requestedRoot)
    } catch (error) {
      return { ok: false, outcome: 'invalid', message: error instanceof Error ? error.message : String(error) }
    }
    const previous = workspaceScoped
    if (previous.workspaceRoot === targetRoot) {
      return { ok: true, outcome: 'switched', workspace_root: targetRoot }
    }
    // Stage the new bindings without publishing them: routes and admission still
    // point at the live set, so this admits no work and fires no schedule.
    const staged = await createBindings(targetRoot)
    try {
      // Flush the previous scheduler before the staged one reads the shared state
      // file, so no recent mutation or legacy association is lost or misassigned,
      // then load the new snapshot without firing any schedule.
      await previous.scheduler.flush()
      await staged.scheduler.prepare()
      // The bot host holds no state file, but it is flushed and prepared for the
      // same reason as the scheduler: no bot step may fire during the swap, and
      // the staged host must be ready before it is published.
      await previous.botHost.flush()
      await staged.botHost.prepare()
    } catch (error) {
      await teardownWorkspaceBindings(staged)
      return {
        ok: false,
        outcome: 'error',
        message: `工作区切换准备失败，已保留原工作区：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // Recheck after every await: a shutdown or newly admitted work that appeared
    // during staging must refuse the switch instead of being published over.
    if (options.isShuttingDown()) {
      await teardownWorkspaceBindings(staged)
      return { ok: false, outcome: 'shutting_down', message: 'Daemon 正在关闭，无法切换工作区' }
    }
    if (options.isIdle && !(await options.isIdle())) {
      await teardownWorkspaceBindings(staged)
      return { ok: false, outcome: 'busy', message: '后台仍有任务或正在维护，请完成后再切换工作区' }
    }
    // The staged target session may itself be running stale-ledger recovery: a
    // target turn in flight must not be cancelled across the publish, so refuse
    // before the config write. Recheck shutdown synchronously one last time now
    // that the final await has returned, so nothing new is admitted here.
    if (options.isShuttingDown()) {
      await teardownWorkspaceBindings(staged)
      return { ok: false, outcome: 'shutting_down', message: 'Daemon 正在关闭，无法切换工作区' }
    }
    if (staged.session.hasRunningTurns()) {
      await teardownWorkspaceBindings(staged)
      return { ok: false, outcome: 'busy', message: '目标工作区仍有正在运行的会话，请完成后再切换工作区' }
    }
    try {
      // Publish only the authoritative root, and only once staging succeeded: a
      // failed write leaves the previous config untouched.
      persistWorkspaceRoot(authoritativeConfigPath, targetRoot)
    } catch (error) {
      await teardownWorkspaceBindings(staged)
      return {
        ok: false,
        outcome: 'error',
        message: `工作区配置写入失败，已保留原工作区：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // Publish synchronously — no await between here and the swap, so no request
    // observes a half-switched daemon. The previous scheduler is still alive but
    // its admission callback suppresses ticks while the switch gate is held.
    workspaceScoped = staged
    applyBindings(staged)
    registerWorkspaceRoutes(staged)
    // The running task runner resolves execution-time settings through the
    // current task settings service, exactly like bootstrap wires it.
    runtime.runner.setTaskSettingsResolver((params) => staged.taskSettingsService.resolveForRun(params))
    runtime.runner.setTaskRouteState(taskRouteState)
    resources.session = staged.session
    resources.scheduler = staged.scheduler
    resources.botHost = staged.botHost
    resources.taskService = staged.taskService
    resources.taskgraphService = staged.taskgraphService
    options.onScheduler?.(staged.scheduler)
    options.onBotHost?.(staged.botHost)
    // Retire the previous workspace before enabling new ticks: its scheduler
    // stops and its workspace-hashed session ledger is closed (history stays on
    // disk), so the old and new writers never overlap.
    await teardownWorkspaceBindings(previous)
    // Enable the staged scheduler's polling only now that the old writer is gone.
    // The switch has already published, so a start failure is logged and never
    // reported as a retained old workspace.
    if (!options.isShuttingDown()) {
      try {
        await staged.scheduler.start()
      } catch (error) {
        writeDaemonLog('warn', 'scheduler failed to start after workspace switch', error)
      }
      try {
        await staged.botHost.start()
      } catch (error) {
        writeDaemonLog('warn', 'bot host failed to start after workspace switch', error)
      }
    }
    return { ok: true, outcome: 'switched', workspace_root: targetRoot }
  }

  // Lifecycle (shutdown latch, drain waits, close) lives on the ForemanDaemon
  // instance; this helper only returns the assembled resources. session /
  // scheduler / taskService / taskgraphService are replaced by rebindWorkspace,
  // so close() and the resource getters always observe the current workspace.
  const resources: ForemanDaemonResources = {
    runtime,
    httpServer,
    ipcPath,
    ipcServer: runningIpcServer,
    gateway,
    session: workspaceScoped.session,
    scheduler: workspaceScoped.scheduler,
    botHost: workspaceScoped.botHost,
    rpcRouter,
    taskService: workspaceScoped.taskService,
    taskgraphService: workspaceScoped.taskgraphService,
    restoreGatewayEnvironment,
    rebindWorkspace,
  }
  return resources
}

/**
 * Detect whether the daemon's effective workspace root is pinned outside the
 * config by the launch environment: an explicit `WRENYARD_WORKSPACE`, or the
 * `--work-dir` CLI flag (which the bootstrap applies on top of the loaded
 * config, so the effective root no longer matches the root the config alone
 * declares). A pinned root is owned by whoever launched the process, so the
 * in-process switch refuses with an explicit reason instead of fighting the pin.
 */
function detectWorkspacePinSource(
  configPath: string | undefined,
  config: ForemanServiceConfig,
): 'environment' | 'cli' | undefined {
  if (process.env.WRENYARD_WORKSPACE?.trim()) return 'environment'
  try {
    const manager = new ForemanConfigManager()
    const resolvedPath = manager.resolvePath(configPath)
    const declared = manager.loadUserData(configPath).data.workspace?.root
    const declaredRoot = typeof declared === 'string' && declared.trim()
      ? (isAbsolute(declared.trim()) ? resolve(declared.trim()) : resolve(dirname(resolvedPath), declared.trim()))
      // No config-declared root: the config alone resolves the root to the
      // config directory (normalizeForemanServiceConfig's fallback).
      : resolve(dirname(resolvedPath))
    return resolve(config.workspaceRoot) === declaredRoot ? undefined : 'cli'
  } catch {
    // An unreadable config cannot prove the root is unpinned; leave it
    // unpinned so a read hiccup does not disable the switch on a live daemon.
    return undefined
  }
}

/**
 * Resolve and validate a requested workspace root for the hot switch.
 *
 * The workspace identity is the *lexical* absolute path (`resolve`), exactly
 * the identity the boot config root already has (`normalizeForemanServiceConfig`
 * resolves `workspace.root` with `resolve`) and the identity the session-ledger
 * and scheduler keys are hashed from. `realpath` is used only to prove the
 * target exists and is a directory; it must never become the persisted or
 * ledger key. Canonicalizing a symlink would give one workspace two identities:
 * on macOS `/tmp` is a symlink to `/private/tmp`, so realpathing a re-selected
 * `/tmp/... ` root would rewrite `workspace.root` to `/private/tmp/...`, open a
 * second, empty ledger directory under that hash, and hide the workspace's
 * existing session history and schedules still stored under the lexical key.
 */
async function resolveWorkspaceSwitchTarget(requested: string): Promise<string> {
  const trimmed = typeof requested === 'string' ? requested.trim() : ''
  if (!trimmed) throw new Error('请输入 workspace 路径')
  // Lexical absolute form: normalize `.`/`..` against the cwd without following
  // symlinks, so it stays identical to the boot binding and the ledger key.
  const lexical = resolve(trimmed)
  let real: string
  try {
    real = await realpath(lexical)
  } catch {
    throw new Error(`工作区目录不存在：${trimmed}`)
  }
  if (!(await stat(real)).isDirectory()) {
    throw new Error(`工作区路径不是目录：${lexical}`)
  }
  return lexical
}

/**
 * Persist the authoritative `workspace.root` through the one config writer,
 * which writes atomically (temp file plus rename), so a failure never leaves a
 * partially written config behind.
 */
function persistWorkspaceRoot(configPath: string, root: string): void {
  updateForemanConfigData(configPath, (data) => {
    data.workspace = { ...(data.workspace ?? {}), root }
  })
}

/**
 * Retire one workspace's session and scheduler. The scheduler stops first so no
 * late fire starts a turn in the session being closed; both failures are logged
 * rather than thrown, because the switch has already published its new state.
 */
async function teardownWorkspaceBindings(bindings: WorkspaceScopedResources): Promise<void> {
  try {
    bindings.scheduler.stop()
  } catch (error) {
    writeDaemonLog('warn', 'workspace scheduler shutdown failed', error)
  }
  try {
    bindings.botHost.stop()
  } catch (error) {
    writeDaemonLog('warn', 'workspace bot host shutdown failed', error)
  }
  try {
    await bindings.session.close()
  } catch (error) {
    writeDaemonLog('warn', 'workspace session shutdown failed', error)
  }
}

/** Project one taskgraph event onto the shared Foreman event bus. */
function projectTaskGraphForemanEvent(event: import('../core/taskgraph/index.mts').TaskGraphEvent): Promise<void> {
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
  session?: Session
  /** Stopped before the session so no scheduled fire starts a new turn during teardown. */
  scheduler?: Scheduler
  /** Stopped with the scheduler so no bot step starts during teardown. */
  botHost?: BotHost
  gateway?: ModelGateway
  restoreGatewayEnvironment?: () => void
  ipcServer?: IpcServer
  supervisor?: AgentExecutionSupervisor
  execService?: ExecService
  /** Released after the HTTP close settles; set only by whoever retained the DB. */
  releaseDb?: () => void
}

/**
 * The single resource teardown shared by normal close and both partial-start
 * failure paths. Every supplied handle is attempted exactly once in the one
 * canonical order (HTTP close start, scheduler, session, gateway + environment
 * restore, IPC, supervisor, exec, await HTTP, DB release). Each failure is logged;
 * every remaining handle still runs, and the first failure is thrown once all handles
 * were attempted so the normal path can surface it.
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
  // Stop the scheduler before the session closes: a late fire must not start a
  // new turn while the ledger and providers are being torn down.
  if (handles.scheduler) {
    try {
      handles.scheduler.stop()
    } catch (error) {
      recordFailure('scheduler shutdown failed', error)
    }
  }
  // Stop the bot host at the same point: a late bot step must not start a new
  // turn while the ledger and providers are being torn down.
  if (handles.botHost) {
    try {
      handles.botHost.stop()
    } catch (error) {
      recordFailure('bot host shutdown failed', error)
    }
  }
  // Stop the session backend immediately after: it owns the append-only ledger
  // and the workspace documents it writes, and must not observe a closed
  // gateway or a torn-down supervisor.
  if (handles.session) {
    try {
      await handles.session.close()
    } catch (error) {
      recordFailure('session shutdown failed', error)
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

function gatewayOrigin(port: number): string {
  // The gateway only ever listens on loopback; the URL is built from the actual
  // bound port so injected env and IPC connections never guess a fixed port.
  return `http://127.0.0.1:${port}`
}

/**
 * The shared `provider/model` route health a task's client-qualified route key
 * must also clear before it launches, or undefined when that shared route is
 * healthy (or the key is not canonical run syntax, leaving only the exact task
 * circuit). The client suffix is stripped through the same parser that produced
 * the key, never by re-splitting the public string.
 *
 * An open shared route blocks admission with its own status before the attempt
 * launches. A half-open shared route blocks a native attempt regardless of due
 * time, because a native task cannot run the Gateway's HTTP recovery probe; a
 * Gateway-mode attempt keeps the due half-open behavior so the actual HTTP
 * pipeline can lease and recover that shared health. This guard only refuses:
 * it never acquires a probe lease, and the shared route-scoped fault is never
 * cleared by the exact-route settlement the task performs below.
 */
function blockedSharedTaskRoute(
  gateway: ModelGateway,
  provider: string,
  model: string,
  mode: 'native' | 'gateway' | undefined,
): RouteStatus | undefined {
  let parsed: ReturnType<typeof parseRunSyntax>
  try {
    parsed = parseRunSyntax(`${provider}/${model}`)
  } catch {
    return undefined
  }
  const shared = gateway.routeStatus(`${provider}/${parsed.model}`)
  if (shared === undefined || shared.phase === 'closed') return undefined
  if (shared.phase === 'open') return shared
  // Half-open: only a Gateway-mode attempt may rely on the bounded HTTP probe.
  if (mode !== 'gateway') return shared
  const probeMs = Date.parse(shared.nextProbeAt ?? shared.until)
  return Number.isFinite(probeMs) && probeMs > Date.now() ? shared : undefined
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

interface ForemanDaemonRuntime {
  db: ForemanDatabase
  repoWriteLocks: RepoWriteLocks
  supervisor: AgentExecutionSupervisor
  runner: TaskWorkflowRunner
  /** Shared raw prompt-execution service consumed by the RPC surface and tasks. */
  execService: ExecService
  /** Machine-local operation component manager (agent-browser CLI, Cua Driver). */
  operationComponents: OperationComponents
  /** Single execution boundary that resolves operation components per run. */
  operationAdapter: OperationAdapter
  catalog: import('@wrenyard/providers/catalog').Catalog
  providerRuntime: import('@wrenyard/providers').ProviderRuntime
  /** Canonical task dispatch plans keyed by provider/model:client targets. */
  dispatchPlans: Readonly<Record<string, import('@wrenyard/providers/catalog').DispatchPlan>>
  taskDispatchResolver: TaskDispatchResolver
}

async function bootstrapForemanDaemonRuntime(): Promise<ForemanDaemonRuntime> {
  const db = initDb()
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
  // One CodeBuddy install read supplies the public product facts, and the
  // private account context the provider binds to its credential is re-read
  // from the CodeBuddy auth file on every credential use, so a rotated token is
  // picked up without restarting the daemon.
  const codeBuddyClient = new CodeBuddyClient()
  const install = await codeBuddyClient.readInstall()
  const codeBuddy = createCodeBuddy({
    product: {
      status: install.product.status,
      environment: install.product.environment,
      entries: install.product.entries,
      ...(install.product.identity ? { identity: install.product.identity } : {}),
      ...(install.account ? { account: install.account } : {}),
    },
    account: () => codeBuddyClient.readAccountContext(install.product.environment),
  })
  const catalog = createBuiltinCatalog([codeBuddy])
  const providerRuntime = createBuiltinProviderRuntime({
    providers: [codeBuddy],
    // The ChatGPT subscription gateway credential is read and refreshed through
    // the existing Codex native auth path (honoring the native CODEX_HOME or the
    // user home); the providers package authors no login of its own.
    codexGatewayAuth: {
      read: () => readCodexGatewayCredential(),
      refresh: (credential, signal) => refreshCodexGatewayCredential(credential, { signal }),
    },
  })
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
    // the CLI, and the task supervisor. It owns a single client map, so a
    // structured task attempt and an explicit `wrenyard exec` share the exact
    // same launch path and shutdown handling. The service runs resolved clients
    // with direct MCP servers and prompts supplied by the operation adapter; no
    // credential or environment value crosses the public IPC surface.
    const execService = new ExecService({
      clients: createAgentClients(),
    })
    const operationComponents = new OperationComponents({
      stateRoot: foremanStateRoot(),
      log: (message) => writeDaemonLog('warn', message),
    })
    const operationAdapter = new OperationAdapter(operationComponents)
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      logger: createDaemonSupervisorLogger(),
      catalog,
      execService,
      operations: operationAdapter,
    })
    const runner = new TaskWorkflowRunner({
      db,
      agentExecutionHost: supervisor,
      logger: createDaemonSupervisorLogger(),
      taskDispatchResolver,
    })
    await supervisor.markInterruptedOnStartup()
    setAgentExecutionSupervisor(supervisor)
    setTaskWorkflowRunner(runner)

    return { db, repoWriteLocks, supervisor, runner, execService, operationComponents, operationAdapter, catalog, providerRuntime, dispatchPlans, taskDispatchResolver }
  } catch (error) {
    releaseDaemonDb()
    throw error
  }
}

/**
 * Authoritative active-work counts read directly from the database. Shared by
 * `daemon.status` and the idle/drain checks so both observe the same rows.
 */
function readDaemonActiveCounts(): {
  activeTaskCount: number
  activeWorkflowCount: number
  activeExecutionCount: number
  activeTaskGraphCount: number
} {
  const tasks = dbQuery<{ id: string }>(`SELECT id FROM tasks WHERE status IN ('queued', 'running')`)
  const workflows = dbQuery<{ id: string }>(`SELECT id FROM workflows WHERE status IN ('running')`)
  const executions = dbQuery<{ id: string }>(`SELECT id FROM executions WHERE status IN ('queued', 'starting', 'running')`)
  // The real taskgraph count, not the legacy workflow count above. Uses the
  // exact same condition isIdle() applies to decide a taskgraph run is still
  // active: running, cancel requested, paused on a running node, or paused and
  // about to fail-cancel.
  const taskgraphs = dbQuery<{ id: string }>(
    `SELECT DISTINCT r.id FROM taskgraph_run r
     LEFT JOIN taskgraph_node_state n ON n.taskgraph_id = r.id
     WHERE r.state = 'running' OR r.cancel_requested = 1
        OR (r.state = 'paused' AND n.state = 'running')
        OR (r.state = 'paused' AND r.on_node_failure = 'cancel' AND n.state = 'failed')`,
  )
  return {
    activeTaskCount: tasks.length,
    activeWorkflowCount: workflows.length,
    activeExecutionCount: executions.length,
    activeTaskGraphCount: taskgraphs.length,
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The daemon's single diagnostic sink: every runtime line goes to the terminal
 * and to the daemon's own `<state>/logs/daemon.log`, so an owner that captured
 * neither stream can still read what the running daemon reported. Factored here
 * so the bootstrap's startup lines and every runtime diagnostic share exactly
 * one implementation. The file write is best effort; the terminal stream is
 * authoritative.
 */
export function writeDaemonLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const suffix = meta === undefined ? '' : ` ${formatLogMeta(meta)}`
  const line = `[foreman-daemon] ${level}: ${message}${suffix}\n`
  process.stderr.write(line)
  try {
    const logPath = join(foremanStateRoot(), 'logs', 'daemon.log')
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, line, 'utf-8')
  } catch {
    // The log file is best effort; the terminal stream is authoritative.
  }
}

function formatLogMeta(meta: unknown): string {
  if (meta instanceof Error) return meta.stack ?? meta.message
  try {
    return JSON.stringify(meta) ?? String(meta)
  } catch {
    return String(meta)
  }
}
