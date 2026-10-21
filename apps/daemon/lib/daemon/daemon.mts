import { createRoutingAvailability, createAuxiliaryAvailability } from './services/model-routing-availability.mts'
import {
  excludedModelIdsFor,
  selectRoutesByRequirement,
  type GatewayHealthWindowLike,
  type SelectorInputPort,
} from '@wrenyard/auto-routing'
import { ROLE_ROUTE_REQUIREMENTS } from '@wrenyard/session'
import { BOT_ROUTING_REQUIREMENT } from './services/bot-agents/routing.mts'
import { readAuxiliaryRoutingSettings } from '../config/task-settings.mts'
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { hostname } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { closeDb, getDb, initDb, query as dbQuery, setSlowQueryLogger } from '../db/connection.mts'
import { ensureIncrementalAutoVacuum } from '../db/auto-vacuum-convert.mts'
import { dropTaskRunTelemetryRetiredColumns } from '../db/schema.mts'
import type { ForemanDatabase } from '../db/types.mts'
import { WorkflowRunStore } from '../db/stores/workflow-run-store.mts'
import type { OperationHost } from '../core/operations/types.mts'
import type { ForemanServiceConfig, GatewayPortMode } from '../config/index.mts'
import { loadForemanGatewayConfig } from '../config/reader.mts'
import { updateForemanConfigData, updateForemanGatewayConfig } from '../config/writer.mts'
import { RpcRouter } from '../server/rpc-router.mts'
import { startEventLoopDelayMonitor } from '../server/event-loop-monitor.mts'
import { registerCoreHandlers, readProcessIdentity, type CoreRpcHandlerOptions, type DaemonActiveWorkCounts } from '../server/handlers/core.mts'
import { createIpcServer, type IpcServer } from '../control/ipc-server.mts'
import { registerSessionHandlers } from '../server/handlers/session.mts'
import { registerRoutineHandlers } from '../server/handlers/routine.mts'
import { registerAgentHandlers } from '../server/handlers/agent.mts'
import { INVALID_PARAMS, ProtocolError } from '../protocol/errors.mts'
import { GATEWAY_TOKEN_REPLACEMENT_WARNING } from '../protocol/methods/gateway.mts'
import type { TaskSettingsLayer } from '../protocol/methods/task.mts'
import { drainManagedCleanup, resetManagedCleanupShutdown, runManagedCleanup, stopManagedCleanup } from '../core/storage/cleanup.mts'
import type {
  GatewaySettingsResult,
  GatewaySettingsSaveParams,
  GatewaySettingsSaveResult,
  WorkspaceSwitchResult,
} from '../protocol/registry.mts'
import { TaskService, isTaskRunRejection } from '../core/task/service.mts'
import { createSession, createWorkspaceMemory, resolveModelMetadata, type Session } from '@wrenyard/session'
import { resolveWrenyardIpcPath } from '@wrenyard/control'
import { createDaemonSessionHost } from './services/session-host.mts'
import { createScheduler, type Scheduler } from './services/scheduler.mts'
import { migrateDeviceBots } from './services/bot-agents/device-migration.mts'
import { createBotAgentKernel, type AgentModelRoute, type BotAgentKernel } from './services/bot-agents/kernel.mts'
import { setAgentExecutionSupervisor } from '../core/operations/primitives/agent.mts'
import { setTaskWorkflowRunner } from '../core/operations/primitives/runner.mts'
import { AgentExecutionSupervisor, type SupervisorLogger } from './execution/agent-supervisor.mts'
import { TaskWorkflowRunner } from './execution/task-workflow-runner.mts'
import { createTaskOutputModelCallPort } from './execution/task-output-model-call.mts'
import { createTaskRunOutputCompiler, type TaskRunOutputCompiler } from '../core/task/output-compile.mts'
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
import { createAgentClients, CodeBuddyClient, readCodexGatewayCredential, refreshCodexGatewayCredential, readCodexModels, type AgentClient, type NativeClientReadiness } from '@wrenyard/clients'
import { findExecutable } from '@wrenyard/agent-client'
import { compareVersions, isSemver } from '@wrenyard/protocol/update-feed'
import type { ClientAction, ClientListEntry, ClientListHost, ClientListParams, ClientReadiness } from '../protocol/methods/client.mts'
import { ExecService } from '@wrenyard/exec'
import { ProviderService } from '@wrenyard/provider-service'
import { OperationComponents } from './services/operation-components.mts'
import { desktopLane, OperationAdapter } from './execution/operation-adapter.mts'
import { RemoteHostRegistryService } from '../remote/host-registry.mts'
import { createWorkspaceControl } from './services/workspace-control.mts'
import { ForemanConfigManager } from '../config/manager.mts'
import { getForemanEventBus } from '../events/event-bus.mts'
import { initializeLocalSpeedSamples, readLocalSpeedSamplesCached, updateLocalSpeedSample } from '../events/tps.mts'
import { startStatsDayCacheBackgroundSealer, stopStatsDayCacheBackgroundSealer } from '../events/stats-query.mts'
import type { ForemanEvent, ForemanEventKind, ForemanEventSeverity } from '../events/event-types.mts'
import { WorkspaceDocService } from './services/workspace-doc-service.mts'
import { WorkspaceTodoService, todoIndexPath } from './services/workspace-todo-service.mts'
import {
  classifyRouteFailure,
  createModelGateway,
  type GatewayHealthCompletionInput,
  type GatewayHealthOutcome,
  type ModelGateway,
  type RouteStatus,
} from '@wrenyard/gateway'
import { deriveTaskDispatchPlans, createBuiltinCatalog, createBuiltinProviderRuntime, createCodeBuddy, createDevin, createOpenCodeZen, createWorkBuddyProviders, resolveHistoricalOfferedModelId, type WorkBuddyProvider, type CodeBuddy } from '@wrenyard/providers'
import {
  defaultProviderContext,
  pollWorkBuddyBrowserToken,
  resolveWorkBuddySession,
  startWorkBuddyBrowserAuth,
} from '../../../../packages/providers/src/workbuddy/credentials.ts'
import { AUTH_POLL_TIMEOUT_MS } from '../../../../packages/providers/src/workbuddy/protocol.ts'
import { WORKBUDDY_BUILDS, type WorkBuddyBuildId } from '../../../../packages/providers/src/workbuddy/definition.ts'
import { REASONING_EFFORTS, parseRunSyntax, type ReasoningEffort } from '@wrenyard/providers/catalog'
import { PROVIDER_DEFAULT_REASONING } from '@wrenyard/providers/base'
import { createTaskDispatchResolver, type TaskDispatchResolver } from '@wrenyard/task'
import { ForemanEventStore } from '../events/event-store.mts'
import { foremanStateRoot } from '../config/state.mts'
import { resolveWrenyardConfigRoot } from '@wrenyard/paths'
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises'

/** A small single-flight cache whose freshness starts when a fill completes. */
function createAsyncSnapshotCache<T>(ttlMs: number) {
  let cached: { value: T; completedAt: number } | undefined
  let pending: { generation: number; promise: Promise<T> } | undefined
  let generation = 0
  return {
    read(loader: () => Promise<T>): Promise<T> {
      if (cached !== undefined && Date.now() - cached.completedAt < ttlMs) return Promise.resolve(cached.value)
      if (pending !== undefined) return pending.promise
      const fillGeneration = generation
      const promise = loader().then(value => {
        if (fillGeneration === generation) cached = { value, completedAt: Date.now() }
        return value
      }).finally(() => {
        if (pending?.promise === promise) pending = undefined
      })
      pending = { generation: fillGeneration, promise }
      return promise
    },
    invalidate(): void {
      generation += 1
      cached = undefined
      pending = undefined
    },
  }
}

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
  /** Daemon-owned bot agent kernel; stopped with the scheduler so no bot turn
   *  starts during drain or a workspace switch. */
  botAgents: BotAgentKernel
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
  /** The workspace root sessions use; updates after an in-process switch. */
  currentWorkspaceRoot: () => string
}

interface LowDiskState { status: 'ok' | 'low' | 'unavailable'; availableBytes: number | null; minimumBytes: number; error: string | null }
let lowDiskStateForProcess: LowDiskState = { status: 'unavailable', availableBytes: null, minimumBytes: minimumFreeDiskBytes(), error: 'Initial state-volume sample has not completed' }

/** Workspace-key hash used to scope per-workspace daemon state directories. */
function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function minimumFreeDiskBytes(): number {
  const raw = process.env.WRENYARD_MIN_FREE_DISK_BYTES
  if (raw === undefined) return 3 * 1024 ** 3
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0) throw new Error('WRENYARD_MIN_FREE_DISK_BYTES must be a non-negative safe integer')
  return Number(raw)
}

/** The workspace-scoped services one root owns; replaced whole on a switch. */
interface WorkspaceScopedResources {
  workspaceRoot: string
  taskService: TaskService
  taskgraphService: TaskGraphService
  taskSettingsService: TaskSettingsService
  workspaceDocService: WorkspaceDocService
  workspaceTodoService: WorkspaceTodoService
  session: Session
  scheduler: Scheduler
  /** Bot agent kernel for this workspace; replaced whole on a hot switch. */
  botAgents: BotAgentKernel
  /** Runs the task-output compile step for one existing run of this workspace. */
  taskOutputCompile: TaskRunOutputCompiler
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
  /** Bot agent kernel held outside resources for the same reason as the scheduler. */
  private botAgents: BotAgentKernel | undefined
  private readonly lockPath: string
  private lockHeld = false
  private lowDiskState: LowDiskState = lowDiskStateForProcess
  private lowDiskTimer: ReturnType<typeof setInterval> | undefined
  private dbCleanupTimer: ReturnType<typeof setInterval> | undefined
  private memoryConsolidationInitialTimer: ReturnType<typeof setTimeout> | undefined
  private memoryConsolidationTimer: ReturnType<typeof setInterval> | undefined
  private stopEventLoopMonitor: (() => void) | undefined

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
      await mkdir(foremanStateRoot(), { recursive: true })
      runtime = await bootstrapForemanDaemonRuntime()
      await this.sampleLowDisk()
      this.lowDiskTimer = setInterval(() => { void this.sampleLowDisk() }, 30_000)
      this.lowDiskTimer.unref?.()
      // A daemon started again in the same process must be able to admit and
      // schedule cleanup after a previous close stopped it.
      resetManagedCleanupShutdown()
      // Serialized low-frequency database retention pass; runManagedCleanup
      // serializes concurrent invocations internally, so this can never race
      // an RPC-triggered run. Failures are logged, never fatal.
      this.dbCleanupTimer = setInterval(() => {
        void runManagedCleanup({ categories: ['database'], trigger: 'scheduled' }).catch((error: unknown) => {
          writeDaemonLog('warn', 'scheduled database cleanup failed', error)
        })
      }, DB_CLEANUP_INTERVAL_MS)
      this.dbCleanupTimer.unref?.()
      // Per-method attribution: synchronous slow queries and event-loop delay
      // are reported through the one daemon log sink until close() clears them.
      setSlowQueryLogger((info) => writeDaemonLog('warn', 'slow synchronous query', info))
      this.stopEventLoopMonitor = startEventLoopDelayMonitor({ log: writeDaemonLog })
      this.resources = await createForemanDaemonResources(this.config, runtime, {
        configPath: this.configPath,
        requestShutdown: this.requestShutdown,
        isIdle: (counts) => this.isIdle(counts),
        isShuttingDown: () => this.shutdownRequestedFlag,
        isSwitching: () => this.switching,
        workspaceSwitch: (root) => this.switchWorkspace(root),
        workspacePinned: () => this.workspacePinSource !== undefined,
        onScheduler: (scheduler) => { this.scheduler = scheduler },
        onBotAgents: (botAgents) => { this.botAgents = botAgents },
        lowDiskState: () => this.lowDiskState,
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
    if (resources) {
      this.scheduleWorkspaceMemoryConsolidation(() => resources.currentWorkspaceRoot())
      void this.broadcastSuiteVersionChange().catch(() => {})
    }
    if (resources && this.onStarted) this.onStarted({ ipcPath: resources.ipcPath })
  }

  /**
   * Best-effort startup record of a suite-version change. The first start on a
   * state root only writes the baseline; a later start on a different version
   * broadcasts a real condition change before rewriting the stamp.
   */
  private async broadcastSuiteVersionChange(): Promise<void> {
    const resources = this.resources
    if (!resources) return
    const version = readProcessIdentity().version
    const stampPath = join(foremanStateRoot(), 'dispatch-condition', 'suite-version')
    let previous: string | undefined
    try {
      previous = (await readFile(stampPath, 'utf8')).trim()
    } catch {
      previous = undefined
    }
    if (previous === undefined || previous === '') {
      try {
        await mkdir(dirname(stampPath), { recursive: true, mode: 0o700 })
        await writeFile(stampPath, `${version}\n`, { mode: 0o600 })
      } catch (error) {
        writeDaemonLog('warn', 'suite version baseline write failed', error)
      }
      return
    }
    if (previous === version) return
    try {
      await writeFile(stampPath, `${version}\n`, { mode: 0o600 })
    } catch (error) {
      writeDaemonLog('warn', 'suite version stamp write failed', error)
    }
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
    // scheduler the instance was handed.
    this.scheduler?.stop()
    void this.botAgents?.stop()
    // Runs still queued for the desktop lane must not start while the drain
    // finalises: close the lane so their admission fails instead of handing
    // them ownership when the current holder releases.
    desktopLane.close()
    stopStatsDayCacheBackgroundSealer()
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
  async isIdle(counts?: DaemonActiveWorkCounts): Promise<boolean> {
    const resources = this.resources
    if (!resources) return false
    const activeCounts = counts ?? readDaemonActiveCounts()
    return activeCounts.activeTaskCount === 0
      && activeCounts.activeWorkflowCount === 0
      && activeCounts.activeExecutionCount === 0
      && (activeCounts.activeTaskGraphCount ?? 0) === 0
      && !resources.session.hasRunningTurns()
      // An in-flight scheduler tick is work in progress: a switch must not stage
      // over a schedule that is mid-fire.
      && !resources.scheduler.ticking
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
   * Non-blocking workspace memory consolidation: one delayed pass after attach,
   * then on a fixed interval. Failures are logged only; timers are unref'd and
   * cleared on close().
   */
  private scheduleWorkspaceMemoryConsolidation(workspaceRoot: () => string | undefined): void {
    if (this.memoryConsolidationInitialTimer) clearTimeout(this.memoryConsolidationInitialTimer)
    this.memoryConsolidationInitialTimer = undefined
    if (this.memoryConsolidationTimer) clearInterval(this.memoryConsolidationTimer)
    this.memoryConsolidationTimer = undefined

    const runPass = (): void => {
      const root = workspaceRoot()
      if (root === undefined) return
      void createWorkspaceMemory(root).consolidate().then((report) => {
        writeDaemonLog('info', 'workspace memory consolidation', {
          merged: report.merged.length,
          mergedNames: report.merged.slice(0, MEMORY_CONSOLIDATION_LOG_NAME_LIMIT),
          pruned: report.pruned.length,
          prunedNames: report.pruned.slice(0, MEMORY_CONSOLIDATION_LOG_NAME_LIMIT),
          indexRebuilt: report.indexRebuilt,
        })
      }).catch((error: unknown) => {
        writeDaemonLog('warn', 'workspace memory consolidation failed', error)
      })
    }

    this.memoryConsolidationInitialTimer = setTimeout(() => {
      this.memoryConsolidationInitialTimer = undefined
      runPass()
    }, MEMORY_CONSOLIDATION_INITIAL_DELAY_MS)
    this.memoryConsolidationInitialTimer.unref?.()
    this.memoryConsolidationTimer = setInterval(runPass, MEMORY_CONSOLIDATION_INTERVAL_MS)
    this.memoryConsolidationTimer.unref?.()
  }

  /**
   * Waits for admitted work to finish by polling isIdle() every 200ms until the
   * daemon is idle, an explicit force skips the wait, or the drain exceeds
   * SHUTDOWN_DRAIN_TIMEOUT_MS. On timeout the drain escalates to force so the
   * caller cancels active work instead of waiting forever. Never closes the
   * daemon. A force takes effect within one 200ms tick.
   */
  async drain(): Promise<void> {
    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS
    while (!this.shutdownForce && this.resources && !(await this.isIdle())) {
      if (Date.now() >= deadline) {
        writeDaemonLog('warn', `shutdown drain exceeded ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms; cancelling active work`)
        this.shutdownForce = true
        break
      }
      await sleep(200)
    }
  }

  /**
   * Forced-shutdown step run once drain has been skipped or escalated. Settles
   * live agent executions as interrupted with kill_reason shutdown (same as
   * graceful close), then interrupts remaining admitted task rows, closes
   * sessions, and cancels active task graphs. Failures are logged rather than
   * aborting teardown so close() still runs. Normal (non-forced) shutdown never
   * calls this.
   */
  private async cancelActiveWork(): Promise<void> {
    const resources = this.resources
    if (!resources) return
    try {
      await resources.runtime.supervisor.shutdown()
    } catch (error) {
      writeDaemonLog('warn', 'supervisor forced shutdown settlement failed', error)
    }
    try {
      await resources.taskService.interruptActive()
    } catch (error) {
      writeDaemonLog('warn', 'task force interruption failed', error)
    }
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
  }

  /**
   * Alias of close() for the started-daemon surface: a caller that only starts a
   * daemon (tests) stops it directly instead of running the full run() flow.
   */
  readonly stop = (): Promise<void> => this.close()

  /** Idempotent close; a second call never restarts cleanup, even after a failed close. */
  readonly close = async (): Promise<void> => {
    if (this.lowDiskTimer) clearInterval(this.lowDiskTimer)
    this.lowDiskTimer = undefined
    if (this.dbCleanupTimer) clearInterval(this.dbCleanupTimer)
    this.dbCleanupTimer = undefined
    if (this.memoryConsolidationInitialTimer) clearTimeout(this.memoryConsolidationInitialTimer)
    this.memoryConsolidationInitialTimer = undefined
    if (this.memoryConsolidationTimer) clearInterval(this.memoryConsolidationTimer)
    this.memoryConsolidationTimer = undefined
    // Cut off cleanup admission, ask the in-flight serialized run to interrupt
    // itself at its next DB batch or vacuum yield boundary, and wait for the
    // chain under the shutdown drain budget before the database is released.
    // On timeout the cleanup fence keeps any suspended run from resuming SQL
    // against a released database.
    stopManagedCleanup()
    stopStatsDayCacheBackgroundSealer()
    const cleanupDrained = await drainManagedCleanup(SHUTDOWN_DRAIN_TIMEOUT_MS)
    if (!cleanupDrained) {
      writeDaemonLog('warn', `cleanup drain exceeded ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms; remaining cleanup is fenced and will not resume SQL`)
    }
    if (this.stopEventLoopMonitor) this.stopEventLoopMonitor()
    this.stopEventLoopMonitor = undefined
    setSlowQueryLogger(null)
    const resources = this.resources
    this.resources = undefined
    try {
      if (resources) {
        await teardownDaemonResources({
          httpServer: resources.httpServer,
          session: resources.session,
          scheduler: resources.scheduler,
          botAgents: resources.botAgents,
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

  private async sampleLowDisk(): Promise<void> {
    const previous = this.lowDiskState.status
    try {
      const info = await statfs(foremanStateRoot())
      const availableBytes = Number(info.bavail) * Number(info.bsize)
      this.lowDiskState = { status: availableBytes < this.lowDiskState.minimumBytes ? 'low' : 'ok', availableBytes, minimumBytes: this.lowDiskState.minimumBytes, error: null }
    } catch (error) {
      this.lowDiskState = { ...this.lowDiskState, status: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
    if (previous !== this.lowDiskState.status) writeDaemonLog(this.lowDiskState.status === 'ok' ? 'info' : 'warn', `state volume disk status ${previous} -> ${this.lowDiskState.status}`)
    lowDiskStateForProcess = this.lowDiskState
    this.resources?.runtime.supervisor.promoteQueuedAfterGuardChange()
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
    isIdle?: (counts?: DaemonActiveWorkCounts) => Promise<boolean>
    isShuttingDown: () => boolean
    /** True while a workspace hot switch holds the gate; refuses new work. */
    isSwitching?: () => boolean
    lowDiskState?: () => LowDiskState
    /** Daemon-owned workspace hot switch backing the workspace.switch RPC. */
    workspaceSwitch?: (root: string) => Promise<WorkspaceSwitchResult>
    /** True when WRENYARD_WORKSPACE / --work-dir pins the workspace root. */
    workspacePinned?: () => boolean
    /** Receives the scheduler as soon as it exists, before the IPC server. */
    onScheduler?: (scheduler: Scheduler) => void
    /** Receives the bot agent kernel as soon as it exists, before the IPC server. */
    onBotAgents?: (botAgents: BotAgentKernel) => void
  },
): Promise<ForemanDaemonResources> {
  const operations: OperationHost = {
    agent: runtime.supervisor,
    runner: runtime.runner,
  }

  const startedAt = Date.now()
  // The gateway listens on loopback only. A random port is assigned by the OS at
  // bind time; a fixed port comes from the persisted gateway setting. Both the
  // bind choice and the effective token are captured here, once, and never
  // change for this process: saving a new setting persists it for the next bind
  // and does not move the running listener or rotate the live token.
  let boundPort = 0
  const gatewaySavedFixedPort = config.gateway.portMode === 'fixed' ? config.gateway.port : undefined
  if (config.gateway.portMode === 'fixed' && (!Number.isInteger(gatewaySavedFixedPort) || gatewaySavedFixedPort! < 1 || gatewaySavedFixedPort! > 65535)) {
    throw new Error('Gateway fixed port must be an integer between 1 and 65535. Choose a valid fixed port or switch the gateway port mode to random.')
  }
  const gatewayBindPort = gatewaySavedFixedPort ?? 0
  const gatewayBindMode: GatewayPortMode = gatewaySavedFixedPort === undefined ? 'random' : 'fixed'
  // Catalog / provider runtime / canonical task plans / deterministic resolver
  // are constructed once in bootstrap (see bootstrapForemanDaemonRuntime) and
  // reused here so the gateway, RPC surface, and the running daemon all share
  // the identical resolver instance.
  const { catalog, providerRuntime, dispatchPlans, taskDispatchResolver, workBuddyProviders, codeBuddyProvider } = runtime
  const workBuddyProvidersById = new Map<WorkBuddyBuildId, WorkBuddyProvider>(
    workBuddyProviders.map((provider) => [provider.id as WorkBuddyBuildId, provider]),
  )
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
  // Gateway pool-scoped quota_exhausted faults observed during routing, keyed
  // `${provider}|${quotaPoolId}`. Cleared on a pool available event or when stale.
  const OBSERVED_POOL_EXHAUSTION_TTL_MS = 30 * 60_000
  const observedPoolExhaustionByPool = new Map<string, { at: number; until?: number }>()
  const observedPoolExhaustionSnapshot = (): ReadonlyMap<string, number> => {
    const now = Date.now()
    const surviving = new Map<string, number>()
    for (const [key, entry] of observedPoolExhaustionByPool) {
      const expired = entry.until !== undefined
        ? now > entry.until
        : now > entry.at + OBSERVED_POOL_EXHAUSTION_TTL_MS
      if (expired) {
        observedPoolExhaustionByPool.delete(key)
        continue
      }
      surviving.set(key, entry.at)
    }
    return surviving
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
    observedPoolExhaustion: observedPoolExhaustionSnapshot,
  })
  // Authoritative, non-inference native auth/model readiness now comes from the
  // clients' own native observations (AgentClient.readReadiness), not a Wrenyard
  // subprocess. The daemon boundary only maps each native client to its known
  // canonical provider binding and canonicalizes public model ids; no native
  // credential crosses this boundary and native auth is never promoted into
  // Gateway support. Auth unknown stays an absent entry (never false).
  const nativeProviderReadinessCache = createAsyncSnapshotCache<NativeProviderReadinessSnapshot>(5_000)
  const clientReadinessCache = createAsyncSnapshotCache<{
    sampledAtMs: number
    clientsById: Record<string, { enabled: boolean; installed: boolean }>
  }>(5_000)
  const invalidateProviderReadiness = (): void => {
    nativeProviderReadinessCache.invalidate()
    clientReadinessCache.invalidate()
  }
  const readNativeProviderReadiness = async (): Promise<NativeProviderReadinessSnapshot> => {
    const authByProvider: Record<string, boolean> = {}
    const clients = createAgentClients()
    const codexReadiness = await readClientReadiness(clients.get('codex'))
    if (codexReadiness?.authentication === 'ready') authByProvider.chatgpt = true
    else if (codexReadiness?.authentication === 'missing') authByProvider.chatgpt = false
    const codexModelDiscovery = await readCodexModels().catch(() => undefined)
    const cursorReadiness = await readClientReadiness(clients.get('cursor'))
    if (cursorReadiness?.authentication === 'ready') authByProvider.cursor = true
    else if (cursorReadiness?.authentication === 'missing') authByProvider.cursor = false
    const cursorModelAvailability = cursorReadiness?.authentication === 'ready'
      ? projectModelAvailability(cursorReadiness.modelAvailability, 'cursor')
      : undefined
    return Object.freeze({
      sampledAtMs: Date.now(),
      authByProvider: Object.freeze(authByProvider),
      ...(codexModelDiscovery === undefined ? {} : { codexModelDiscovery }),
      ...(cursorModelAvailability === undefined ? {} : { cursorModelAvailability }),
    })
  }
  // Client installation comes from each AgentClient.inspect. Enabled follows
  // the registered client; installed is the inspect result.
  const readClientReadinessSnapshot = async () => {
    const clientsById: Record<string, { enabled: boolean; installed: boolean }> = {}
    for (const [id, client] of createAgentClients()) {
      const status = await client.inspect()
      clientsById[id] = { enabled: true, installed: status.installation.state === 'installed' }
    }
    return { sampledAtMs: Date.now(), clientsById }
  }
  const loadNativeProviderReadiness = (): Promise<NativeProviderReadinessSnapshot> =>
    nativeProviderReadinessCache.read(readNativeProviderReadiness)
  const loadClientReadiness = () => clientReadinessCache.read(readClientReadinessSnapshot)
  // One daemon-owned TaskSettingsService shares the already-created resolver,
  // the single alias owner, the shared quota snapshot service, and the
  // authoritative config path; no second catalog/resolver/alias store is
  // constructed.
  const authoritativeConfigPath = new ForemanConfigManager().resolvePath(options.configPath)
  if (config.gateway.portMode === 'fixed' && (!Number.isInteger(config.gateway.port) || config.gateway.port! < 1 || config.gateway.port! > 65535)) {
    throw new Error('Gateway fixed port must be an integer between 1 and 65535. Choose a valid fixed port or switch the gateway port mode to random.')
  }
  // The persisted gateway token. On the first start none is stored yet: generate
  // a CSPRNG token once, persist it through the same atomic mode-0600 config
  // write as every other setting, and reuse that exact value on later starts so
  // a restart does not invalidate existing credentials. The value is captured
  // for this process and never logged.
  const gatewayToken = config.gateway.token ?? persistGeneratedGatewayToken(authoritativeConfigPath)
  const runtimeAvailability = createRoutingAvailability({ catalog, providerRuntime, loadNativeProviderReadiness, loadCurrentCodeBuddySnapshot })
  const gatewayEventStore = new ForemanEventStore(runtime.db)
  const gateway = createModelGateway({
    catalog,
    providers: providerRuntime,
    onRouteStateChanged: async (event) => {
      if (event.scope === 'pool' && event.quotaPoolId !== undefined) {
        const poolKey = `${event.provider}|${event.quotaPoolId}`
        if (event.state === 'quota_exhausted') {
          const untilMs = event.until === undefined ? undefined : Date.parse(event.until)
          observedPoolExhaustionByPool.set(poolKey, {
            at: Date.now(),
            ...(Number.isFinite(untilMs) ? { until: untilMs } : {}),
          })
        } else if (event.state === 'available') {
          observedPoolExhaustionByPool.delete(poolKey)
        }
      }
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
          ...(event.nextRetryAt === undefined ? {} : { nextRetryAt: event.nextRetryAt }),
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
        // The route fault reason, phase and retry instant are safe structured facts; the attempt id is a gateway-only
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
          ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
          ...(event.reasoningEffort === undefined ? {} : { reasoningEffort: event.reasoningEffort }),
          ...(event.reasoningParameters === undefined ? {} : { reasoningParameters: event.reasoningParameters }),
          ...(event.fast === undefined ? {} : { fast: event.fast }),
          ...(event.fastParameters === undefined ? {} : { fastParameters: event.fastParameters }),
          status: event.status,
          durationMs: event.durationMs,
          ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.tps_samples === undefined ? {} : { tps_samples: event.tps_samples }),
          ...(event.upstream === undefined ? {} : { upstream: event.upstream }),
          ...(event.faultCause === undefined ? {} : { faultCause: event.faultCause }),
          ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
          ...(event.failureClass === undefined ? {} : { failureClass: event.failureClass }),
        },
        occurredAt: new Date().toISOString(),
      }
      if (event.faultCause !== undefined) {
        const { name, message, code } = event.faultCause
        const label = [name, message].filter((part) => part !== undefined && part !== '').join(': ')
        const suffix = code === undefined || code === '' ? '' : ` (code ${code})`
        writeDaemonLog('warn', `gateway request failed locally: ${label}${suffix}`)
      }
      gatewayEventStore.append(foremanEvent)
      // The completion event is now persisted, so the attributed execution can
      // be re-read. A still-running execution yields no sample, and a late
      // completion replaces the client-derived sample with the gateway pair.
      if (typeof event.executionId === 'string' && event.executionId !== '') {
        updateLocalSpeedSample(event.executionId, runtime.db)
      }
      await getForemanEventBus().publish(foremanEvent)
    },
  })
  const gatewayHealthBackfillCutoff = Date.now()
  void (async () => {
    try {
      const sinceIso = new Date(gatewayHealthBackfillCutoff - 24 * 60 * 60 * 1000).toISOString()
      const rows = runtime.db.prepare<unknown[], { timestamp: string; data: string | null }>(
        `SELECT timestamp, data FROM events
         WHERE type = 'gateway.request.completed' AND created_at >= ?
         ORDER BY id ASC`,
      ).all(sinceIso)
      for (const row of rows) {
        const timestamp = Date.parse(row.timestamp)
        if (!Number.isFinite(timestamp) || timestamp >= gatewayHealthBackfillCutoff) continue
        if (row.data === null) continue
        let envelope: unknown
        try {
          envelope = JSON.parse(row.data)
        } catch {
          continue
        }
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue
        const record = envelope as Record<string, unknown>
        if (record.schema_version !== 'foreman.event.v1') continue
        const rawData = record.data
        if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) continue
        const data = rawData as Record<string, unknown>
        const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
        const publicModel = typeof data.publicModel === 'string' ? data.publicModel.trim() : ''
        const status = typeof data.status === 'number' ? data.status : Number(data.status)
        if (provider === '' || publicModel === '' || !Number.isFinite(status)) continue
        const completion: GatewayHealthCompletionInput = { provider, publicModel, status, timestamp }
        if (typeof data.outcome === 'string') completion.outcome = data.outcome as GatewayHealthOutcome
        if (typeof data.failureClass === 'string') completion.failureClass = data.failureClass
        if (typeof data.faultReason === 'string') completion.faultReason = data.faultReason
        if (data.faultCause !== undefined && typeof data.faultCause === 'object' && !Array.isArray(data.faultCause)) {
          completion.faultCause = data.faultCause as GatewayHealthCompletionInput['faultCause']
        }
        if (data.upstream !== undefined && typeof data.upstream === 'object' && !Array.isArray(data.upstream)) {
          completion.upstream = data.upstream as GatewayHealthCompletionInput['upstream']
        }
        if (Array.isArray(data.tps_samples)) {
          completion.tps_samples = data.tps_samples as GatewayHealthCompletionInput['tps_samples']
        }
        gateway.ingestHealthCompletion(completion)
      }
    } catch (error) {
      writeDaemonLog('warn', 'gateway health backfill failed', error)
    }
  })()
  // The session feature invokes allowlisted workspace methods through this one
  // router, so the router exists before the workspace bindings are assembled.
  const rpcRouter = new RpcRouter({
    // Per-request attribution warns on slow (>200ms) and failed IPC requests;
    // only method/duration/ok is reported, never params or results.
    onRequestEnd: ({ method, durationMs, ok }) => {
      if (!ok) {
        writeDaemonLog('warn', 'failed IPC request', { method, durationMs })
      } else if (durationMs >= 200) {
        writeDaemonLog('warn', 'slow IPC request', { method, durationMs })
      }
    },
  })
  const sessionStateRoot = foremanStateRoot()
  const ipcPath = resolveWrenyardIpcPath(process.env, { config })
  // The single shared gateway connection snapshot, used by the session gateway,
  // the IPC gateway.connection surface and the environment injection below.
  const gatewayConnectionSnapshot = async (): Promise<DaemonGatewayConnection> => ({
    ...await gateway.connection(gatewayOrigin(boundPort)),
    token: gatewayToken,
  })
  // Assigned before IPC routes are registered; saves invoked earlier in startup
  // safely skip list invalidation without touching a temporal-dead-zone binding.
  let providerServiceForInvalidation: ProviderService | undefined

  // IPC-only read/update of the persisted gateway access settings. Reading
  // reports the saved choice (freshly re-read, so a save is visible at once) and
  // the effective bind-time connection side by side. A save only persists: it
  // never rebinds, restarts, rotates the effective token or rewrites the
  // injected WRENYARD_GATEWAY_* environment this process already published.
  const gatewaySettingsSnapshot = async (): Promise<GatewaySettingsResult> => {
    const saved = loadForemanGatewayConfig(authoritativeConfigPath)
    const savedFixedPort = saved.portMode === 'fixed' ? saved.port : undefined
    const connection = await gateway.connection(gatewayOrigin(boundPort))
    return {
      savedPortMode: saved.portMode,
      ...(savedFixedPort === undefined ? {} : { savedPort: savedFixedPort }),
      tokenSaved: saved.token !== undefined,
      portChangePending:
        saved.portMode !== gatewayBindMode
        || (savedFixedPort !== undefined && savedFixedPort !== gatewayBindPort),
      tokenChangePending: saved.token !== undefined && saved.token !== gatewayToken,
      effective: {
        host: '127.0.0.1',
        port: boundPort,
        openaiChatBaseUrl: connection.openaiChatBaseUrl,
        openaiResponsesBaseUrl: connection.openaiResponsesBaseUrl,
        anthropicBaseUrl: connection.anthropicBaseUrl,
        token: gatewayToken,
      },
    }
  }

  const saveGatewaySettings = async (
    update: GatewaySettingsSaveParams,
  ): Promise<GatewaySettingsSaveResult> => {
    // A generated replacement is minted here, never supplied by the caller; a
    // custom replacement is the caller's already-validated value.
    const tokenUpdate = update.token
    const replacementToken = tokenUpdate === undefined
      ? undefined
      : tokenUpdate.kind === 'generate'
        ? randomBytes(32).toString('hex')
        : tokenUpdate.token
    updateForemanGatewayConfig(authoritativeConfigPath, (current) => {
      const portChoice = update.port
      let portMode = current.portMode
      let port = current.port
      if (portChoice !== undefined) {
        if (portChoice.mode === 'random') {
          portMode = 'random'
          port = undefined
        } else {
          portMode = 'fixed'
          port = portChoice.port
        }
      }
      const token = replacementToken ?? current.token
      return {
        portMode,
        ...(portMode === 'fixed' && port !== undefined ? { port } : {}),
        ...(token === undefined ? {} : { token }),
      }
    })
    invalidateProviderReadiness()
    providerServiceForInvalidation?.invalidateList()
    const snapshot = await gatewaySettingsSnapshot()
    return {
      ok: true,
      ...snapshot,
      ...(replacementToken === undefined ? {} : { warning: GATEWAY_TOKEN_REPLACEMENT_WARNING }),
    }
  }

  // The task path reuses this same gateway/circuit (no second circuit and no
  // new persistence): a native task attempt admits its exact route once before
  // launch, reports success after a schema-validated delivery (settling a due
  // half-open probe), a route-local fault after a terminal structured-output
  // failure (settling the held probe with its backoff), and a cancelled release
  // for any other exit.
  //
  // The task fault key is the route's provider plus its bare model (any
  // `:client` suffix is stripped), so a native fault lands on the same
  // `provider/model` health key a session call uses. Admission therefore also
  // checks the shared route first, so a pinned task or a selection-to-launch
  // race can never launch while that shared circuit still refuses the route.
  const taskRouteState: TaskRouteStateHooks = {
    admit: (provider, model, mode) => {
      const shared = blockedSharedTaskRoute(gateway, provider, model)
      if (shared !== undefined) return { kind: 'blocked', status: shared }
      return gateway.admitRoute(provider, model)
    },
    success: (provider, model, guard) => gateway.completeRouteSuccess(provider, model, guard),
    fault: (provider, model, guard, fault) => {
      // Faults are keyed by provider plus the bare model: the native task route
      // is client-qualified, but a client suffix is never part of route health.
      let bareModel: string
      try {
        bareModel = parseRunSyntax(`${provider}/${model}`).model
      } catch {
        return undefined
      }
      const routeKey = `${provider}/${bareModel}`
      const providerDefinition = catalog.provider(provider)
      if (providerDefinition === undefined) return undefined
      // The provider hook reads the error identity exactly as it would from a
      // real upstream body (`{ error: { type, message, resets_at } }`).
      const body = fault.errorType === undefined && fault.message === undefined && fault.resetsAt === undefined
        ? undefined
        : {
            error: {
              ...(fault.errorType === undefined ? {} : { type: fault.errorType }),
              ...(fault.message === undefined ? {} : { message: fault.message }),
              ...(fault.resetsAt === undefined ? {} : { resets_at: fault.resetsAt }),
            },
          }
      const failure = classifyRouteFailure(providerDefinition, bareModel, fault.status, new Headers(), body, Date.now())
      if (failure === undefined) return undefined
      gateway.reportNativeRouteFault(provider, bareModel, failure, guard)
      return gateway.routeStatus(routeKey)
    },
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
    const taskService = new TaskService({
      workspaceRoot,
      operations,
      // Surface the shared host-wide desktop lane's FIFO position on a waiting
      // run so `task status` reports the 1-based `queue_position` while queued.
      lanePosition: (taskRunId) => desktopLane.positionOf(taskRunId),
    })
    const taskSettingsService = new TaskSettingsService({
      workspaceRoot,
      configPath: authoritativeConfigPath,
      resolver: taskDispatchResolver,
      quotaSnapshots: autoRoutingQuotaSnapshots,
      // The same shared Gateway instance and route-status callable already used
      // by session and auxiliary routing: automatic Task candidates observe the
      // one in-memory route circuit, with no second Gateway or duplicated
      // circuit state.
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
      gatewayHealth: () => gateway.health(),
    })
    const workspaceDocService = new WorkspaceDocService(workspaceRoot)
    // The todo index is disposable and lives under the daemon local state root
    // (keyed by workspace), never inside the workspace tree or the runtime DB.
    const workspaceTodoService = new WorkspaceTodoService(
      workspaceRoot,
      todoIndexPath(sessionStateRoot, workspaceRoot),
    )
    // The session feature owns the append-only ledger, the workspace document
    // surface and per-role automatic auxiliary selection. Its gateway connection and task
    // wait/cancel are injected in-process, and DSH MCP tools reach the daemon over
    // this same IPC path like every other client. The ledger is stored under a
    // workspace-hashed directory, so a new root opens a new ledger and the old
    // workspace's history stays intact on disk.
    // One shared routing input port feeds both the per-role auxiliary selector
    // and the bot requirement key the bot agent kernel uses.
    const auxiliaryRouteHealthCache: { map?: Map<string, GatewayHealthWindowLike> } = {}
    const resetAuxiliaryRouteHealth = (): void => {
      auxiliaryRouteHealthCache.map = undefined
    }
    const auxiliaryRoutingOptions: SelectorInputPort = {
      catalog,
      quotaSnapshots: autoRoutingQuotaSnapshots,
      // The Gateway model directory is the only source of per-model protocols.
      gatewayModels: async () => (await gateway.connection(gatewayOrigin(boundPort))).models,
      routeStatus: model => gateway.routeStatus(model),
      runtimeAvailability: createAuxiliaryAvailability(runtimeAvailability, catalog, providerRuntime),
      localSpeed: readLocalSpeedSamplesCached,
      readSettings: () => readAuxiliaryRoutingSettings(authoritativeConfigPath),
      gatewayRouteHealth: (routeKey) => {
        if (auxiliaryRouteHealthCache.map === undefined) {
          auxiliaryRouteHealthCache.map = new Map()
          try {
            for (const route of gateway.health().routes) {
              auxiliaryRouteHealthCache.map.set(`${route.provider}/${route.model}`, route.last1h)
            }
          } catch {
            // Passive health is best-effort; absence means no avoidance input.
          }
        }
        return auxiliaryRouteHealthCache.map.get(routeKey)
      },
    }
    // Bot agents select through the bot requirement key (high/premium at a high
    // reasoning level); each ranked `provider/model` route is split into the
    // explicit model session.send needs.
    const selectModels = async (): Promise<readonly AgentModelRoute[]> => {
      resetAuxiliaryRouteHealth()
      const routes = await selectRoutesByRequirement(auxiliaryRoutingOptions, BOT_ROUTING_REQUIREMENT, 'bot')
      return routes.map(route => {
        const separator = route.model.indexOf('/')
        if (separator <= 0) return { provider: route.model, model: route.model, reasoningEffort: route.reasoningEffort }
        const provider = route.model.slice(0, separator)
        const model = route.model.slice(separator + 1)
        const metadata = resolveModelMetadata(`${provider}/${model}`)
        return {
          provider,
          model,
          reasoningEffort: route.reasoningEffort,
          ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
          ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
        }
      })
    }
    const isRouteExcluded = (model: string): boolean => {
      const settings = readAuxiliaryRoutingSettings(authoritativeConfigPath)
      const separator = model.indexOf('/')
      if (separator <= 0) return false
      const provider = model.slice(0, separator)
      const modelId = model.slice(separator + 1)
      if ((settings?.exclude?.providers ?? []).includes(provider)) return true
      const excludedModels = settings?.exclude?.models ?? []
      return excludedModelIdsFor(catalog.provider(provider), excludedModels).has(modelId)
    }
    // The task-output compile runs one auxiliary model call per finished run on
    // demand, outside any session, through this workspace's own routes. It is
    // the single compile entry point shared by the `task.run.compile` RPC and
    // TaskGraph nodes with an output schema.
    const taskOutputCompile: TaskRunOutputCompiler = createTaskRunOutputCompiler({
      workspaceRoot,
      taskService,
      modelCall: createTaskOutputModelCallPort({
        gateway: gatewayConnectionSnapshot,
        selectAuxiliary: (role, input) => selectRoutesByRequirement(
          auxiliaryRoutingOptions,
          ROLE_ROUTE_REQUIREMENTS[role],
          role,
          input,
        ),
        resolveInferenceProvider: id => catalog.provider(id),
        routeStatus: model => gateway.routeStatus(model),
      }),
    })
    // Single shared TaskGraphService used by all RPC transports. Task nodes
    // with an output schema compile their run's report through the same
    // task-output compile step the RPC surface exposes.
    const taskgraphService = createTaskGraphService({
      workspaceRoot,
      operations,
      eventSink: projectTaskGraphForemanEvent,
      taskOutputCompile,
    })
    const daemonSessionHost = createDaemonSessionHost({
      workspaceRoot,
      stateRoot: sessionStateRoot,
      gateway: gatewayConnectionSnapshot,
      taskService,
      // The environment's execution tools: the ready operation components plus
      // the declared external tool ids from `tasks.settings.global` (read from
      // the same authoritative daemon config the task settings service owns).
      operationComponents: runtime.operationComponents,
      taskSettingsConfigPath: taskSettingsService.authoritativeConfigPath,
      router: rpcRouter,
      routeStatus: model => gateway.routeStatus(model),
      selectAuxiliary: (role, input) => {
        resetAuxiliaryRouteHealth()
        return selectRoutesByRequirement(
          auxiliaryRoutingOptions,
          ROLE_ROUTE_REQUIREMENTS[role],
          role,
          input,
        )
      },
      isRouteExcluded,
      // The session's main inference validates against the same product-wired
      // catalog already injected into the gateway/provider.list surface, so a
      // CodeBuddy model is only offered after the daemon read the real install.
      resolveInferenceProvider: id => catalog.provider(id),
    })
    // A bot turn that fails twice on the same model continues on the next route
    // of the same automatic selection, inside the same turn.
    const session = createSession(daemonSessionHost, { selectAutomaticRoutes: async () => selectModels() })
    // The daemon-owned scheduler persists to the same state root as the session
    // ledger. A due routine wakes its owning bot agent through the `wake`
    // callback instead of sending into a session; the bot agent kernel owns the
    // bot registry and turn loop. Until it attaches, a wake is rejected and the
    // routine records `lastError`. The scheduler stays workspace-scoped, so no
    // routine can fire into another workspace's bots. It shares the daemon's
    // single diagnostic sink.
    // Device-only bots and each bot's routines on this device live in
    // `<config root>/bots`; an older `bot-agents` directory is moved there once.
    const deviceBotsDir = join(resolveWrenyardConfigRoot(), 'bots')
    for (const note of await migrateDeviceBots(join(resolveWrenyardConfigRoot(), 'bot-agents'), deviceBotsDir)) {
      writeDaemonLog('warn', note)
    }
    const scheduler = createScheduler({
      statePath: join(sessionStateRoot, 'routines.json'),
      // Late binding: the kernel is constructed right below the scheduler, so a
      // routine fire can only ever run once the kernel exists.
      wake: routine => botAgents.wakeRoutine(routine),
      busy: routine => botAgents.routineBusy(routine),
      workspaceRoot,
      log: writeDaemonLog,
      // Admission gate: the daemon suppresses scheduler fires while a hot switch
      // or shutdown is staging, so a suppressed scheduler cannot start a prompt
      // after isIdle was observed.
      canRun: () => !options.isShuttingDown() && options.isSwitching?.() !== true,
      // Routine files on this device are the definitions.
      routinesDir: botId => join(deviceBotsDir, botId, 'routines'),
    })
    // The bot agent kernel assembles LLM bots from per-bot JSON configs. It owns
    // per-bot contexts (a private session host rooted in its own state dir),
    // wake queues, watches and rounds, and fires through the scheduler above.
    const botAgents = createBotAgentKernel({
      workspaceRoot,
      workspaceBotsDir: join(workspaceRoot, 'bots'),
      deviceBotsDir,
      syncRoutines: (botId, routines) => scheduler.sync(botId, routines),
      routines: scheduler,
      stateDir: join(sessionStateRoot, 'bot-agents', sha256hex(workspaceRoot)),
      host: daemonSessionHost,
      sessions: session,
      todos: workspaceTodoService,
      selectModels,
      // A route is usable unless it is excluded or its shared state is open
      // (quota exhausted or blocked by backoff).
      isModelUsable: (provider, model) => {
        const id = `${provider}/${model}`
        return !isRouteExcluded(id) && gateway.routeStatus(id)?.phase !== 'open'
      },
      log: (level, message) => writeDaemonLog(level, message),
    })
    return {
      workspaceRoot,
      taskService,
      taskgraphService,
      taskSettingsService,
      workspaceDocService,
      workspaceTodoService,
      session,
      scheduler,
      botAgents,
      taskOutputCompile,
    }
  }

  /** Point the core RPC options at one binding set, before re-registering routes. */
  const applyBindings = (bindings: WorkspaceScopedResources): void => {
    coreOptions.workspaceRoot = bindings.workspaceRoot
    coreOptions.taskService = bindings.taskService
    coreOptions.taskgraphService = bindings.taskgraphService
    coreOptions.taskSettings = bindings.taskSettingsService
    coreOptions.workspaceDocService = bindings.workspaceDocService
    coreOptions.workspaceTodoService = bindings.workspaceTodoService
    coreOptions.taskOutputCompile = bindings.taskOutputCompile
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
    registerRoutineHandlers(rpcRouter, { scheduler: bindings.scheduler })
    registerAgentHandlers(rpcRouter, { kernel: bindings.botAgents })
  }

  let coreOptions: CoreRpcHandlerOptions
  let workspaceScoped = await createBindings(config.workspaceRoot)
  const providerService = new ProviderService({
    catalog, runtime: providerRuntime,
    // Live indirection: provider.list always reports the CURRENT workspace's
    // task settings, so a switch is visible without rebuilding the service.
    modelStatus: () => workspaceScoped.taskSettingsService.modelStatus(),
    localSpeed: readLocalSpeedSamplesCached,
  })
  providerServiceForInvalidation = providerService
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
  // Daemon-wide agent-client listing backing client.list. Detection runs each
  // supported client's inspect() plus the optional native readReadiness();
  // the enabled flag comes from the same loadClientReadiness() snapshot the
  // task admission gate uses, which currently reports every registered client
  // as enabled.
  const clientDisplayNames: Record<string, string> = {
    claude: 'Claude',
    codebuddy: 'CodeBuddy',
    codex: 'Codex',
    cursor: 'Cursor',
    dsh: 'DSH',
    grok: 'Grok',
    opencode: 'OpenCode',
    pi: 'Pi',
  }
  // npm package backing each client, when one is published. Clients without an
  // entry (e.g. cursor) have no supported install source and are managed
  // manually. Used to derive the install/upgrade source and to run npm.
  const clientNpmPackages: Record<string, string> = {
    claude: '@anthropic-ai/claude-code',
    codex: '@openai/codex',
    grok: '@xai-official/grok',
    opencode: 'opencode-ai',
    codebuddy: '@tencent-ai/codebuddy-code',
    dsh: '@deepseek-ai/dsh',
    pi: '@mariozechner/pi-coding-agent',
  }
  // In-flight install/upgrade jobs, keyed by client id, and the last recorded
  // failure message per client. Shared so client.list reflects live state.
  const clientJobs = new Map<string, { action: 'install' | 'upgrade' }>()
  const clientLastErrors = new Map<string, string>()
  let cachedNpmPrefix: string | null | undefined
  let npmPrefixLoad: Promise<string | null> | undefined
  const getNpmPrefix = (): Promise<string | null> => {
    if (cachedNpmPrefix !== undefined) return Promise.resolve(cachedNpmPrefix)
    if (npmPrefixLoad) return npmPrefixLoad
    npmPrefixLoad = (async () => {
      try {
        const child = process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm prefix -g'], { windowsHide: true })
          : spawn('npm', ['prefix', '-g'])
        const output = await readSpawnOutput(child, 10_000)
        cachedNpmPrefix = output.trim() || null
      } catch {
        cachedNpmPrefix = null
      }
      return cachedNpmPrefix
    })()
    return npmPrefixLoad
  }
  const isUnderNpmPrefix = (executablePath: string, prefix: string): boolean => {
    const normalized = prefix.endsWith(sep) ? prefix : prefix + sep
    return executablePath === prefix || executablePath.startsWith(normalized)
  }
  const readSpawnOutput = (child: ChildProcess, timeoutMs: number): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      let out = ''
      let err = ''
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        child.kill('SIGKILL')
        reject(new Error('command timed out'))
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => { out += chunk.toString() })
      child.stderr?.on('data', (chunk) => { err += chunk.toString() })
      child.on('error', (error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(out + (out && err ? '\n' : '') + err)
      })
    })
  }
  // Builds one client.list entry, shared by listClients and act so the two never
  // diverge. The source is derived from the known npm package and whether the
  // detected executable lives under the npm global prefix.
  const buildClientEntry = async (
    id: string,
    client: AgentClient,
    snapshot: { sampledAtMs: number; clientsById: Record<string, { enabled: boolean; installed: boolean }> },
  ): Promise<ClientListEntry> => {
    const enabled = snapshot.clientsById[id]?.enabled ?? true
    let installed = false
    let version: string | undefined
    let path: string | undefined
    let readiness: ClientReadiness = 'ready'
    let reason: string | undefined
    let status
    let inspectFailed = false
    try {
      status = await client.inspect()
    } catch (error) {
      inspectFailed = true
      reason = error instanceof Error ? error.message : String(error)
    }
    if (status !== undefined && status.installation.state === 'installed') {
      installed = true
      version = status.installation.version
      path = status.installation.executable
    }
    if (!enabled) {
      readiness = 'disabled'
    } else if (inspectFailed || status?.installation.state === 'unknown') {
      readiness = 'error'
      if (reason === undefined && status?.installation.state === 'unknown') {
        reason = status.installation.reason
      }
    } else if (status?.installation.state === 'missing') {
      readiness = 'not_installed'
    } else {
      const nativeReadiness = await readClientReadiness(client)
      if (nativeReadiness?.authentication === 'missing') {
        readiness = 'error'
        reason = 'authentication missing'
      }
    }
    const npmPackage = clientNpmPackages[id]
    let source: 'npm' | 'manual' = 'manual'
    if (npmPackage !== undefined) {
      if (!installed) {
        source = 'npm'
      } else if (path !== undefined) {
        const prefix = await getNpmPrefix()
        if (prefix !== null && isUnderNpmPrefix(path, prefix)) source = 'npm'
      }
    }
    const entry: ClientListEntry = {
      id,
      name: clientDisplayNames[id] ?? id,
      installed,
      ...(version === undefined ? {} : { version }),
      ...(path === undefined ? {} : { path }),
      enabled,
      readiness,
      ...(reason === undefined ? {} : { reason }),
      ...(npmPackage === undefined ? {} : { npmPackage }),
      source,
      ...(clientJobs.has(id) ? { busy: clientJobs.get(id)!.action } : {}),
      ...(clientLastErrors.has(id) ? { lastError: clientLastErrors.get(id)! } : {}),
    }
    return entry
  }
  const clientService = {
    listClients: async (params?: ClientListParams): Promise<ClientListEntry[]> => {
      const snapshot = await loadClientReadiness()
      const clients = createAgentClients()
      const entries: ClientListEntry[] = []
      for (const [id, client] of clients) {
        entries.push(await buildClientEntry(id, client, snapshot))
      }
      if (params?.checkUpdates === true) {
        const npmEntries = entries.filter((entry) => entry.installed && entry.npmPackage !== undefined)
        const latestResults = await Promise.allSettled(
          npmEntries.map(async (entry) => {
            const pkg = entry.npmPackage!
            const response = await fetch(
              `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
              { signal: AbortSignal.timeout(5000) },
            )
            if (!response.ok) throw new Error(`registry returned ${response.status}`)
            const data = await response.json() as { version?: string }
            return { pkg, latest: data.version }
          }),
        )
        const latestByPkg: Record<string, string> = {}
        for (const result of latestResults) {
          if (result.status === 'fulfilled' && result.value.latest !== undefined) {
            latestByPkg[result.value.pkg] = result.value.latest
          }
        }
        for (const entry of entries) {
          if (entry.npmPackage !== undefined && latestByPkg[entry.npmPackage] !== undefined) {
            const latest = latestByPkg[entry.npmPackage]
            entry.latestVersion = latest
            entry.updateAvailable = entry.version !== undefined && (
              isSemver(latest) && isSemver(entry.version)
                ? compareVersions(latest, entry.version) > 0
                : latest !== entry.version
            )
          }
        }
      }
      return entries
    },
    act: async (id: string, action: ClientAction): Promise<ClientListEntry> => {
      const client = createAgentClients().get(id)
      if (client === undefined) throw new Error(`Unknown client '${id}'`)
      if (clientJobs.has(id)) {
        throw new Error(`A ${clientJobs.get(id)!.action} is already in progress for client '${id}'`)
      }
      const npmPackage = clientNpmPackages[id]
      if (npmPackage === undefined) {
        throw new Error('This client has no supported install source; manage it manually.')
      }
      const npmStatus = await findExecutable(['npm'])
      if (npmStatus.installation.state !== 'installed') {
        throw new Error('npm is not available on the PATH; install Node.js and npm before managing clients.')
      }
      const load = readExecutionLoad(runtime.db)
      if (load.activeExecutions > 0) {
        throw new Error('Stop active executions before installing or upgrading a client.')
      }
      const status = await client.inspect()
      const installation = status.installation
      const installed = installation.state === 'installed'
      const executablePath = installation.state === 'installed' ? installation.executable : undefined
      const npmPrefix = await getNpmPrefix()
      if (action === 'install' && installed) {
        throw new Error(`Client '${id}' is already installed.`)
      }
      if (action === 'upgrade' && !installed) {
        throw new Error(`Client '${id}' is not installed; install it before upgrading.`)
      }
      if (action === 'upgrade' && executablePath !== undefined
        && (npmPrefix === null || !isUnderNpmPrefix(executablePath, npmPrefix))) {
        throw new Error(`Client '${id}' was not installed through npm; manage it manually.`)
      }
      clientJobs.set(id, { action })
      clientLastErrors.delete(id)
      try {
        const npmCommand = `npm install --global ${npmPackage}@latest`
        const command = process.platform === 'win32' ? 'cmd.exe' : 'npm'
        const args = process.platform === 'win32'
          ? ['/d', '/s', '/c', npmCommand]
          : ['install', '--global', `${npmPackage}@latest`]
        const child = spawn(command, args, { windowsHide: true })
        let output = ''
        const append = (chunk: Buffer | string): void => {
          output += chunk.toString()
          if (output.length > 4000) output = output.slice(output.length - 4000)
        }
        child.stdout?.on('data', append)
        child.stderr?.on('data', append)
        const exitCode = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error('npm timed out after 10 minutes'))
          }, 10 * 60 * 1000)
          child.on('error', reject)
          child.on('close', (code) => {
            clearTimeout(timer)
            resolve(code ?? 1)
          })
        })
        if (exitCode !== 0) {
          const tail = output.length > 2000 ? output.slice(output.length - 2000) : output
          clientLastErrors.set(id, `npm exited with code ${exitCode}${tail ? `\n${tail}` : ''}`)
        } else {
          clientReadinessCache.invalidate()
          await client.inspect().catch(() => undefined)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        clientLastErrors.set(id, message)
      } finally {
        clientJobs.delete(id)
      }
      const snapshot = await loadClientReadiness()
      return await buildClientEntry(id, client, snapshot)
    },
    host: (): ClientListHost => ({ hostname: hostname(), platform: process.platform }),
  }
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
    lowDiskState: options.lowDiskState,
    taskgraphService: workspaceScoped.taskgraphService,
    workspaceDocService: workspaceScoped.workspaceDocService,
    workspaceTodoService: workspaceScoped.workspaceTodoService,
    clientService,
    gatewayConnection: gatewayConnectionSnapshot,
    gatewaySettings: gatewaySettingsSnapshot,
    gatewayHealth: async () => gateway.health(),
    gatewaySettingsSave: (params) => saveGatewaySettings(params),
    providerList: () => providerService.list(),
    providerConfigure: async (params) => {
      const result = await providerService.configure(params)
      invalidateProviderReadiness()
      providerService.invalidateList()
      return result
    },
    providerQuota: async (params) => {
      if (params.forceRefresh === true) {
        // An explicit refresh re-runs CodeBuddy discovery first so a recovered
        // install republishes its catalog/runtime before readiness, list and
        // quota views are rebuilt — the same explicit-refresh path WorkBuddy's
        // refreshModels serves for its own catalog.
        try {
          await codeBuddyProvider.refreshModels()
        } catch {
          // A failed rediscovery keeps the safe unavailable reason; it never blocks quota.
        }
        invalidateProviderReadiness()
        providerService.invalidateList()
      }
      const result = await providerService.quotaSnapshot(params)
      // Devin only: price each quota window's recorded gateway usage at the
      // catalog's USD-per-million tuple so the snapshot carries an estimated
      // spend beside its remaining-percentage windows.
      for (const snapshot of result.providers) {
        if (snapshot.provider === 'devin' && snapshot.windows !== undefined && snapshot.windows.length > 0) {
          attachDevinEstimatedSpend(snapshot, catalog, runtime.db)
        }
      }
      return result
    },
    providerSignIn: async (params) => {
      const providerId = params.provider
      const provider = workBuddyProvidersById.get(providerId)
      if (provider === undefined) throw new Error(`Unknown WorkBuddy provider '${providerId}'`)
      const build = WORKBUDDY_BUILDS.find((entry) => entry.id === providerId)
      if (build === undefined) throw new Error(`Unknown WorkBuddy provider '${providerId}'`)
      const store = { context: defaultProviderContext(), build }
      const existing = await resolveWorkBuddySession(store, AbortSignal.timeout(15_000))
      if (existing !== undefined) {
        return { authUrl: '', alreadySignedIn: true }
      }
      const { state, authUrl } = await startWorkBuddyBrowserAuth(store, AbortSignal.timeout(30_000))
      void (async () => {
        try {
          const auth = await pollWorkBuddyBrowserToken(
            store,
            state,
            AbortSignal.timeout(AUTH_POLL_TIMEOUT_MS + 5_000),
          )
          if (auth === undefined) return
          await provider.refreshModels()
          invalidateProviderReadiness()
          providerService.invalidateList()
        } catch {
          // Browser sign-in polling ended without a credential; never log tokens.
        }
      })()
      return { authUrl, alreadySignedIn: false }
    },
    taskSettings: workspaceScoped.taskSettingsService,
    execService: runtime.execService,
    operationComponents: runtime.operationComponents,
    operationAdapter: runtime.operationAdapter,
    taskService: workspaceScoped.taskService,
    taskOutputCompile: workspaceScoped.taskOutputCompile,
    resolveExecRequest: (params) => {
      const provider = params.provider ?? catalog.clients().find(client => client.id === params.client)?.nativeProvider
      if (!provider) throw new Error('Execution requires a provider')
      // Historical identity migration for the execution plan: a legacy model
      // spelling resolves only through a verified unique mapping of this exact
      // provider. An unknown or ambiguous spelling fails actionably instead of
      // being guessed, and the client/route stays the request's own.
      const providerDefinition = catalog.provider(provider)
      if (!providerDefinition) throw new Error(`Unknown provider '${provider}'`)
      const model = resolveHistoricalOfferedModelId(providerDefinition, params.model)
      if (model === undefined) {
        throw new Error(`Model '${params.model}' is not a uniquely registered offering of provider '${provider}'`)
      }
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
        }
        const supported = catalog.reasoningEfforts(params.client, provider, model)
        // A provider-default-only ladder accepts any valid request: resolveRun
        // adapts every effort to the route's provider default.
        const providerDefaultOnly = supported.length === 1 && supported[0] === PROVIDER_DEFAULT_REASONING
        if (!supported.includes(expectedReasoningEffort) && !providerDefaultOnly) {
          throw new Error(`Reasoning effort '${expectedReasoningEffort}' is not supported by ${provider}/${model}`)
        }
      }
      const plan = catalog.resolveRun(params.client, provider, model, expectedReasoningEffort)
      if (params.mode && params.mode !== plan.mode) throw new Error('Requested mode does not match the selected client/provider')
      // The native wire spelling is owned by the provider, not by this request:
      // resolve it through the provider runtime so an explicit exec launches the
      // exact product id (e.g. canonical Claude 5 -> its `-1m` row) in every
      // environment. An explicit reasoning-effort-mapped substitution still wins,
      // and the public canonical id is preserved for the gateway/id surfaces.
      const upstreamModel = plan.upstreamModel
        ?? providerRuntime.resolveUpstreamModel(providerDefinition, plan.model)
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
    // migrated through the verified unique-match identity resolver (registered
    // id, private upstream binding, explicit alias or exact effort UID) so a
    // recognized historical spelling still resolves to its current definition
    // when offerings move. When the current offerings no longer list the exact
    // recorded route — for example a provider that dropped an alias — the exact
    // recorded provider/model ids are returned with the best available provider
    // label, so a historical row is never left blank, a missing provider/model
    // identity is never invented, and no client or upstream identifier is
    // consulted.
    resolveTaskRunDisplayNames: (providerId, modelId) => {
      const recordedProvider = typeof providerId === 'string' ? providerId.trim() : ''
      const recordedModel = typeof modelId === 'string' ? modelId.trim() : ''
      if (recordedProvider === '' || recordedModel === '') return undefined
      const provider = catalog.provider(recordedProvider)
      const normalizedModelId = provider === undefined
        ? recordedModel
        : (resolveHistoricalOfferedModelId(provider, recordedModel) ?? recordedModel)
      const model = provider?.models.find((candidate) => candidate.id === normalizedModelId)
      const providerDisplayName = provider?.displayName?.trim()
      const modelDisplayName = model?.displayName?.trim()
      if (model && providerDisplayName && modelDisplayName) {
        // Statistics keep the provider-scoped identity: one registered model id
        // measured through two providers is two routes with independent
        // evidence, so the key is never collapsed to the model id alone.
        const statsModelId = `${recordedProvider}/${model.id}`
        return {
          provider_display_name: providerDisplayName,
          model_display_name: modelDisplayName,
          stats_model_key: `provider-local:${statsModelId}`,
          stats_model_id: statsModelId,
          stats_model_display_name: modelDisplayName.trim(),
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
  options.onBotAgents?.(workspaceScoped.botAgents)

  // During drain, preserve status/cancel/signals and the calls required by
  // admitted work. New top-level dispatch and long polling cannot hold the
  // daemon open or create more work after the shutdown request is accepted.
  const blockedDuringShutdown = new Set([
    'taskgraph.create', 'task.run.create', 'exec.start', 'session.send',
  ])
  // The same rule while a workspace hot switch holds the gate: no new admitting
  // work and no new workspace-mutating request may start, so the state swap
  // cannot be raced by an operation that captured the previous root. The switch
  // method itself is deliberately absent: a concurrent switch is refused by the
  // gate's owner with an actionable `busy` result instead of a protocol error.
  const blockedDuringSwitch = new Set([
    'taskgraph.create', 'taskgraph.patch', 'taskgraph.signal',
    'task.run.create', 'exec.start', 'session.send',
    'session.create', 'session.interrupt', 'session.delete', 'session.rename', 'session.title.regenerate',
    'project.register', 'project.pull', 'project.push', 'project.commit',
    'project.worktree.create', 'project.worktree.remove', 'project.worktree.merge', 'project.worktree.rebase',
    'workspace.vcs.commit', 'workspace.vcs.push', 'workspace.vcs.pull',
    'workspace.doc.create', 'workspace.doc.update', 'workspace.doc.edit', 'workspace.doc.delete',
    'routine.create', 'routine.update', 'routine.run', 'routine.delete',
    'agent.wake',
  ])
  // In-flight requests that mutate workspace-scoped state or admit work count
  // against idleness, so a switch also waits for / refuses while a project,
  // document, VCS, session or scheduler mutation is still running. Long polling
  // (session.events with a wait) is never tracked: it would hold drain open.
  const trackedWorkMethods = [
    'taskgraph.create', 'taskgraph.patch', 'taskgraph.signal',
    'task.run.create', 'exec.start', 'session.send',
    'session.create', 'session.interrupt', 'session.delete', 'session.rename', 'session.title.regenerate',
    'project.register', 'project.pull', 'project.push', 'project.commit',
    'project.worktree.create', 'project.worktree.remove', 'project.worktree.merge', 'project.worktree.rebase',
    'workspace.vcs.commit', 'workspace.vcs.push', 'workspace.vcs.pull',
    'workspace.doc.create', 'workspace.doc.update', 'workspace.doc.edit', 'workspace.doc.delete',
    'routine.create', 'routine.update', 'routine.run', 'routine.delete',
    'agent.wake',
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
    if (['taskgraph.signal', 'routine.run', 'agent.wake', 'session.send'].includes(method)) {
      const disk = options.lowDiskState?.()
      if (disk && disk.status !== 'ok') throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `low_disk_space: ${disk.status === 'low' ? `available ${disk.availableBytes} bytes is below the ${disk.minimumBytes} byte minimum` : `state-volume sample failed: ${disk.error ?? 'unknown error'}`}; free space on the Wrenyard state volume and retry` },
        { code: 'low_disk_space', method },
      )
    }
    if (['task.run.create', 'taskgraph.create', 'taskgraph.patch', 'exec.start'].includes(method)) {
      const disk = options.lowDiskState?.()
      if (disk && disk.status !== 'ok') throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `low_disk_space: ${disk.status === 'low' ? `available ${disk.availableBytes} bytes is below the ${disk.minimumBytes} byte minimum` : `state-volume sample failed: ${disk.error ?? 'unknown error'}`}; free space on the Wrenyard state volume and retry` },
        { code: 'low_disk_space', method },
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
  // Bind one loopback port: an OS-assigned free port in random mode, or the
  // exact saved fixed port. A fixed port that is already in use fails loud with
  // an actionable message; the daemon never silently falls back to another port.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off('error', onError)
      if (gatewayBindMode === 'fixed' && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(new Error(
          `Gateway port ${gatewayBindPort} is already in use on 127.0.0.1. Choose another fixed port or switch the gateway port mode to random.`,
        ))
        return
      }
      reject(error)
    }
    httpServer.once('error', onError)
    httpServer.listen(gatewayBindPort, '127.0.0.1', () => {
      httpServer.off('error', onError)
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
      onMessage: (message, signal) =>
        rpcRouter.handleMessage(message, { transport: 'ipc', ...(signal ? { signal } : {}) }),
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
  // Load the persisted routines before anything ticks, and start the bot agent
  // kernel before the scheduler's first tick: a routine that is already due
  // fires on that first tick and must find a kernel whose bot configs are
  // loaded, or the wake is refused with an unknown bot.
  if (!options.isShuttingDown()) await workspaceScoped.scheduler.prepare()
  // The bot agent kernel starts with the scheduler: routines may fire as soon
  // as polling begins, and a bot wake must find a started kernel.
  if (!options.isShuttingDown()) await workspaceScoped.botAgents.start()
  // Begin scheduled-prompt polling only after the IPC server is listening, so
  // the scheduler never fires into a session whose clients cannot reach it yet.
  // A shutdown requested during startup skips start entirely: no interval is
  // armed and the stopped scheduler stays stopped.
  if (!options.isShuttingDown()) await workspaceScoped.scheduler.start()

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
    invalidateProviderReadiness()
    providerServiceForInvalidation?.invalidateList()
    applyBindings(staged)
    registerWorkspaceRoutes(staged)
    // The running task runner resolves execution-time settings through the
    // current task settings service, exactly like bootstrap wires it.
    runtime.runner.setTaskSettingsResolver((params) => staged.taskSettingsService.resolveForRun(params))
    runtime.runner.setTaskRouteState(taskRouteState)
    resources.session = staged.session
    resources.scheduler = staged.scheduler
    resources.botAgents = staged.botAgents
    resources.taskService = staged.taskService
    resources.taskgraphService = staged.taskgraphService
    options.onScheduler?.(staged.scheduler)
    options.onBotAgents?.(staged.botAgents)
    // Retire the previous workspace before enabling new ticks: its scheduler
    // stops and its workspace-hashed session ledger is closed (history stays on
    // disk), so the old and new writers never overlap.
    await teardownWorkspaceBindings(previous)
    // Enable the staged workspace only now that the old writer is gone: load its
    // routines, start its bot agent kernel, then let the scheduler poll. A
    // routine that is already due fires on the scheduler's first tick and must
    // find a started kernel. The switch has already published, so a start
    // failure is logged and never reported as a retained old workspace.
    if (!options.isShuttingDown()) {
      try {
        await staged.scheduler.prepare()
      } catch (error) {
        writeDaemonLog('warn', 'scheduler failed to prepare after workspace switch', error)
      }
      try {
        await staged.botAgents.start()
      } catch (error) {
        writeDaemonLog('warn', 'bot agent kernel failed to start after workspace switch', error)
      }
      try {
        await staged.scheduler.start()
      } catch (error) {
        writeDaemonLog('warn', 'scheduler failed to start after workspace switch', error)
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
    botAgents: workspaceScoped.botAgents,
    rpcRouter,
    taskService: workspaceScoped.taskService,
    taskgraphService: workspaceScoped.taskgraphService,
    restoreGatewayEnvironment,
    rebindWorkspace,
    currentWorkspaceRoot: () => workspaceScoped.workspaceRoot,
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
    await bindings.botAgents.stop()
  } catch (error) {
    writeDaemonLog('warn', 'workspace bot agent kernel shutdown failed', error)
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
  /** Stopped with the scheduler so no bot agent turn starts during teardown. */
  botAgents?: BotAgentKernel
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
  // Stop the bot agent kernel at the same point: a late bot turn must not start
  // while the ledger and providers are being torn down.
  if (handles.botAgents) {
    try {
      await handles.botAgents.stop()
    } catch (error) {
      recordFailure('bot agent kernel shutdown failed', error)
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

/**
 * Generate and persist the first gateway token exactly once. The token is a
 * fresh CSPRNG value written through the same atomic mode-0600 config store as
 * every other setting, then reused verbatim on later starts. Never logged.
 */
function persistGeneratedGatewayToken(configPath: string): string {
  const token = randomBytes(32).toString('hex')
  updateForemanGatewayConfig(configPath, (gateway) => ({ ...gateway, token }))
  return token
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
 * launches. This guard only refuses, and the shared route-scoped fault is never
 * cleared by the exact-route settlement the task performs below.
 */
function blockedSharedTaskRoute(
  gateway: ModelGateway,
  provider: string,
  model: string,
): RouteStatus | undefined {
  let parsed: ReturnType<typeof parseRunSyntax>
  try {
    parsed = parseRunSyntax(`${provider}/${model}`)
  } catch {
    return undefined
  }
  const shared = gateway.routeStatus(`${provider}/${parsed.model}`)
  return shared?.phase === 'open' ? shared : undefined
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

/**
 * Per-model estimated USD spend inside one Devin quota window. Aggregates the
 * persisted `gateway.request.completed` events bounded by the window's
 * `created_at` span — the same created_at-bounded pattern the TPS sampler
 * uses — and prices each public model's token sums at the catalog's
 * [cached, input, output] USD-per-million tuple. The usage `input` figure
 * already includes `cachedInput`, so the priced non-cached share is
 * `input - cachedInput`; a recorded `cachedInput` above `input` (a counter
 * that never includes its cache share) is clamped to `input` so the
 * non-cached share never prices below zero. Returns undefined when the window
 * recorded no traffic on a model with a known catalog price, so the snapshot
 * omits the field rather than reporting a zero.
 */
function devinWindowEstimatedSpend(
  database: ForemanDatabase,
  devinProvider: import('@wrenyard/providers/catalog').ProviderDefinition | undefined,
  window: import('@wrenyard/protocol/provider').ProviderQuotaWindow,
): import('@wrenyard/protocol/provider').ProviderEstimatedSpend | undefined {
  if (devinProvider === undefined || window.resets_at === undefined) return undefined
  const resetMs = Date.parse(window.resets_at)
  if (!Number.isFinite(resetMs) || !Number.isFinite(window.window_minutes) || window.window_minutes <= 0) {
    return undefined
  }
  const windowStart = new Date(resetMs - window.window_minutes * 60_000).toISOString()
  const rows = database.prepare<unknown[], { data: string | null }>(
    `SELECT data FROM events
     WHERE likely(type = 'gateway.request.completed') AND created_at >= ? AND created_at < ?
       AND json_extract(data, '$.data.provider') = 'devin'`,
  ).all(windowStart, window.resets_at)
  const usageByModel = new Map<string, { input: number; output: number; cached: number }>()
  for (const row of rows) {
    if (row.data === null) continue
    let payload: unknown
    try { payload = JSON.parse(row.data) } catch { continue }
    const inner = (payload as { data?: unknown }).data
    if (inner === undefined || typeof inner !== 'object') continue
    const publicModel = (inner as { publicModel?: unknown }).publicModel
    if (typeof publicModel !== 'string' || !publicModel.startsWith('devin/')) continue
    const usage = (inner as { usage?: unknown }).usage
    if (usage === undefined || typeof usage !== 'object') continue
    const input = (usage as { input?: unknown }).input
    const output = (usage as { output?: unknown }).output
    const cached = (usage as { cachedInput?: unknown }).cachedInput
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0
      || typeof output !== 'number' || !Number.isFinite(output) || output < 0) continue
    if (input === 0 && output === 0) continue
    const cachedTokens = typeof cached === 'number' && Number.isFinite(cached) && cached > 0
      ? Math.min(cached, input)
      : 0
    const current = usageByModel.get(publicModel) ?? { input: 0, output: 0, cached: 0 }
    current.input += input
    current.output += output
    current.cached += cachedTokens
    usageByModel.set(publicModel, current)
  }
  if (usageByModel.size === 0) return undefined
  const models: Record<string, number> = {}
  let totalUsd = 0
  for (const [publicModel, usage] of usageByModel) {
    const modelId = publicModel.slice('devin/'.length)
    const pricing = devinProvider.models.find((model) => model.id === modelId)?.pricing
    // Unknown catalog price: omit the model rather than fabricate a figure.
    // A known price of zero (a catalog free model) stays in at $0.
    if (pricing === undefined) continue
    const [cachedPrice, inputPrice, outputPrice] = pricing
    const usd = ((usage.input - usage.cached) * inputPrice + usage.cached * cachedPrice + usage.output * outputPrice) / 1e6
    if (!Number.isFinite(usd) || usd < 0) continue
    models[publicModel] = usd
    totalUsd += usd
  }
  if (Object.keys(models).length === 0) return undefined
  return { window: window.name, models, totalUsd }
}

/**
 * Attaches `estimatedSpend` to a Devin quota snapshot: one entry per quota
 * window whose recorded traffic priced against the catalog. Other providers
 * and windows with no priced traffic keep the field absent.
 */
function attachDevinEstimatedSpend(
  snapshot: import('@wrenyard/protocol/provider').ProviderQuotaSnapshot,
  catalog: import('@wrenyard/providers/catalog').Catalog,
  database: ForemanDatabase,
): void {
  const devinProvider = catalog.provider('devin')
  const estimatedSpend = (snapshot.windows ?? [])
    .map((window) => devinWindowEstimatedSpend(database, devinProvider, window))
    .filter((entry): entry is import('@wrenyard/protocol/provider').ProviderEstimatedSpend => entry !== undefined)
  if (estimatedSpend.length > 0) snapshot.estimatedSpend = estimatedSpend
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
  workBuddyProviders: readonly [WorkBuddyProvider, WorkBuddyProvider]
  /** Live CodeBuddy provider instance shared by the catalog; refreshModels re-runs discovery. */
  codeBuddyProvider: CodeBuddy
  /** Canonical task dispatch plans keyed by provider/model:client targets. */
  dispatchPlans: Readonly<Record<string, import('@wrenyard/providers/catalog').DispatchPlan>>
  taskDispatchResolver: TaskDispatchResolver
}

async function bootstrapForemanDaemonRuntime(): Promise<ForemanDaemonRuntime> {
  // Startup-only migration: convert a legacy auto_vacuum=NONE database to
  // INCREMENTAL on a worker thread before initDb opens it and before IPC
  // serves clients. A failure is logged and never blocks startup.
  try {
    await ensureIncrementalAutoVacuum(join(foremanStateRoot(), 'wrenyard.db'))
  } catch (error) {
    writeDaemonLog('warn', 'database auto-vacuum conversion failed', error)
  }
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
  const codeBuddyProvider = createCodeBuddy({
    product: {
      status: install.product.status,
      // The safe discovery reason must reach the provider so a failed startup
      // discovery explains itself instead of surfacing as a silent empty catalog.
      ...(install.product.reason ? { reason: install.product.reason } : {}),
      environment: install.product.environment,
      entries: install.product.entries,
      ...(install.product.identity ? { identity: install.product.identity } : {}),
      ...(install.account ? { account: install.account } : {}),
    },
    // The loader receives the provider's current environment so a refresh that
    // discovered a new environment re-scopes the auth-file read instead of
    // pinning the startup environment.
    account: (environment) => codeBuddyClient.readAccountContext(environment),
    // Explicit refresh re-runs the complete install read (forced, never the
    // client cache) and republishes product, account, environment and models
    // together, so a recovered install restores the catalog without a restart.
    discover: async () => {
      const next = await codeBuddyClient.readInstall({ refresh: true })
      return {
        status: next.product.status,
        ...(next.product.reason ? { reason: next.product.reason } : {}),
        environment: next.product.environment,
        entries: next.product.entries,
        ...(next.product.identity ? { identity: next.product.identity } : {}),
        ...(next.account ? { account: next.account } : {}),
      }
    },
  })
  const devin = createDevin()
  try { await devin.refreshModels() } catch { /* Missing auth or discovery must not stop daemon startup. */ }
  const [workBuddy, workBuddyAi] = createWorkBuddyProviders()
  for (const provider of [workBuddy, workBuddyAi]) {
    try {
      if (await provider.credential()) await provider.refreshModels()
    } catch { /* Missing auth or discovery must not stop daemon startup. */ }
  }
  const opencodeZen = createOpenCodeZen()
  try { await opencodeZen.refreshModels() } catch { /* catalog refresh must not stop startup */ }
  // Unregistered live free rows are diagnostics only; registration is owned by
  // the unified registry and an unregistered promotion is never callable.
  const unregisteredFreeIds = opencodeZen.unregisteredFreeIds()
  if (unregisteredFreeIds.length > 0) {
    writeDaemonLog('info', `opencode-zen: unregistered free catalog rows kept for diagnostics only: ${unregisteredFreeIds.join(', ')}`)
  }
  const catalog = createBuiltinCatalog([codeBuddyProvider, devin, workBuddy, workBuddyAi, opencodeZen])
  const providerRuntime = createBuiltinProviderRuntime({
    providers: [codeBuddyProvider, devin, workBuddy, workBuddyAi, opencodeZen],
    // The ChatGPT subscription gateway credential is read and refreshed through
    // the existing Codex native auth path (honoring the native CODEX_HOME or the
    // user home); the providers package authors no login of its own.
    codexGatewayAuth: {
      read: () => readCodexGatewayCredential(),
      refresh: (credential, signal) => refreshCodexGatewayCredential(credential, { signal }),
    },
  })
  // The dispatch resolver re-enumerates task candidates and derives their
  // runtime plans from the live catalog on every resolution, so a model added or
  // removed by a later discovery refresh becomes task-usable without a daemon
  // restart. This startup dictionary only seeds the launched-client environment
  // contract; it is never the resolver's task-routing snapshot.
  const dispatchPlans = deriveTaskDispatchPlans(catalog)
  // The local speed window is loaded once here, before the dispatch resolver
  // can serve routing, provider listing or dispatch. Every later request is
  // served from memory and refreshed per execution on completion, so no routing
  // path re-runs the historical TPS queries.
  initializeLocalSpeedSamples(db)
  startStatsDayCacheBackgroundSealer({ isShuttingDown: () => false })
  const taskDispatchResolver = await createTaskDispatchResolver({
    catalog,
    runtime: providerRuntime,
    // Share response-paired TPS across statistics and automatic routing.
    localSpeed: () => readLocalSpeedSamplesCached(),
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
      canStartExecution: () => lowDiskStateForProcess,
      // A committed `done` execution refreshes exactly its own sample in the
      // in-memory local speed window.
      onExecutionCompleted: (executionId) => updateLocalSpeedSample(executionId, db),
    })
    const runner = new TaskWorkflowRunner({
      db,
      agentExecutionHost: supervisor,
      logger: createDaemonSupervisorLogger(),
      taskDispatchResolver,
    })
    await supervisor.markInterruptedOnStartup()
    // Reclaim the run-scoped client data of runs that are provably dead. This
    // runs after execution reconciliation and before the IPC server is exposed,
    // so a crash leftover is gone before new work can arrive. The cleanup service
    // fails closed (no deletion on error) and a failure is never fatal to startup.
    try {
      await runManagedCleanup({ categories: ['clients'], trigger: 'startup' })
    } catch (error) {
      writeDaemonLog('warn', 'startup client run-home cleanup failed', error)
    }
    setAgentExecutionSupervisor(supervisor)
    setTaskWorkflowRunner(runner)

    return { db, repoWriteLocks, supervisor, runner, execService, operationComponents, operationAdapter, catalog, providerRuntime, workBuddyProviders: [workBuddy, workBuddyAi], codeBuddyProvider, dispatchPlans, taskDispatchResolver }
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
  const tasks = dbQuery<{ count: number }>(`SELECT COUNT(*) AS count FROM tasks WHERE status IN ('queued', 'running')`)
  const workflows = dbQuery<{ count: number }>(`SELECT COUNT(*) AS count FROM workflows WHERE status IN ('running')`)
  const executions = dbQuery<{ count: number }>(`SELECT COUNT(*) AS count FROM executions WHERE status IN ('queued', 'starting', 'running')`)
  // The real taskgraph count, not the legacy workflow count above. Uses the
  // exact same condition isIdle() applies to decide a taskgraph run is still
  // active: running, cancel requested, paused on a running node, or paused and
  // about to fail-cancel.
  const taskgraphs = dbQuery<{ count: number }>(
    `SELECT COUNT(DISTINCT r.id) AS count FROM taskgraph_run r
     LEFT JOIN taskgraph_node_state n ON n.taskgraph_id = r.id
     WHERE r.state = 'running' OR r.cancel_requested = 1
        OR (r.state = 'paused' AND n.state = 'running')
        OR (r.state = 'paused' AND r.on_node_failure = 'cancel' AND n.state = 'failed')`,
  )
  return {
    activeTaskCount: tasks[0]?.count ?? 0,
    activeWorkflowCount: workflows[0]?.count ?? 0,
    activeExecutionCount: executions[0]?.count ?? 0,
    activeTaskGraphCount: taskgraphs[0]?.count ?? 0,
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

/**
 * The supervisor's hard cap on concurrently running executions. Mirrors
 * `MAX_CONCURRENT_EXECUTIONS` in `agent-supervisor.mts`; the bot only reports
 * it, the supervisor still enforces it.
 */
const MAX_CONCURRENT_EXECUTIONS = 10

/**
 * Bound for the graceful drain on a requested shutdown. Once the drain
 * exceeds this, it escalates to the forced path: active work is cancelled
 * and teardown proceeds, so a single SIGTERM always leads to exit.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000

/**
 * Interval between scheduled database retention passes (6 hours). The timer
 * is unref'd so it never keeps the daemon alive, and close() clears it.
 */
const DB_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Delay before the first workspace memory consolidation pass after attach (60 seconds). */
const MEMORY_CONSOLIDATION_INITIAL_DELAY_MS = 60_000
/** Interval between workspace memory consolidation passes (24 hours). */
const MEMORY_CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Maximum memory names included per merge/prune field in consolidation logs. */
const MEMORY_CONSOLIDATION_LOG_NAME_LIMIT = 20

/**
 * Live daemon execution load, read from the database directly with no IPC round
 * trip: how many executions are active versus queued, and how long the oldest
 * queued one has waited.
 */
function readExecutionLoad(db: ForemanDatabase) {
  const active = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM executions WHERE status IN ('starting','running')",
  ).get()
  const queued = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM executions WHERE status = 'queued'",
  ).get()
  const oldest = db.prepare<[], { created_at: string | null }>(
    "SELECT MIN(created_at) AS created_at FROM executions WHERE status = 'queued'",
  ).get()
  const oldestAt = oldest?.created_at ?? null
  const oldestQueuedMs = oldestAt === null ? undefined : Math.max(0, Date.now() - Date.parse(oldestAt))
  return {
    activeExecutions: active?.count ?? 0,
    maxExecutions: MAX_CONCURRENT_EXECUTIONS,
    queuedExecutions: queued?.count ?? 0,
    ...(oldestQueuedMs === undefined || Number.isNaN(oldestQueuedMs) ? {} : { oldestQueuedMs }),
  }
}
