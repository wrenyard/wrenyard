import { createAgentClients, type AgentClient, type AgentEvent, type AgentRequest, type AgentSession } from '@wrenyard/clients';
import { messageEvent } from '@wrenyard/agent-client/native';
import { ExecService, type ExecRequest } from '@wrenyard/exec';
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ForemanDatabase } from '../../db/types.mts'
import { resolveWrenyardSuiteRoot } from '../../layout/suite-root.mts'
import { ExecutionEventStore } from '../../db/stores/execution-event-store.mts'
import { TaskRunStore } from '../../db/stores/task-run-store.mts'
import { assertValidTimeoutMs } from '@wrenyard/task'
import { killProcessTree } from '../../adapters/shell/process.mts'
import { redactDiagnosticText, redactEvent, redactJsonString } from './redaction.mts'
import { RepoWriteLocks } from './repo-write-locks.mts'
import { minimalRunFactsForTaskRun } from './run-facts.mts'
import { desktopLane, DesktopLaneClosedError, toOperationIds, OperationAdapter } from './operation-adapter.mts'

function summaryFromTerminalOutput(output: string | null | undefined): string | undefined {
  if (!output) return undefined
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return undefined
}
import { parseRunSyntax, type ReasoningEffort } from '@wrenyard/providers/catalog'
import { createBuiltinCatalog } from '@wrenyard/providers'
import type {
  AgentExecutionHost,
  ClientFamily,
  ExecutionHandle,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
  StartAgentExecutionOptions as StartExecutionOpts,
} from '../../core/operations/types.mts'
export type {
  ClientFamily,
  ExecutionHandle,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
  StartAgentExecutionOptions as StartExecutionOpts,
} from '../../core/operations/types.mts'

const agentClients = createAgentClients();
const MAX_CONCURRENT_EXECUTIONS = 10
const SHUTDOWN_GRACE_MS = 10_000
const STDERR_TAIL_MAX_LEN = 4_000
/**
 * Upper bound on retained assistant message text for one execution, in UTF-16
 * code units. Same code-unit accounting as `tailString`, so a run's retained
 * output can never exceed this regardless of how many chunks it streams.
 */
const OUTPUT_MAX_CHARS = 256 * 1024
const OUTPUT_HEAD_CHARS = 128 * 1024
const OUTPUT_TRUNCATION_MARKER = '\n\n[... output truncated ...]\n\n'
const OUTPUT_TAIL_CHARS = OUTPUT_MAX_CHARS - OUTPUT_HEAD_CHARS - OUTPUT_TRUNCATION_MARKER.length
/** Part count above which a region is collapsed into one joined string. */
const OUTPUT_COMPACT_PARTS = 512
/**
 * Default bound for settling a registered active-execution cancellation when
 * the child-close/stream observer is absent or stalled. After the process-tree
 * kill succeeds (or the registered PID is already absent), the supervisor waits
 * up to this long for the observer to commit the terminal state, then uses the
 * shared compare-and-set reconciler to durably terminalize the execution as
 * cancelled.
 */
const CANCEL_SETTLEMENT_TIMEOUT_MS = 5_000
/**
 * Fixed value written to the INERT `executions.permission` DB legacy column.
 * The column is retained only for schema compatibility: it is never read,
 * interpreted, or migrated. There is no permission concept in execution.
 */
const EXECUTIONS_LEGACY_PERMISSION = 'yolo'

export interface AgentExecutionSupervisorOptions {
  clients?: ReadonlyMap<string, AgentClient>
  canStartExecution?: () => { status: 'ok' | 'low' | 'unavailable'; availableBytes: number | null; minimumBytes: number; error: string | null }
  db: ForemanDatabase
  repoWriteLocks: RepoWriteLocks
  logger?: SupervisorLogger
  /**
   * Injectable cancellation-settlement timeout. Bounds how long a registered
   * active-execution cancel waits for the child-close/stream observer before
   * the compare-and-set reconciler terminalizes the execution directly.
   * Defaults to CANCEL_SETTLEMENT_TIMEOUT_MS.
   */
  cancelSettlementTimeoutMs?: number
  /**
   * Injectable process-tree kill implementation. Defaults to killProcessTree.
   * Tests inject throwing or no-op implementations to prove that a
   * verified-live uncontrolled process can never be declared terminal.
   */
  killProcessTreeImpl?: (pid: number, pgid?: number) => Promise<void>
  /**
   * Injectable process liveness probe. Defaults to the process.kill(pid, 0)
   * check. Tests inject a constant-live probe to prove a PID that remains live
   * after a kill keeps the execution/task active and repo-write protected.
   */
  isProcessLiveImpl?: (pid: number) => boolean
  catalog?: ReturnType<typeof createBuiltinCatalog>
  /**
   * Shared raw prompt-execution service. When supplied, every task attempt is
   * lowered onto `ExecService.start` instead of calling the agent client
   * directly, so the task path and the explicit `wrenyard exec` path share one
   * launch/feature/replay implementation. When omitted, the supervisor builds
   * and owns a standalone `ExecService` over its own client map so it can always
   * call `ExecService.start`. The supervisor still owns DB persistence,
   * scheduling, leases, repo-write locks, resolved routing, and prompt
   * translation; the ExecService only runs the resolved client.
   */
  execService?: ExecService
  /**
   * Shared operation execution adapter. When supplied, a run that requests
   * legacy browser/computer operation ids resolves them through it before the
   * run starts, so the adapter verifies the components on this host and attaches
   * the agent-browser CLI environment or the Cua Driver MCP server.
   */
  operations?: OperationAdapter
  /**
   * Best-effort notification that an execution reached a committed `done`
   * terminal state. The daemon refreshes the in-memory local speed window here;
   * a throwing callback is logged and never rejects the committed execution.
   */
  onExecutionCompleted?: (executionId: string) => void
  /**
   * Notification that an execution was admitted at start. Carries the owning
   * task run id and resolved dispatch mode when known, so consumers tracking
   * active gateway membership can register it. A throwing callback is logged
   * and never rejects admission.
   */
  onExecutionStarted?: (executionId: string, info: { taskRunId?: string; mode?: 'native' | 'gateway' }) => void
  /**
   * Notification that an execution reached a committed terminal state on any
   * path (done, failed, cancelled, timeout, interrupted — queued, starting,
   * running, shutdown and startup-reconcile alike). A throwing callback is
   * logged and never rejects the committed terminal.
   */
  onExecutionTerminal?: (executionId: string) => void
}

/**
 * Structured failure surfaced when a recorded process cannot be verified absent
 * before an execution is terminalized or its repo-write protection is released.
 * Thrown by the no-registry cancel path and returned by markInterruptedOnStartup
 * so callers can distinguish a controlled cancellation from a verified-live
 * uncontrolled process.
 */
export class ExecutionTerminationFailure extends Error {
  constructor(
    readonly executionId: string,
    readonly pid: number | undefined,
    readonly action: 'cancel' | 'startup-interrupt',
    readonly phase: 'kill' | 'verify',
    message: string,
  ) {
    super(message)
    this.name = 'ExecutionTerminationFailure'
  }
}

export interface SupervisorLogger {
  debug?(message: string, meta?: unknown): void
  info?(message: string, meta?: unknown): void
  warn?(message: string, meta?: unknown): void
  error?(message: string, meta?: unknown): void
}

interface RegistryEntry {
  executionId: string
  taskId?: string
  cwd: string
  repoWriteLock: boolean
  writePaths?: readonly string[]
  /** Private admission-only binding retained in memory while queued. */
  admissionBinding?: StartExecutionOpts['executionAdmission']
  /** Resolved agent client; retained so post-commit `finalize` can run. */
  agentClient?: AgentClient
  agentEnv?: NodeJS.ProcessEnv
  finalization?: Promise<void>
  clientStartDone?: Promise<void>
  resolveClientStartDone?: () => void
  clientStreamDone?: Promise<void>
  resolveClientStreamDone?: () => void
  session?: AgentSession
  pid?: number
  pgid?: number
  timeoutTimer?: ReturnType<typeof setTimeout>
  cancelRequested: boolean
  shutdownRequested: boolean
  timedOut: boolean
  terminalGeneration: number
  terminalIntent?: TerminalIntent
  killPromise?: Promise<void>
  resolveWait: (result: ExecutionResult) => void
  rejectWait: (error: unknown) => void
  waitPromise: Promise<ExecutionResult>
  seq: number
  hasRepoLock: boolean
  wasQueued: boolean
  outputParts: string[]
  /**
   * Natural-language prose of a run that ends abnormally, in event order. It
   * holds assistant message text and the terminal final answer; tool inputs and
   * results are never collected here.
   */
  abnormalProseParts: string[]
  /** First-seen counts of tool calls keyed by redacted tool name. */
  toolCallCounts: Map<string, number>
  /** Code units held before truncation, or in the retained head afterwards. */
  outputHeadChars: number
  /** Code units held after the truncation marker. */
  outputTailChars: number
  /** True once the middle of the output has been replaced by the marker. */
  outputTruncated: boolean
  finalOutput?: string
  rawResult?: string
  streamDone?: Promise<void>
  finished?: Extract<AgentEvent, { type: 'finished' }>
  pendingNativeSessionId?: string
  pendingClientFamily?: ClientFamily
  pendingFailureClass?: string
  /** Resolved by the attempt-deadline (timeout) handler so a bounded
   *  stream-drain await converges at the deadline instead of hanging on a
   *  held stdio pipe after an early child close. */
  attemptDeadlinePromise?: Promise<void>
}

type ExecutionRecordWithFeatures = ExecutionRecord & { features: string | null }
/** Lightweight queued-row projection used only to identify launch candidates. */
type QueuedCandidateRow = Pick<ExecutionRecord, 'id' | 'cwd'>
/** Columns a queue promotion actually needs before handing off to launch. */
type LaunchFieldRow = Pick<
  ExecutionRecord,
  'id' | 'cwd' | 'task_id' | 'profile' | 'prompt' | 'native_session_id' | 'timeout_ms' | 'client_family'
> & { features: string | null }
type TerminalStatus = 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'
type KillReason = 'cancel' | 'timeout' | 'shutdown' | 'crash' | 'spawn-error' | null
type TerminalIntent =
  | { kind: 'cancel' }
  | { kind: 'timeout' }
  | { kind: 'shutdown' }
type BClassEvent = {
  type: 'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'turn_usage'
  data: Record<string, unknown>
}

export class AgentExecutionSupervisor implements AgentExecutionHost {
  private readonly db: ForemanDatabase
  private readonly repoWriteLocks: RepoWriteLocks
  private readonly logger?: SupervisorLogger
  private readonly cancelSettlementTimeoutMs: number
  private readonly killProcessTreeFn: (pid: number, pgid?: number) => Promise<void>
  private readonly isProcessLiveFn: (pid: number) => boolean
  private readonly catalog: ReturnType<typeof createBuiltinCatalog>
  private readonly execService: ExecService
  private readonly operations?: OperationAdapter
  private readonly onExecutionCompleted?: (executionId: string) => void
  private readonly onExecutionStarted?: AgentExecutionSupervisorOptions['onExecutionStarted']
  private readonly onExecutionTerminal?: AgentExecutionSupervisorOptions['onExecutionTerminal']
  /** True when this supervisor built its own fallback ExecService and must
   *  close it on shutdown. A shared, externally supplied service is never
   *  closed here. */
  private readonly ownsExecService: boolean
  private readonly clients: ReadonlyMap<string, AgentClient>
  private readonly registry = new Map<string, RegistryEntry>()
  private acceptingNew = true
  private promoting = false
  private readonly canStartExecution?: AgentExecutionSupervisorOptions['canStartExecution']

  constructor({ db, repoWriteLocks, logger, cancelSettlementTimeoutMs, killProcessTreeImpl, isProcessLiveImpl, catalog, clients, execService, operations, canStartExecution, onExecutionCompleted, onExecutionStarted, onExecutionTerminal }: AgentExecutionSupervisorOptions) {
    this.db = db
    this.repoWriteLocks = repoWriteLocks
    this.logger = logger
    this.cancelSettlementTimeoutMs = cancelSettlementTimeoutMs ?? CANCEL_SETTLEMENT_TIMEOUT_MS
    this.killProcessTreeFn = killProcessTreeImpl ?? killProcessTree
    this.isProcessLiveFn = isProcessLiveImpl ?? defaultIsProcessLive
    this.catalog = catalog ?? createBuiltinCatalog()
    // A standalone supervisor (isolated tests, library use) always runs through
    // an ExecService. It builds one over its own client map when the daemon does
    // not supply the shared configured service, so the supervisor never has a
    // direct client.start fallback and always owns only what it created.
    // The execution service owns the client instances used by start. Use that
    // same group for supervisor lifecycle finalization when supplied alone.
    this.execService = execService ?? new ExecService({ clients: clients ?? agentClients })
    this.clients = new Map(
      [...new Set([...agentClients.keys(), ...(clients?.keys() ?? [])])]
        .flatMap((id) => {
          const client = this.execService.getClient(id)
          return client ? [[id, client] as const] : []
        }),
    )
    this.ownsExecService = execService === undefined
    this.operations = operations
    this.canStartExecution = canStartExecution
    this.onExecutionCompleted = onExecutionCompleted
    this.onExecutionStarted = onExecutionStarted
    this.onExecutionTerminal = onExecutionTerminal
  }

  /** Best-effort terminal notification shared by every terminalize path; a
   *  throwing callback is logged and never affects the committed terminal. */
  private notifyExecutionTerminal(executionId: string): void {
    try {
      this.onExecutionTerminal?.(executionId)
    } catch (error) {
      this.log('warn', `[foreman] Failed to report terminal for execution ${executionId}: ${errorMessage(error)}`)
    }
  }

  private taskRuns(): TaskRunStore {
    return new TaskRunStore(this.db)
  }

  private executionEvents(): ExecutionEventStore {
    return new ExecutionEventStore(this.db)
  }

  async startExecution(rawOpts: StartExecutionOpts): Promise<ExecutionHandle> {
    if (!this.acceptingNew) throw new Error('AgentExecutionSupervisor is not accepting new executions')
    const disk = this.canStartExecution?.()
    if (disk && disk.status !== 'ok') throw new Error(`low_disk_space: ${disk.status === 'low' ? `available ${disk.availableBytes} bytes is below the ${disk.minimumBytes} byte minimum` : `state-volume sample failed: ${disk.error ?? 'unknown error'}`}; free space on the Wrenyard state volume and retry`)
    const opts = normalizeStartExecutionOpts(rawOpts)
    assertStartExecutionOpts(opts)

    const executionId = generateExecutionId()
    const createdAt = nowIso()
    const canRunNow = this.runningCount() < MAX_CONCURRENT_EXECUTIONS
    let hasRepoLock = false
    const requiresLock = opts.repoWriteLock === true
    let entry: RegistryEntry | undefined

    const initialEventType = canRunNow ? 'dispatch' : 'queue-waiting'

    let attachFailed = false
    try {
      this.tx(() => {
        this.run(
          `INSERT INTO executions (
            id, task_id, profile, permission, cwd, prompt, features,
            status, native_session_id, client_family, timeout_ms,
            requested_agent_runtime, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
          executionId,
          opts.taskId ?? null,
          opts.profile,
          // INERT DB legacy column: the schema still requires a permission value,
          // so a fixed literal is written. It is never read or interpreted.
          EXECUTIONS_LEGACY_PERMISSION,
          opts.cwd,
          opts.prompt,
          opts.features ? JSON.stringify(opts.features) : null,
          opts.resume ?? null,
          opts.clientFamily ?? null,
          opts.timeoutMs ?? null,
          opts.requestedAgentRuntime ?? null,
          createdAt,
          createdAt,
        )

        // Persist the full per-attempt dispatch snapshot (client/provider/model/
        // model_id/mode/protocol + speed evidence + intelligence + reference
        // pricing) keyed by the generated execution id and the task id. Each
        // execution attempt stores its own row; an absent snapshot or task id
        // writes nothing.
        if (opts.taskId && opts.dispatchSnapshot) {
          const snap = opts.dispatchSnapshot
          this.run(
            `INSERT INTO task_run_attempt_dispatch (
              execution_id, task_run_id, requested_agent_runtime,
              profile, client, provider, model, model_id, mode, protocol,
              speed_effective_tps, speed_source, speed_sample_count, speed_checked_at,
              speed_expected_tps_met, speed_degradation_reason, intelligence, reasoning_effort, fast,
              reference_pricing_input, reference_pricing_output, reference_pricing_cache,
              reference_pricing_cache_write, reference_pricing_source, reference_pricing_checked_at,
              auto_routing,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            executionId,
            opts.taskId,
            snap.requested_agent_runtime ?? null,
            snap.profile ?? null,
            snap.client ?? null,
            snap.provider ?? null,
            snap.model ?? null,
            snap.model_id ?? null,
            snap.mode ?? null,
            snap.protocol ?? null,
            snap.speed.effective_tps ?? null,
            snap.speed.source ?? null,
            snap.speed.sample_count ?? null,
            snap.speed.checked_at ?? null,
            snap.speed.expected_tps_met ? 1 : 0,
            snap.speed.degradation_reason ?? null,
            snap.intelligence ?? null,
            snap.reasoningEffort ?? null,
            snap.fast === undefined ? null : (snap.fast ? 1 : 0),
            snap.reference_pricing.input_usd_per_million ?? null,
            snap.reference_pricing.output_usd_per_million ?? null,
            snap.reference_pricing.cached_input_usd_per_million ?? null,
            snap.reference_pricing.cache_write_input_usd_per_million ?? null,
            snap.reference_pricing.source ?? null,
            snap.reference_pricing.checked_at ?? null,
            // Automatic attempts persist their privacy-safe routing decision as
            // JSON text; explicit/legacy attempts with no decision store NULL.
            snap.auto_routing ? JSON.stringify(snap.auto_routing) : null,
            createdAt,
            createdAt,
          )
        }

        if (opts.taskId) {
          const attached = this.taskRuns().attachExecution(opts.taskId, executionId, createdAt)
          if (!attached) attachFailed = true
        }

        if (requiresLock) {
          const lock = this.repoWriteLocks.tryAcquire(opts.cwd, executionId, repoWriteLockMode(opts.writePaths), opts.writePaths)
          hasRepoLock = lock.acquired
        }
        // A later attempt of a running task that has to wait puts the task back in the queue.
        if (opts.taskId && (!canRunNow || (requiresLock && !hasRepoLock))) {
          this.taskRuns().markWaiting(opts.taskId, createdAt)
        }

        // Repo lock conflicts wait in the FIFO queue and emit queue-waiting; lock-lost is reserved
        // for an execution that previously held a write lock and then loses it.
        this.insertEvent({
          executionId,
          taskId: opts.taskId,
          seq: 1,
          type: hasRepoLock || !requiresLock ? initialEventType : 'queue-waiting',
          data: dropUndefined({
            profile: opts.profile,
            cwd: opts.cwd,
            client_family: opts.clientFamily,
          }),
          timestamp: createdAt,
        })
      })

      if (attachFailed) {
        // The task became terminal before this execution could bind to it. Do not launch
        // Wrenyard; synchronously terminalize the new execution as cancelled and release any
        // repo write lock that was acquired for it.
        entry = this.createRegistryEntry(executionId, opts, hasRepoLock, 1)
        this.registry.set(executionId, entry)
        this.terminalizeQueued(entry, 'cancelled', 'cancel', 'cancelled')
        return {
          executionId,
          pid: entry.pid,
          wait: () => this.waitExecution(executionId),
          cancel: () => this.cancelExecution(executionId),
        }
      }

      entry = this.createRegistryEntry(executionId, opts, hasRepoLock, 1)
      this.registry.set(executionId, entry)

      // Admission is durable: report the execution start with its owning task
      // run id and resolved dispatch mode so consumers tracking active
      // gateway executions can register membership. A throwing callback is
      // logged and never rejects admission.
      try {
        this.onExecutionStarted?.(executionId, {
          ...(opts.taskId === undefined ? {} : { taskRunId: opts.taskId }),
          ...(opts.dispatchSnapshot?.mode === 'native' || opts.dispatchSnapshot?.mode === 'gateway'
            ? { mode: opts.dispatchSnapshot.mode }
            : {}),
        })
      } catch (startCallbackError) {
        this.log('warn', `[foreman] Failed to report start for execution ${executionId}: ${errorMessage(startCallbackError)}`)
      }

      if (canRunNow && (!requiresLock || hasRepoLock)) {
        await this.launchExecution(entry, opts, false)
      }

      return {
        executionId,
        pid: entry.pid,
        wait: () => this.waitExecution(executionId),
        cancel: () => this.cancelExecution(executionId),
      }
    } catch (error) {
      throw error
    }
  }

  waitExecution(executionId: string): Promise<ExecutionResult> {
    const entry = this.registry.get(executionId)
    if (entry) return entry.waitPromise

    const row = this.getExecution(executionId)
    if (!row) return Promise.reject(new Error(`Unknown execution '${executionId}'`))
    if (isTerminalStatus(row.status)) return Promise.resolve(resultFromRow(row))

    return Promise.reject(new Error(`Execution '${executionId}' is not supervised by this process`))
  }

  async cancelExecution(executionId: string): Promise<void> {
    const entry = this.registry.get(executionId)
    if (!entry) {
      await this.cancelQueuedExecutionWithoutRegistry(executionId)
      return
    }

    const claimed = this.claimTerminalIntent(entry, { kind: 'cancel' })
    entry.cancelRequested = true

    if (!entry.session || !entry.pid) {
      if (claimed) this.terminalizeQueued(entry, 'cancelled', 'cancel', 'cancelled')
      return
    }

    // Request Wrenyard termination, then block until child close and stream completion
    // have committed the terminal execution, task, events, and repo lock release.
    await this.requestKillOnce(entry)

    // Healthy path: the observer terminalizes the execution within the bound.
    // A stalled observer (absent PID whose stdio pipe is held open by a detached
    // process) must not hang cancellation forever, so race the wait promise
    // against the cancellation-settlement bound and then reconcile directly.
    const settled = await this.raceCancellationSettlement(entry)
    if (settled === 'wait') return

    // The observer did not commit the terminal state within the bound. Only
    // reconcile when the process is verified absent; a verified-live process
    // that could not be controlled must not be reported as cancelled.
    if (entry.pid !== undefined && this.isProcessLive(entry.pid)) {
      throw new Error(
        `Cancellation of execution '${entry.executionId}' could not control still-live process ${entry.pid}`,
      )
    }
    this.settleRegisteredCancellation(entry)
  }

  getExecution(executionId: string): ExecutionRecord | undefined {
    return this.get<ExecutionRecord>(
      `SELECT id, task_id, profile, cwd, prompt, status,
        native_session_id, client_family, pid, pgid, output, raw_result, error, exit_code,
        kill_reason, timeout_ms, created_at, started_at, requested_agent_runtime, resolved_profile
      FROM executions
      WHERE id = ?`,
      executionId,
    )
  }

  /**
   * Interrupt stale executions from a previous supervisor lifetime. Every stale
   * execution with a recorded PID is killed first and its recorded PID verified
   * absent before its execution/task terminal state is reconciled or its
   * repo-write protection is released. A kill that throws, uncertain ownership,
   * or a PID that remains live keeps the execution and its linked task active
   * and protected, and a structured failure is surfaced instead of swallowed.
   * Returns the surfaced failures (empty when every stale process was verified
   * absent). Every queued, starting or running row is terminalized as
   * interrupted; nothing is relaunched on startup.
   */
  async markInterruptedOnStartup(): Promise<ExecutionTerminationFailure[]> {
    const timestamp = nowIso()

    // Persisted rows are the authoritative kill source for a fresh supervisor.
    const staleRows = this.query<{ id: string; task_id: string | null; pid: number | null; pgid: number | null; features: string | null }>(
      `SELECT id, task_id, pid, pgid, features
       FROM executions
       WHERE status IN ('queued', 'starting', 'running')`,
    )

    const interruptible: Array<{ id: string; taskId: string | null }> = []
    const failures: ExecutionTerminationFailure[] = []
    const liveRows: typeof staleRows = []
    const processlessRows: typeof staleRows = []
    const failedTaskIds = new Set<string>()

    for (const row of staleRows) {
      // No recorded process to protect; terminalize through the CAS path below.
      if (row.pid === null || row.pid === undefined) {
        processlessRows.push(row)
        continue
      }

      try {
        await this.killProcessTreeFn(row.pid, row.pgid ?? undefined)
      } catch (error: unknown) {
        failures.push(new ExecutionTerminationFailure(
          row.id,
          row.pid,
          'startup-interrupt',
          'kill',
          errorMessage(error),
        ))
        liveRows.push(row)
        if (row.task_id) failedTaskIds.add(row.task_id)
        continue
      }
      if (this.isProcessLive(row.pid)) {
        failures.push(new ExecutionTerminationFailure(
          row.id,
          row.pid,
          'startup-interrupt',
          'verify',
          `process ${row.pid} for stale execution '${row.id}' is still live after killProcessTree`,
        ))
        liveRows.push(row)
        if (row.task_id) failedTaskIds.add(row.task_id)
        continue
      }
      interruptible.push({ id: row.id, taskId: row.task_id })
    }

    for (const row of liveRows) {
      const features = parsePersistedFeatures(row.features)
      if (!features) continue
      let operationIds: string[]
      try {
        operationIds = toOperationIds(features)
      } catch {
        continue
      }
      if (operationIds.includes('desktop') || operationIds.includes('browser')) {
        desktopLane.adoptOwner(row.task_id ?? row.id)
      }
    }

    for (const stale of processlessRows) {
      interruptible.push({ id: stale.id, taskId: stale.task_id })
    }

    for (const failure of failures) {
      this.log('warn', `[foreman] Failed to interrupt stale execution ${failure.executionId} on startup`, {
        executionId: failure.executionId,
        pid: failure.pid,
        action: failure.action,
        phase: failure.phase,
        result: 'failed',
        error: failure.message,
      })
    }

    // Only executions whose recorded PID was verified absent may be terminalized;
    // failed ones stay active and keep their repo-write protection.
    for (const target of interruptible) {
      this.tx(() => {
        const claimed = this.run(
          `UPDATE executions
          SET status = 'interrupted', kill_reason = 'shutdown', ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'starting', 'running')`,
          timestamp,
          timestamp,
          target.id,
        )
        if (claimed.changes !== 1) return
        if (target.taskId) {
          this.taskRuns().markTerminal({
            taskRunId: target.taskId,
            status: 'interrupted',
            error: 'interrupted on startup',
            endedAt: timestamp,
            facts: minimalRunFactsForTaskRun(target.taskId, 'interrupted'),
          })
        }
        this.repoWriteLocks.releaseByExecution(target.id)
      })
    }

    // Tasks whose execution could not be verified dead stay active; the
    // remaining processless queued/running tasks are interrupted.
    for (const task of this.query<{ id: string }>(`SELECT id FROM tasks WHERE status IN ('queued', 'running')`)) {
      if (failedTaskIds.has(task.id)) continue
      this.taskRuns().markTerminal({
        taskRunId: task.id,
        status: 'interrupted',
        error: 'interrupted on startup',
        endedAt: timestamp,
        facts: minimalRunFactsForTaskRun(task.id, 'interrupted'),
      })
    }

    for (const entry of [...this.registry.values()]) {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
      this.resolveAndForget(entry, {
        executionId: entry.executionId,
        status: 'interrupted',
        error: 'interrupted on startup',
        killReason: 'shutdown',
      })
    }

    return failures
  }

  stopAcceptingNew(): void {
    this.acceptingNew = false
  }

  async shutdown(): Promise<void> {
    this.stopAcceptingNew()
    const activeEntries = [...this.registry.values()].filter((entry) => entry.session && entry.pid)
    for (const entry of activeEntries) {
      entry.shutdownRequested = true
      this.claimTerminalIntent(entry, { kind: 'shutdown' })
      void this.requestKillOnce(entry).catch((error: unknown) => {
        this.log('warn', `[foreman] Failed to terminate execution ${entry.executionId}: ${errorMessage(error)}`)
      })
    }

    if (activeEntries.length > 0) {
      await sleep(SHUTDOWN_GRACE_MS)
    }

    for (const entry of [...this.registry.values()]) {
      if (!entry.session || !entry.pid) {
        if (this.claimTerminalIntent(entry, { kind: 'shutdown' })) {
          this.terminalizeQueued(entry, 'interrupted', 'shutdown', 'shutdown')
        }
        continue
      }
      entry.shutdownRequested = true
      this.claimTerminalIntent(entry, { kind: 'shutdown' })
      await this.requestKillOnce(entry)
    }

    // Bound the final settle wait: a child whose stdio pipes are held open by a
    // surviving descendant never closes, so without a deadline shutdown hangs.
    await Promise.race([
      Promise.allSettled([...this.registry.values()].map((entry) => entry.waitPromise)),
      sleep(CANCEL_SETTLEMENT_TIMEOUT_MS),
    ])

    // Close only the fallback ExecService this supervisor created. A shared,
    // externally supplied service is owned by its daemon and must not be closed
    // when one task's supervisor shuts down.
    if (this.ownsExecService) {
      try {
        await this.execService.close()
      } catch (error: unknown) {
        this.log('warn', `[foreman] failed to close owned exec service: ${errorMessage(error)}`)
      }
    }
  }

  private createRegistryEntry(
    executionId: string,
    opts: StartExecutionOpts,
    hasRepoLock: boolean,
    seq: number,
  ): RegistryEntry {
    let resolveWait!: (result: ExecutionResult) => void
    let rejectWait!: (error: unknown) => void
    const waitPromise = new Promise<ExecutionResult>((resolve, reject) => {
      resolveWait = resolve
      rejectWait = reject
    })

    return {
      executionId,
      taskId: opts.taskId,
      cwd: opts.cwd,
      repoWriteLock: opts.repoWriteLock === true,
      writePaths: opts.writePaths ? [...opts.writePaths] : undefined,
      admissionBinding: opts.executionAdmission
        ? Object.freeze({ ...opts.executionAdmission })
        : undefined,
      cancelRequested: false,
      shutdownRequested: false,
      timedOut: false,
      terminalGeneration: 0,
      resolveWait,
      rejectWait,
      waitPromise,
      seq,
      hasRepoLock,
      wasQueued: false,
      outputParts: [],
      abnormalProseParts: [],
      toolCallCounts: new Map(),
      outputHeadChars: 0,
      outputTailChars: 0,
      outputTruncated: false,
      pendingClientFamily: opts.clientFamily,
    }
  }

  private async launchExecution(
    entry: RegistryEntry,
    opts: StartExecutionOpts,
    fromQueue: boolean,
    launchOptions: { skipAdmissionCheck?: boolean } = {},
  ): Promise<void> {
    // Startup resume skips admission only: the row was admitted when it was
    // created, the low-disk sampler has not run yet during bootstrap, and the
    // desktop lane still serializes the actual start.
    if (!launchOptions.skipAdmissionCheck) {
      const disk = this.canStartExecution?.()
      if (disk && disk.status !== 'ok') {
        await this.terminalizeQueued(entry, 'failed', 'crash', `low_disk_space: state-volume status is ${disk.status}; free space and retry`)
        return
      }
    }
    if (entry.terminalGeneration > 0) return

    const resolvedProfile = this.readResolvedProfile(entry.executionId)

    let session: AgentSession
    const laneAbort = new AbortController()
    try {
      const profile = resolvedProfile ?? opts.profile;
      const syntax = profile.includes(':') ? parseRunSyntax(profile) : undefined;
      const clientId = syntax?.client ?? opts.clientFamily;
      const client = clientId ? this.clients.get(clientId) : undefined;
      if (!client?.capabilities.run) throw new Error('Execution requires a resolved agent client');
      if (!syntax?.model) throw new Error('Execution requires a resolved model');
      const plan = this.buildReasoningEffortPlanEnv(entry.executionId, opts.dispatchSnapshot?.fast)?.plan ?? this.catalog.resolveRun(syntax.client, syntax.provider, syntax.model, opts.dispatchSnapshot?.reasoningEffort, opts.dispatchSnapshot?.fast);
      // A native dispatch must hand the CLI the exact wire spelling the
      // installed product/login declares. The admission binding carries that wire id for
      // this exact execution (resolved from the current product snapshot when
      // the run was admitted); an explicit reasoning-effort-mapped substitution still
      // wins. The public canonical id stays in canonicalModel, so observed ids
      // normalize back and no wire spelling ever reaches a public surface.
      const launchModel = plan.upstreamModel
        ?? (plan.mode === 'native' ? entry.admissionBinding?.expectedWireModel : undefined)
        ?? syntax.model;
      this.log('debug', '[foreman] starting agent execution ' + entry.executionId, {client: client.id, model: syntax.model});
      // The resolved client/provider/model/mode/reasoning-effort/cwd are all owned by
      // the task layer. The daemon's shared ExecService only runs the resolved
      // client, so both this path and an explicit `wrenyard exec` share one
      // launch/feature/replay implementation.
      if (plan.reasoningEffort === undefined) throw new Error("Execution requires a persisted reasoningEffort");
      const agentRequest: AgentRequest = {
        executionId: entry.executionId,
        model: launchModel,
        canonicalModel: syntax.model,
        provider: syntax.provider,
        mode: plan.mode,
        protocol: plan.protocol,
        prompt: opts.prompt,
        cwd: opts.cwd,
        ...(opts.resume === undefined ? {} : { resumeSessionId: opts.resume }),
        reasoningEffort: plan.reasoningEffort,
        ...(plan.fast === undefined ? {} : { fast: plan.fast }),
        ...(plan.clientReasoningEffort === undefined ? {} : { clientReasoningEffort: plan.clientReasoningEffort }),
        ...(plan.clientReasoningEnvironment === undefined ? {} : { clientReasoningEnvironment: plan.clientReasoningEnvironment }),
        ...(plan.capabilities === undefined ? {} : { capabilities: plan.capabilities }),
      };
      const operationIds = toOperationIds(opts.features)
      const execRequest: ExecRequest = {
        ...agentRequest,
        client: client.id,
      };
      // The authoritative task run id is always derived from `opts.taskId`, whether the
      // execution launched immediately or was reconstructed from a persisted execution row.
      const baseEnv = resolveTaskAgentEnv(
        process.env,
        opts.taskId,
        this.buildReasoningEffortPlanEnv(entry.executionId, opts.dispatchSnapshot?.fast),
        entry.executionId,
      )
      const laneWatch = setInterval(() => {
        if (entry.cancelRequested || entry.terminalIntent) laneAbort.abort()
      }, 250)
      const operationOptions = {
        env: baseEnv,
        deferFinalize: true,
        onStreamClosed: () => entry.resolveClientStreamDone?.(),
        onPrepared: (env: NodeJS.ProcessEnv) => { entry.agentEnv = env },
        prepare: operationIds.length > 0 ? (() => {
          if (!this.operations) throw new Error('Operation components are not available in this runtime')
          return this.operations.preparation({
            ids: operationIds,
            runId: entry.executionId,
            owner: opts.taskId ?? entry.executionId,
            clientId,
            signal: laneAbort.signal,
            onQueued: () => { if (opts.taskId) this.taskRuns().markWaiting(opts.taskId, nowIso()) },
          })
        })() : undefined,
        signal: laneAbort.signal,
      };
      const claimed = this.run(
        `UPDATE executions
        SET status = 'starting', updated_at = ?
        WHERE id = ? AND status = 'queued'`,
        nowIso(),
        entry.executionId,
      )
      if (claimed.changes !== 1) {
        clearInterval(laneWatch)
        return
      }
      if (opts.taskId) this.taskRuns().markStarted(opts.taskId, nowIso())
      entry.agentClient = client
      entry.agentEnv = operationOptions.env
      entry.clientStreamDone = new Promise<void>((resolve) => { entry.resolveClientStreamDone = resolve })
      entry.clientStartDone = new Promise<void>((resolve) => { entry.resolveClientStartDone = resolve })
      try { session = await this.execService.start(execRequest, operationOptions) }
      finally {
        clearInterval(laneWatch)
        entry.resolveClientStartDone?.()
      }
    } catch (error) {
      if (entry.cancelRequested || entry.terminalIntent) return
      if (error instanceof DesktopLaneClosedError) {
        this.terminalizeQueued(entry, 'cancelled', 'cancel', 'cancelled')
        return
      }
      this.terminalizeStartingFailure(entry, error)
      return
    }

    entry.session = session
    entry.pid = session.diagnostics.pid

    const timestamp = nowIso()
    let runningClaimed = false
    this.tx(() => {
      const claimed = this.run(
        `UPDATE executions
        SET status = 'running', pid = ?, pgid = ?, started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'starting'`,
        session.diagnostics.pid ?? null,
        null,
        timestamp,
        timestamp,
        entry.executionId,
      )
      if (claimed.changes !== 1) return
      runningClaimed = true
      this.insertEvent({
        executionId: entry.executionId,
        taskId: entry.taskId,
        seq: nextSeq(entry),
        type: fromQueue ? 'queue-acquired' : 'child-start',
        data: dropUndefined({
          profile: opts.profile,
          cwd: opts.cwd,
          client_family: opts.clientFamily,
        }),
        timestamp,
      })
    })

    if (!runningClaimed) {
      const row = this.getExecution(entry.executionId)
      if (row && isTerminalStatus(row.status)) {
        void session.cancel().catch(() => undefined)
        entry.terminalGeneration += 1
        this.resolveAndForget(entry, resultFromRow(row))
        this.finalizeClient(entry, row.status)
        void this.promoteQueued()
      } else {
        this.terminalizeStartingFailure(entry, new Error(`Execution '${entry.executionId}' lost its starting transition`))
      }
      return
    }

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      let resolveDeadline!: () => void
      const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve })
      entry.attemptDeadlinePromise = deadline
      entry.timeoutTimer = setTimeout(() => {
        if (entry.terminalGeneration > 0) return
        // The attempt deadline overrides any provisional exit intent claimed by
        // an early child close whose stdio stream is still draining, so the
        // execution converges as timeout instead of hanging on held stdio. A
        // committed terminal state is never overridden.
        entry.terminalIntent = { kind: 'timeout' }
        entry.timedOut = true
        resolveDeadline()
        void this.requestKillOnce(entry).catch((error: unknown) => {
          this.log('warn', `[foreman] Timeout kill failed for ${entry.executionId}: ${errorMessage(error)}`)
        })
        void this.settleAttemptTimeout(entry)
      }, opts.timeoutMs)
    }

    this.attachChildObservers(entry)
  }

  private attachChildObservers(entry: RegistryEntry): void {
    if (!entry.session) return

    entry.streamDone = this.consumeStream(entry).catch((error: unknown) => {
      entry.finished = { type: 'finished', status: 'failed', isError: true, error: redactDiagnosticText(errorMessage(error)) }
      this.log('warn', `[foreman] stream consumer failed for ${entry.executionId}: ${redactDiagnosticText(errorMessage(error))}`)
    })
    void entry.streamDone.then(async () => {
      void this.handleChildClose(entry).catch((error: unknown) => {
        this.log('error', `[foreman] close handler failed for ${entry.executionId}: ${errorMessage(error)}`)
      })
    })
  }

  private async consumeStream(entry: RegistryEntry): Promise<void> {
    if (!entry.session) return

    for await (const agentEvent of entry.session.events) {
      // A bounded cancellation may have terminalized and forgotten this entry
      // while the stream is stalled; late stream events must not mutate the
      // terminal state or insert post-terminal events.
      if (entry.terminalGeneration > 0) return
      if (agentEvent.type === 'session') {
        entry.pendingNativeSessionId = agentEvent.nativeSessionId
        if (agentEvent.profile) this.captureResolvedProfileOnce(entry.executionId, agentEvent.profile, nowIso())
      }
      if (agentEvent.type === 'finished') {
        const upstreamError = agentEvent.upstreamError
        entry.finished = {
          ...agentEvent,
          ...(isRecord(agentEvent.error) && typeof agentEvent.error.message === 'string'
            ? { error: { ...agentEvent.error, message: redactDiagnosticText(agentEvent.error.message) } }
            : {}),
          ...(typeof agentEvent.error === 'string' ? { error: redactDiagnosticText(agentEvent.error) } : {}),
          ...(upstreamError && typeof upstreamError.message === 'string'
            ? { upstreamError: { ...upstreamError, message: redactDiagnosticText(upstreamError.message) } }
            : {}),
        }
        if (agentEvent.nativeSessionId) entry.pendingNativeSessionId = agentEvent.nativeSessionId
        if (agentEvent.clientFamily) entry.pendingClientFamily = agentEvent.clientFamily as ClientFamily
        if (agentEvent.profile) this.captureResolvedProfileOnce(entry.executionId, agentEvent.profile, nowIso())
        if (agentEvent.failureClass) entry.pendingFailureClass = agentEvent.failureClass
      }

      const finishedEvent = agentEvent.type === 'finished' ? agentEvent : undefined
      const final = finishedEvent ? extractFinalResult(finishedEvent) : undefined
      if (final) {
        entry.rawResult = redactJsonString(stableStringify(entry.finished ?? agentEvent))
        if (final.output) {
          entry.finalOutput = final.output
          const redacted = redactEvent('message', messageEvent(final.output))
          const text = isRecord(redacted) ? stringProp(redacted, 'text') : null
          if (text) {
            if (entry.abnormalProseParts.length > 0) entry.abnormalProseParts.push('\n')
            entry.abnormalProseParts.push(text)
          }
        }
      }
      if (final?.isError && typeof finishedEvent?.error === 'string')
        entry.abnormalProseParts.push(redactDiagnosticText(finishedEvent.error))

      const mappedEvents = mapStreamEventToBClass(agentEvent)
      if (mappedEvents.length > 0) {
        this.tx(() => {
          for (const mapped of mappedEvents) {
            const redacted = redactEvent(mapped.type, mapped.data)
            if (mapped.type === 'message' && typeof mapped.data.text === 'string') {
              appendOutputText(entry, mapped.data.text)
              const text = isRecord(redacted) ? stringProp(redacted, 'text') : null
              // Abnormal output uses the same redacted message text as storage.
              if (text) entry.abnormalProseParts.push(text)
            }

            if (mapped.type === 'tool_call') {
              const name = redacted && isRecord(redacted) ? (stringProp(redacted, 'name') || 'tool') : 'tool'
              entry.toolCallCounts.set(name, (entry.toolCallCounts.get(name) ?? 0) + 1)
            }
            this.insertEvent({
              executionId: entry.executionId,
              taskId: entry.taskId,
              seq: nextSeq(entry),
              type: mapped.type,
              data: redacted,
            })
          }
        })
      }
    }
  }

  private async handleChildClose(entry: RegistryEntry): Promise<void> {
    const intent = entry.terminalIntent
    await this.drainStreamAtDeadline(entry)
    const status = this.determineTerminalStatus(entry, intent, entry.finished?.status)
    const killReason = this.determineKillReason(entry, status, intent)
    const messageOutput = (entry.finalOutput ?? entry.outputParts.join('')).trim() || null
    // Failed and timed-out runs return the ordered model prose followed by a
    // tool-name count summary; tool inputs and results are never returned to the
    // caller. Normal success/cancellation keeps the existing 256KiB accumulator.
    const processOutput = status === 'failed' || status === 'timeout'
      ? this.assembleAbnormalOutput(entry)
      : null
    const rawAgentOutput = processOutput === null ? messageOutput : processOutput
    const agentOutput = status === 'failed' && rawAgentOutput !== null
      ? redactDiagnosticText(rawAgentOutput)
      : rawAgentOutput
    const output = agentOutput
    const errorValue = entry.finished?.error
    const errorText = typeof errorValue === 'string' ? errorValue : isRecord(errorValue) ? stringProp(errorValue, 'message') : null
    const error = status === 'failed' ? redactDiagnosticText(errorText || 'execution failed') : null
    const upstreamError = status === 'failed' ? entry.finished?.upstreamError : undefined

    this.terminalizeRunning(entry, {
      status,
      killReason,
      output,
      error,
      failureClass: this.classifyClientFailure(entry),
      upstreamError,
    })
  }

  /**
   * Assemble redacted ordered model prose followed by one names/counts
   * sentence; tool inputs, results, and truncation are excluded.
   */
  private assembleAbnormalOutput(entry: RegistryEntry): string {
    const prose = entry.abnormalProseParts.join('')
    const counts = Array.from(entry.toolCallCounts)
    const summary = counts.length === 0
      ? 'No tools were called.'
      : `Called ${counts
        .map(([name, count]) => `${name} ${count} ${count === 1 ? 'time' : 'times'}`)
        .join(' and ')}.`
    return prose ? `${prose}\n${summary}` : summary
  }

  /**
   * The failure classification carried to route health. Only a class the client
   * itself reported on its terminal record is carried; the upstream status and
   * error identity are extracted separately as `upstreamError`, so a diagnostic
   * text pattern never decides a class here.
   */
  private classifyClientFailure(entry: RegistryEntry): string | null {
    return entry.pendingFailureClass ?? null
  }

  private determineTerminalStatus(entry: RegistryEntry, intent: TerminalIntent | undefined, finishedStatus?: 'done' | 'failed'): TerminalStatus {
    if (intent?.kind === 'shutdown') return 'interrupted'
    if (intent?.kind === 'cancel') return 'cancelled'
    if (intent?.kind === 'timeout') return 'timeout'
    return finishedStatus === 'done' ? 'done' : 'failed'
  }

  private determineKillReason(
    entry: RegistryEntry,
    status: TerminalStatus,
    intent: TerminalIntent | undefined,
  ): KillReason {
    if (status === 'cancelled') return 'cancel'
    if (status === 'timeout') return 'timeout'
    if (status === 'interrupted') return 'shutdown'
    return null
  }

  private terminalizeRunning(
    entry: RegistryEntry,
  terminal: {
    status: TerminalStatus
    killReason: KillReason
    output: string | null
    error: string | null
    failureClass?: string | null
    upstreamError?: Extract<AgentEvent, { type: 'finished' }>['upstreamError']
  },
  ): void {
    if (entry.terminalGeneration > 0) return

    const endedAt = nowIso()
    const eventStatus = mapEventStatus(terminal.status)
    // `applied` records whether THIS call's conditional UPDATE won, evaluated
    // strictly inside the transaction. `committed` is only ever assigned once
    // the transaction has returned successfully, so a transaction that rolls
    // back can never be mistaken for a committed terminal state.
    let applied = false
    let committed = false
    let terminalError: unknown
    let result: ExecutionResult | undefined

    try {
      const terminalSummary = summaryFromTerminalOutput(terminal.output)
      this.tx(() => {
        const updateResult = this.run(
          `UPDATE executions
          SET status = ?, ended_at = ?, kill_reason = ?,
            output = ?, raw_result = ?, error = ?, updated_at = ?
          WHERE id = ? AND status = 'running'`,
          terminal.status,
          endedAt,
          terminal.killReason,
          terminal.output,
          entry.rawResult === undefined ? null : redactJsonString(entry.rawResult),
          terminal.error,
          endedAt,
          entry.executionId,
        )

        if (updateResult.changes !== 1) return
        applied = true

        this.insertEvent({
          executionId: entry.executionId,
          taskId: entry.taskId,
          seq: nextSeq(entry),
          type: terminal.status === 'cancelled' ? 'cancelled' : 'terminal',
          data: dropUndefined({ summary: terminalSummary }),
          status: terminal.status === 'cancelled' ? undefined : eventStatus,
          isError: terminal.status === 'cancelled' ? undefined : (eventStatus === 'failed' ? 1 : 0),
          timestamp: endedAt,
        })

        if (terminal.status === 'done') {
          this.insertEvent({
            executionId: entry.executionId,
            taskId: entry.taskId,
            seq: nextSeq(entry),
            type: 'result',
            data: dropUndefined({ summary: terminalSummary }),
            status: eventStatus,
            isError: eventStatus === 'failed' ? 1 : 0,
            timestamp: endedAt,
          })
        }

        this.insertEvent({
          executionId: entry.executionId,
          taskId: entry.taskId,
          seq: nextSeq(entry),
          type: 'turn-complete',
          data: {},
          timestamp: endedAt,
        })

        this.repoWriteLocks.releaseByExecution(entry.executionId)
      })

      // The transaction returned without throwing: the terminal status, output
      // and terminal/result/turn-complete events are durably committed (or
      // another writer had already terminalized this execution).
      committed = applied

      if (committed) {
        const terminalResult: ExecutionResult & { upstreamError?: Extract<AgentEvent, { type: 'finished' }>['upstreamError'] | null } = {
          executionId: entry.executionId,
          status: terminal.status,
          output: terminal.output,
          error: terminal.error,
          killReason: terminal.killReason,
          failureClass: terminal.failureClass ?? null,
          upstreamError: terminal.upstreamError ?? null,
        }
        result = terminalResult
      } else {
        const row = this.getExecution(entry.executionId)
        if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
        else terminalError = new Error(`Execution '${entry.executionId}' terminal transaction did not commit`)
      }

      // Optional native-session persistence happens strictly AFTER the terminal
      // commit and is best-effort: a failure here can never roll back the
      // committed terminal result, never leak the repo write lock, and never
      // discard the usage/events captured before the failure.
      if (committed && (terminal.status === 'done' || terminal.status === 'timeout')) {
        try {
          this.persistNativeSessionIfCaptured(entry, endedAt)
        } catch (sessionError) {
          this.log(
            'warn',
            `[foreman] Failed to persist native session for ${entry.executionId}: ${errorMessage(sessionError)}`,
          )
        }
      }
      // The committed terminal status is now final (cancel/timeout/shutdown
      // precedence already resolved above), so the client's own post-run
      // hook can safely retain or clean up its session state.
      if (committed) this.finalizeClient(entry, terminal.status)
      if (committed && terminal.status === 'done') {
        // The execution's usage is durable at this point, so the local speed
        // window can pick up its paired sample. This is best-effort: a failure
        // must never reject an execution that already committed.
        try {
          this.onExecutionCompleted?.(entry.executionId)
        } catch (completionError) {
          this.log(
            'warn',
            `[foreman] Failed to update the local speed sample for ${entry.executionId}: ${errorMessage(completionError)}`,
          )
        }
      }
    } catch (error) {
      terminalError = error
    } finally {
      if (terminalError) {
        this.rejectAndForget(entry, terminalError)
      } else if (result) {
        entry.terminalGeneration += 1
        this.resolveAndForget(entry, result)
      }
      if (terminalError || result) void this.promoteQueued()
    }
  }

  private terminalizeStartingFailure(entry: RegistryEntry, error: unknown): void {
    if (entry.terminalGeneration > 0) return

    const endedAt = nowIso()
    const message = errorMessage(error)
    let committed = false
    let terminalError: unknown
    let result: ExecutionResult | undefined

    try {
      this.tx(() => {
        const result = this.run(
          `UPDATE executions
          SET status = 'failed', ended_at = ?, error = ?, kill_reason = 'spawn-error', updated_at = ?
          WHERE id = ? AND status IN ('queued', 'starting')`,
          endedAt,
          message,
          endedAt,
          entry.executionId,
        )
        if (result.changes !== 1) return
        committed = true
        this.insertEvent({
          executionId: entry.executionId,
          taskId: entry.taskId,
          seq: nextSeq(entry),
          type: 'terminal',
          data: {},
          status: 'failed',
          isError: 1,
          timestamp: endedAt,
        })
        this.repoWriteLocks.releaseByExecution(entry.executionId)
        if (entry.taskId) {
          this.taskRuns().markTerminal({
            taskRunId: entry.taskId,
            status: 'failed',
            error: message,
            endedAt,
            facts: minimalRunFactsForTaskRun(entry.taskId, 'failed'),
          })
        }
      })
    } catch (caught) {
      terminalError = caught
    } finally {
      if (!terminalError && !committed) {
        const row = this.getExecution(entry.executionId)
        if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
        else terminalError = new Error(`Execution '${entry.executionId}' spawn-error transaction did not commit`)
      }
      if (terminalError) {
        this.rejectAndForget(entry, terminalError)
      } else if (committed || result) {
        entry.terminalGeneration += 1
        const terminalResult = result ?? {
          executionId: entry.executionId,
          status: 'failed',
          error: message,
          killReason: 'spawn-error',
        } satisfies ExecutionResult
        this.resolveAndForget(entry, terminalResult)
        this.finalizeClient(entry, terminalResult.status)
      }
      if (terminalError || committed || result) void this.promoteQueued()
    }
  }

  private terminalizeQueued(
    entry: RegistryEntry,
    status: Extract<TerminalStatus, 'cancelled' | 'interrupted' | 'failed'>,
    killReason: Exclude<KillReason, null>,
    error: string,
  ): void {
    if (entry.terminalGeneration > 0) return

    const endedAt = nowIso()
    const eventStatus = mapEventStatus(status)
    let committed = false
    let terminalError: unknown
    let result: ExecutionResult | undefined

    try {
      this.tx(() => {
        const result = this.run(
          `UPDATE executions
          SET status = ?, ended_at = ?, error = ?, kill_reason = ?, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'starting')`,
          status,
          endedAt,
          error,
          killReason,
          endedAt,
          entry.executionId,
        )
        if (result.changes !== 1) return
        committed = true
        this.insertEvent({
          executionId: entry.executionId,
          taskId: entry.taskId,
          seq: nextSeq(entry),
          type: status === 'cancelled' ? 'cancelled' : 'terminal',
          data: {},
          status: status === 'cancelled' ? undefined : eventStatus,
          isError: status === 'cancelled' ? undefined : (eventStatus === 'failed' ? 1 : 0),
          timestamp: endedAt,
        })
        this.repoWriteLocks.releaseByExecution(entry.executionId)
        if (entry.taskId) {
          this.taskRuns().markTerminal({
            taskRunId: entry.taskId,
            status: mapTaskStatus(status),
            error,
            endedAt,
            facts: minimalRunFactsForTaskRun(entry.taskId, mapTaskStatus(status)),
          })
        }
      })
    } catch (caught) {
      terminalError = caught
    } finally {
      if (!terminalError && !committed) {
        const row = this.getExecution(entry.executionId)
        if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
        else terminalError = new Error(`Execution '${entry.executionId}' queued terminal transaction did not commit`)
      }
      if (terminalError) {
        this.rejectAndForget(entry, terminalError)
      } else if (committed || result) {
        entry.terminalGeneration += 1
        const terminalResult = result ?? {
          executionId: entry.executionId,
          status,
          error,
          killReason,
        } satisfies ExecutionResult
        this.resolveAndForget(entry, terminalResult)
        this.finalizeClient(entry, terminalResult.status)
      }
      if (terminalError || committed || result) void this.promoteQueued()
    }
  }

  private async cancelQueuedExecutionWithoutRegistry(executionId: string): Promise<void> {
    const row = this.getExecution(executionId)
    if (!row) throw new Error(`Unknown execution '${executionId}'`)
    if (isTerminalStatus(row.status)) return

    // A stale execution with a recorded PID must have its process tree killed
    // and the PID verified absent before the idempotent CAS reconciler may
    // terminalize it. If the kill throws, ownership is uncertain, or the PID
    // remains live, keep the execution and its task active with repo-write
    // protection held and surface a structured cancellation failure instead of
    // declaring the execution cancelled. Rows without a recorded PID are safely
    // processless and may use the CAS reconciler directly.
    if (row.pid) {
      try {
        await this.killProcessTreeFn(row.pid, row.pgid ?? undefined)
      } catch (error: unknown) {
        throw this.cancellationControlFailure(executionId, row.pid, 'kill', errorMessage(error))
      }
      if (this.isProcessLive(row.pid)) {
        throw this.cancellationControlFailure(
          executionId,
          row.pid,
          'verify',
          `Cancellation of execution '${executionId}' could not control still-live process ${row.pid}`,
        )
      }
    }

    this.reconcileCancelled(executionId, nowIso())
    await this.promoteQueued()
  }

  private cancellationControlFailure(
    executionId: string,
    pid: number | undefined,
    phase: 'kill' | 'verify',
    message: string,
  ): ExecutionTerminationFailure {
    const failure = new ExecutionTerminationFailure(executionId, pid, 'cancel', phase, message)
    this.log('error', `[foreman] Failed to cancel execution ${executionId}`, {
      executionId,
      pid,
      action: failure.action,
      phase: failure.phase,
      result: 'failed',
      error: failure.message,
    })
    return failure
  }

  /**
   * Race a registered active execution's wait promise against the
   * cancellation-settlement bound. Resolves 'wait' when the observer commits a
   * terminal state first, or 'bound' when the bound elapses without a terminal
   * observer (so the caller can reconcile directly). Rejections from the wait
   * promise propagate to the cancel caller.
   */
  private raceCancellationSettlement(entry: RegistryEntry): Promise<'wait' | 'bound'> {
    return new Promise<'wait' | 'bound'>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      entry.waitPromise.then(
        () => {
          if (timer) clearTimeout(timer)
          resolve('wait')
        },
        (error: unknown) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      )
      timer = setTimeout(() => resolve('bound'), this.cancelSettlementTimeoutMs)
    })
  }

  /**
   * Terminalize a registered active execution whose observer is stalled, using
   * the shared compare-and-set reconciler so the registered and no-registry
   * cancellation paths cannot drift. Resolves the wait promise exactly once and
   * deletes the registry entry; a losing concurrent observer is guarded by
   * terminal generation and the authoritative terminal row.
   */
  private settleRegisteredCancellation(entry: RegistryEntry): void {
    if (entry.terminalGeneration > 0) return

    const endedAt = nowIso()
    const won = this.reconcileCancelled(entry.executionId, endedAt)
    let result: ExecutionResult | undefined
    if (won) {
      result = {
        executionId: entry.executionId,
        status: 'cancelled',
        output: (entry.finalOutput ?? entry.outputParts.join('')).trim() || null,
        error: 'cancelled',
        killReason: 'cancel',
      }
    } else {
      // A concurrent observer/reconciler won the compare-and-set; the
      // authoritative row already carries the terminal state.
      const row = this.getExecution(entry.executionId)
      if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
    }

    if (result) {
      entry.terminalGeneration += 1
      this.resolveAndForget(entry, result)
      this.finalizeClient(entry, result.status)
    }
  }

  /**
   * Await the stdio stream drain, but never past the attempt deadline. If the
   * attempt deadline fired (e.g. a held stdio pipe after an early child close),
   * the deadline signal resolves this race so terminalization converges at the
   * deadline instead of hanging on an unsettled stream consumer.
   */
  private async drainStreamAtDeadline(entry: RegistryEntry): Promise<void> {
    const streamDone = entry.streamDone
    if (!streamDone) return
    const deadline = entry.attemptDeadlinePromise
    if (!deadline) {
      await streamDone
      return
    }
    await Promise.race([streamDone, deadline])
  }

  private finalizeClient(entry: RegistryEntry, status: string): void {
    if (entry.finalization || !entry.agentClient?.finalize) return
    const finalize = async () => {
      await entry.clientStartDone
      const streamDone = entry.clientStreamDone ?? entry.streamDone
      if (streamDone) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const boundedWait = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.cancelSettlementTimeoutMs)
        })
        try {
          const bounds = [streamDone.catch(() => undefined), boundedWait]
          if (entry.attemptDeadlinePromise) bounds.push(entry.attemptDeadlinePromise)
          await Promise.race(bounds)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      await entry.agentClient!.finalize!(status, { executionId: entry.executionId, env: entry.agentEnv ?? process.env })
    }
    entry.finalization = finalize().catch((error: unknown) => {
      this.log('warn', `[foreman] Failed to finalize agent client state for ${entry.executionId}: ${errorMessage(error)}`)
    })
  }

  /**
   * Durably terminalize a registered active execution whose observer is stalled
   * past the attempt deadline, using the shared compare-and-set reconciler so
   * the registered and no-registry timeout paths cannot drift. Reuses the
   * cancellation settlement bound: if the close/stream observer commits a
   * terminal row first, this is a no-op; otherwise it reconciles the execution
   * as timeout. A committed terminal state is never overwritten.
   */
  private async settleAttemptTimeout(entry: RegistryEntry): Promise<void> {
    if (entry.terminalGeneration > 0) return
    const settled = await this.raceCancellationSettlement(entry)
    if (settled === 'wait' || entry.terminalGeneration > 0) return
    const endedAt = nowIso()
    const won = this.reconcileTimeout(entry.executionId, endedAt)
    let result: ExecutionResult | undefined
    if (won) {
      const output = this.assembleAbnormalOutput(entry)
      result = {
        executionId: entry.executionId,
        status: 'timeout',
        output,
        error: 'timeout',
        killReason: 'timeout',
      }
      try {
        this.persistNativeSessionIfCaptured(entry, endedAt)
      } catch (sessionError) {
        this.log(
          'warn',
          `[foreman] Failed to persist native session for ${entry.executionId}: ${errorMessage(sessionError)}`,
        )
      }
    } else {
      const row = this.getExecution(entry.executionId)
      if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
    }
    if (result) {
      entry.terminalGeneration += 1
      this.resolveAndForget(entry, result)
      this.finalizeClient(entry, result.status)
    }
  }

  /**
   * Shared transactional compare-and-set reconciler for attempt timeouts. Marks
   * the execution timed out, inserts exactly one terminal execution event, and
   * releases the repo write lock — but only when the compare-and-set transition
   * from a non-terminal status wins. Returns true when this call won the
   * transition; a losing call leaves the authoritative terminal row (and its
   * events) untouched. The linked task is reconciled by the kernel, not here,
   * matching the normal terminalizeRunning timeout path.
   */
  private reconcileTimeout(executionId: string, endedAt: string): boolean {
    let won = false
    this.tx(() => {
      const row = this.get<{ task_id: string | null }>(
        `SELECT task_id FROM executions WHERE id = ?`,
        executionId,
      )
      if (!row) return
      const result = this.run(
        `UPDATE executions
        SET status = 'timeout', ended_at = ?, error = 'timeout', kill_reason = 'timeout',
          updated_at = ?
        WHERE id = ? AND status IN ('queued', 'starting', 'running')`,
        endedAt,
        endedAt,
        executionId,
      )
      if (result.changes !== 1) return
      won = true
      this.insertEvent({
        executionId,
        taskId: row.task_id ?? undefined,
        seq: this.maxSeq(executionId) + 1,
        type: 'terminal',
        data: {},
        status: 'failed',
        isError: 1,
        timestamp: endedAt,
      })
      this.repoWriteLocks.releaseByExecution(executionId)
    })
    return won
  }

  /**
   * Shared transactional compare-and-set reconciler used by both the registered
   * active-execution cancel path and the no-registry cancel path. Marks the
   * execution and its linked task cancelled, inserts exactly one cancelled
   * execution event, and releases the repo write lock — but only when the
   * compare-and-set transition from a non-terminal status wins. Returns true
   * when this call won the transition; a losing call leaves the authoritative
   * terminal row (and its events) untouched.
   */
  private reconcileCancelled(executionId: string, endedAt: string): boolean {
    let won = false
    this.tx(() => {
      const row = this.get<{ task_id: string | null }>(
        `SELECT task_id FROM executions WHERE id = ?`,
        executionId,
      )
      if (!row) return
      const result = this.run(
        `UPDATE executions
        SET status = 'cancelled', ended_at = ?, error = 'cancelled', kill_reason = 'cancel',
          updated_at = ?
        WHERE id = ? AND status IN ('queued', 'starting', 'running')`,
        endedAt,
        endedAt,
        executionId,
      )
      if (result.changes !== 1) return
      won = true
      this.insertEvent({
        executionId,
        taskId: row.task_id ?? undefined,
        seq: this.maxSeq(executionId) + 1,
        type: 'cancelled',
        data: {},
        timestamp: endedAt,
      })
      this.repoWriteLocks.releaseByExecution(executionId)
      if (row.task_id) {
        this.taskRuns().markTerminal({
          taskRunId: row.task_id,
          status: 'cancelled',
          error: 'cancelled',
          endedAt,
          facts: minimalRunFactsForTaskRun(row.task_id, 'cancelled'),
        })
      }
    })
    return won
  }

  private isProcessLive(pid: number): boolean {
    return this.isProcessLiveFn(pid)
  }

  private async promoteQueued(): Promise<void> {
    if (this.promoting) return
    this.promoting = true

    try {
      while (this.runningCount() < MAX_CONCURRENT_EXECUTIONS) {
        // An idle queue promotion must not touch SQL: only an in-memory registry
        // entry that has not launched and is not terminal can be promoted.
        if (!this.hasQueuedPromotableEntry()) return

        const candidates = this.query<QueuedCandidateRow>(
          `SELECT id, cwd
          FROM executions
          WHERE status = 'queued'
          ORDER BY created_at ASC, id ASC`,
        )

        let promoted = false
        for (const candidate of candidates) {
          if (this.runningCount() >= MAX_CONCURRENT_EXECUTIONS) break

          const entry = this.registry.get(candidate.id)
          if (!entry) continue
          if (entry.terminalGeneration > 0) continue

          let acquiredLock = false
          if (entry.repoWriteLock && !entry.hasRepoLock) {
            const lock = this.repoWriteLocks.tryAcquire(candidate.cwd, candidate.id, repoWriteLockMode(entry.writePaths), entry.writePaths)
            if (!lock.acquired) continue
            entry.hasRepoLock = true
            acquiredLock = true
          }

          // Re-read only the launch fields, and only for the candidate whose
          // registry entry, concurrency slot and repo lock are already settled.
          // The status predicate covers a candidate that disappeared or left
          // the queue between the light scan and this fetch.
          const row = this.get<LaunchFieldRow>(
            `SELECT id, cwd, task_id, profile, prompt, native_session_id, timeout_ms, client_family, features
            FROM executions
            WHERE id = ? AND status = 'queued'`,
            candidate.id,
          )
          if (!row) {
            if (acquiredLock) {
              this.repoWriteLocks.releaseByExecution(candidate.id)
              entry.hasRepoLock = false
            }
            continue
          }

          const opts = optsFromRow(row, entry)
          entry.wasQueued = true
          await this.launchExecution(entry, opts, true)
          promoted = true
        }

        if (!promoted) break
      }
    } finally {
      this.promoting = false
    }
  }

  /**
   * True when at least one registry entry is queued and still launchable: it has
   * no session yet and has not reached a terminal generation. Mirrors the
   * promotion loop's own candidate predicate so the SQL-free idle path never
   * skips an entry that could genuinely launch.
   */
  private hasQueuedPromotableEntry(): boolean {
    for (const entry of this.registry.values()) {
      if (!entry.session && entry.terminalGeneration === 0) return true
    }
    return false
  }

  promoteQueuedAfterGuardChange(): void { void this.promoteQueued() }

  private runningCount(): number {
    let count = 0
    for (const entry of this.registry.values()) {
      if (entry.session && entry.terminalGeneration === 0) count += 1
    }
    return count
  }

  private persistNativeSessionIfCaptured(entry: RegistryEntry, timestamp: string): void {
    if (!entry.pendingNativeSessionId || !entry.pendingClientFamily) return

    this.run(
      `UPDATE executions
      SET native_session_id = ?, client_family = ?, updated_at = ?
      WHERE id = ?`,
      entry.pendingNativeSessionId,
      entry.pendingClientFamily,
      timestamp,
      entry.executionId,
    )
  }

  private readResolvedProfile(executionId: string): string | null {
    const row = this.get<{ resolved_profile: string | null }>(
      `SELECT resolved_profile FROM executions WHERE id = ?`,
      executionId,
    )
    return row?.resolved_profile ?? null
  }

  /**
   * Resolve the dispatch-plan override for this exact execution attempt's
   * persisted reasoning-effort choice. The snapshot is read from the attempt's own
   * `task_run_attempt_dispatch` row (never the latest attempt of the task), so
   * a queued execution promoted later still spawns with the reasoning-effort level it
   * was admitted with. Only when a legal reasoning-effort value is persisted does this
   * build a fresh plan through the builtin catalog; legacy runs without a
   * snapshot return undefined and spawn exactly as before. The returned value
   * is a plan keyed by the attempt's own canonical profile only — it never
   * mutates the process env or any global/default plans.
   */
  private buildReasoningEffortPlanEnv(executionId: string, fast?: boolean): ReasoningEffortPlanEnvOverride | undefined {
    const row = this.get<AttemptReasoningEffortRow>(
      `SELECT reasoning_effort, fast, provider, model, profile, mode, requested_agent_runtime, client
       FROM task_run_attempt_dispatch WHERE execution_id = ?`,
      executionId,
    )
    const reasoningEffort = row ? toPersistedReasoningEffort(row.reasoning_effort) : undefined
    if (!row || !reasoningEffort) return undefined
    if ((row.mode !== 'native' && row.mode !== 'gateway') || !row.client || !row.provider || !row.model || !row.profile) {
      throw new Error('Persisted reasoning-effort dispatch is incomplete')
    }
    // A queued execution promoted later has no in-memory snapshot, so the
    // persisted Fast preference is authoritative unless this launch carries one.
    const effectiveFast = fast !== undefined ? fast : toPersistedFast(row.fast)
    const plan = this.catalog.resolveRun(row.client, row.provider, row.model, reasoningEffort, effectiveFast)
    return { profile: row.profile, plan }
  }

  private captureResolvedProfileOnce(executionId: string, profile: string, timestamp: string): void {
    this.run(
      `UPDATE executions
      SET resolved_profile = ?, updated_at = ?
      WHERE id = ? AND resolved_profile IS NULL`,
      profile,
      timestamp,
      executionId,
    )
  }

  private resolveAndForget(entry: RegistryEntry, result: ExecutionResult): void {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
    this.registry.delete(entry.executionId)
    this.notifyExecutionTerminal(entry.executionId)
    entry.resolveWait(result)
  }

  private rejectAndForget(entry: RegistryEntry, error: unknown): void {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
    // A terminal transaction that threw rolled back together with its
    // in-transaction repo-lock release, so release again here as a guaranteed
    // fallback on the error path (releaseByExecution is idempotent).
    this.repoWriteLocks.releaseByExecution(entry.executionId)
    this.registry.delete(entry.executionId)
    this.notifyExecutionTerminal(entry.executionId)
    entry.rejectWait(error)
  }

  private claimTerminalIntent(entry: RegistryEntry, intent: TerminalIntent): boolean {
    if (entry.terminalGeneration > 0 || entry.terminalIntent) return false
    entry.terminalIntent = intent
    return true
  }

  private requestKillOnce(entry: RegistryEntry): Promise<void> {
    if (entry.session) {
      entry.killPromise ??= entry.session.cancel()
      return entry.killPromise
    }
    if (!entry.pid) return Promise.resolve()
    entry.killPromise ??= this.killProcessTreeFn(entry.pid, entry.pgid)
    return entry.killPromise
  }

  private insertEvent(opts: {
    executionId: string
    taskId?: string
    seq: number
    type: string
    data: unknown
    status?: 'done' | 'failed'
    isError?: 0 | 1
    timestamp?: string
  }): void {
    const timestamp = opts.timestamp ?? nowIso()
    this.executionEvents().insertExecutionEvent({
      executionId: opts.executionId,
      taskId: opts.taskId,
      seq: opts.seq,
      type: opts.type,
      data: opts.data,
      status: opts.status,
      isError: opts.isError,
      timestamp,
    })
  }

  private maxSeq(executionId: string): number {
    return this.executionEvents().maxSequence(executionId)
  }

  private query<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare<unknown[], T>(sql).all(...params)
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare<unknown[], T>(sql).get(...params)
  }

  private run(sql: string, ...params: unknown[]) {
    return this.db.prepare<unknown[]>(sql).run(...params)
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  private log(level: keyof SupervisorLogger, message: string, meta?: unknown): void {
    const fn = this.logger?.[level]
    if (fn) fn.call(this.logger, message, meta)
  }
}

/** Child-env key carrying the per-run dispatch plan map, copied and narrowed per spawn. */
const DISPATCH_PLANS_ENV = 'WRENYARD_DISPATCH_PLANS_JSON'

/** A single per-run dispatch plan override keyed by its canonical profile. */
interface ReasoningEffortPlanEnvOverride {
  profile: string
  plan: Partial<ReturnType<ReturnType<typeof createBuiltinCatalog>['resolveRun']>>
}

interface AttemptReasoningEffortRow {
  reasoning_effort: string | null
  fast: number | null
  provider: string | null
  model: string | null
  profile: string | null
  mode: string | null
  requested_agent_runtime: string | null
  client: string | null
}

function toPersistedFast(raw: number | null): boolean | undefined {
  if (raw === 1) return true
  if (raw === 0) return false
  return undefined
}

function toPersistedReasoningEffort(raw: string | null): ReasoningEffort | undefined {
  // 'default' is a legal persisted resolution for a provider-default-only
  // route; dropping it here would make a valid plan look unresolved on read-back.
  return raw === 'none' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max' || raw === 'default'
    ? raw
    : undefined
}

export function resolveTaskAgentEnv(
  env: NodeJS.ProcessEnv,
  taskRunId?: string,
  reasoningEffortPlan?: ReasoningEffortPlanEnvOverride,
  executionId?: string,
): NodeJS.ProcessEnv {
  // Copy the inherited environment so unrelated values (PATH, credentials, etc.) reach the
  // native client child unchanged, then drop any stale inherited task context.
  const next: NodeJS.ProcessEnv = { ...env }
  delete next.WRENYARD_TASK_RUN_ID
  // Make the installed bundled CLI discoverable to task agents without any
  // shell setup: an installed suite ships the single-executable `wrenyard` at
  // its root, so prepend that directory to the inherited PATH.
  prependBundledCliToPath(next)
  // ...and inject the authoritative current task run id only when one exists.
  if (taskRunId) {
    next.WRENYARD_TASK_RUN_ID = taskRunId
  }
  // Per-run reasoning-effort plan: overwrite ONLY this run's canonical profile
  // entry in a freshly parsed copy of the inherited plan map, preserving every
  // other plan. The process env and any global/default plan map are never
  // mutated, so concurrent children cannot leak a reasoning-effort level into one
  // another.
  if (reasoningEffortPlan) {
    const plans = parseDispatchPlans(next[DISPATCH_PLANS_ENV])
    plans[reasoningEffortPlan.profile] = reasoningEffortPlan.plan
    next[DISPATCH_PLANS_ENV] = JSON.stringify(plans)
  }
  // Scope the inherited gateway endpoint URLs to this exact execution so the
  // gateway can attribute paired response samples. Only the three known
  // gateway family paths ending in a terminal /v1 are rewritten, and an
  // existing scope is replaced rather than duplicated. Parent env, unrelated
  // URLs, and credentials are left untouched.
  if (executionId && /^[A-Za-z0-9_-]{1,128}$/u.test(executionId)) {
    for (const name of GATEWAY_URL_ENV_NAMES) {
      const scoped = scopeGatewayUrl(next[name], executionId)
      if (scoped !== undefined) next[name] = scoped
    }
  }
  return next
}

/**
 * Directory that holds the installed bundled CLI when this daemon runs from an
 * installed suite. The release build places the single-executable `wrenyard`
 * (or `wrenyard.exe` on Windows) at the suite root, so that directory can be
 * exposed on PATH for task agents. Returns undefined in a source checkout or
 * when the bundled executable is absent, so nothing changes outside an
 * installed suite and a missing/ambiguous suite root is never fatal.
 */
function bundledCliDirectory(): string | undefined {
  try {
    const suiteRoot = resolveWrenyardSuiteRoot()
    const executable = process.platform === 'win32'
      ? join(suiteRoot, 'wrenyard.exe')
      : join(suiteRoot, 'wrenyard')
    return existsSync(executable) ? suiteRoot : undefined
  } catch {
    return undefined
  }
}

/**
 * Prepend the installed bundled CLI directory to the environment's PATH. The
 * existing key is matched case-insensitively and updated in place, because
 * Windows inherits the variable as `Path` while POSIX uses `PATH`; the
 * canonical `PATH` name is used only when no inheritable key exists. The
 * directory is never duplicated, and an empty PATH becomes just the directory.
 */
function prependBundledCliToPath(env: NodeJS.ProcessEnv): void {
  const directory = bundledCliDirectory()
  if (!directory) return
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
  const existing = env[key]
  const entries = existing ? existing.split(delimiter) : []
  if (entries.includes(directory)) return
  env[key] = existing ? `${directory}${delimiter}${existing}` : directory
}

/** Inherited gateway endpoint URLs rewritten with this execution's scope. */
const GATEWAY_URL_ENV_NAMES = [
  'WRENYARD_GATEWAY_OPENAI_CHAT_URL',
  'WRENYARD_GATEWAY_OPENAI_RESPONSES_URL',
  'WRENYARD_GATEWAY_ANTHROPIC_URL',
] as const

/** Scope only recognized gateway URLs; replace a stale parent scope. */
function scopeGatewayUrl(raw: string | undefined, executionId: string): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const match = /^\/gateway\/(openai-chat|openai-responses|anthropic)(?:\/execution\/[A-Za-z0-9_-]{1,128})?\/v1\/?$/u.exec(url.pathname)
    if (!match) return undefined
    url.pathname = `/gateway/${match[1]}/execution/${executionId}/v1`
    return url.href
  } catch { return undefined }
}

/**
 * Parse the inherited dispatch-plan map exactly, without mutating the source
 * string. Malformed or non-object values yield an empty map so only this run's
 * plan is injected rather than corrupting the child's plan configuration.
 */
function parseDispatchPlans(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) }
    }
  } catch {
    // fall through to an empty map
  }
  return {}
}

export function mapStreamEventToBClass(event: AgentEvent): BClassEvent[] {
  if (event.type === 'message') {
    return event.text ? [{ type: 'message', data: { role: event.role, text: event.text } }] : []
  }
  if (event.type === 'reasoning') {
    return event.text ? [{ type: 'reasoning', data: { text: event.text } }] : []
  }
  if (event.type === 'tool_call') {
    return [{ type: 'tool_call', data: dropUndefined({ name: event.name, input_summary: event.inputSummary, call_id: event.callId }) }]
  }
  if (event.type === 'tool_result') {
    return [{ type: 'tool_result', data: dropUndefined({ call_id: event.callId, status: event.status, output_tail: tailString(event.outputTail, STDERR_TAIL_MAX_LEN) }) }]
  }
  if (event.type === 'usage') {
    return [{ type: 'turn_usage', data: dropUndefined({
      input_tokens: numberProp(event, 'input_tokens'),
      output_tokens: numberProp(event, 'output_tokens'),
      cached_input_tokens: numberProp(event, 'cached_input_tokens'),
      cache_read_input_tokens: numberProp(event, 'cache_read_input_tokens'),
      cache_creation_input_tokens: numberProp(event, 'cache_creation_input_tokens'),
      total_tokens: numberProp(event, 'total_tokens'),
      duration_ms: numberProp(event, 'duration_ms'),
      tps_samples: mapTpsSamples(event.tps_samples),
      first_token_latency_ms: numberProp(event, 'first_token_latency_ms'),
      wire_model: stringProp(event, 'wire_model') ?? undefined,
      wire_thinking_effort: stringProp(event, 'wire_thinking_effort') ?? undefined,
      token_scope: stringProp(event, 'token_scope') ?? undefined,
      duration_scope: stringProp(event, 'duration_scope') ?? undefined,
      tps_contract: stringProp(event, 'tps_contract') ?? undefined,
    }) }]
  }
  return []
}

function mapTpsSamples(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    return [dropUndefined({
      response_id: stringProp(item, 'response_id') ?? undefined,
      model: stringProp(item, 'model') ?? undefined,
      output_tokens: numberProp(item, 'output_tokens'),
      first_token_at_ms: numberProp(item, 'first_token_at_ms'),
      completed_at_ms: numberProp(item, 'completed_at_ms'),
      generation_windows: Array.isArray(item.generation_windows)
        ? item.generation_windows.map((window) => isRecord(window) ? dropUndefined({
          first_token_at_ms: numberProp(window, 'first_token_at_ms'),
          completed_at_ms: numberProp(window, 'completed_at_ms'),
        }) : null)
        : undefined,
    })]
  })
}

function isClientFamily(value: string | null | undefined): value is ClientFamily {
  // The registered clients map is the source of truth for known client ids;
  // no per-family whitelist lives at this layer.
  return value !== null && value !== undefined && agentClients.has(value)
}

function extractFinalResult(event: Extract<AgentEvent, { type: 'finished' }>): { isError: boolean; output?: string } {
  return {
    isError: event.isError === true || event.status === 'failed',
    output: typeof event.output === 'string' ? event.output : undefined,
  }
}

function assertStartExecutionOpts(opts: StartExecutionOpts): void {
  if (!opts.profile.trim()) throw new Error('startExecution profile is required')
  if (!opts.cwd.trim()) throw new Error('startExecution cwd is required')
  if (!opts.prompt.trim()) throw new Error('startExecution prompt is required')
  if (opts.clientFamily !== undefined && !isClientFamily(opts.clientFamily)) {
    throw new Error(`Invalid client family '${opts.clientFamily}'`)
  }
  if (opts.executionAdmission !== undefined && !validExecutionAdmissionBinding(opts.executionAdmission)) {
    // Generic by design: no expected/current scope, environment, or wire value
    // may enter an error string or log record.
    throw new Error('Execution admission binding is unavailable')
  }
  assertValidTimeoutMs(opts.timeoutMs, 'startExecution timeoutMs')
}

function normalizeStartExecutionOpts(opts: StartExecutionOpts): StartExecutionOpts {
  // Repository coordination only. An omitted repoWriteLock keeps the historical
  // conservative default (repo-wide write lock); a readonly task opts out with an
  // explicit `false`.
  return {
    ...opts,
    repoWriteLock: opts.repoWriteLock ?? true,
  }
}

function repoWriteLockMode(writePaths: readonly string[] | undefined): 'edit' | 'yolo' {
  return writePaths && writePaths.length > 0 ? 'edit' : 'yolo'
}

function validExecutionAdmissionBinding(
  binding: NonNullable<StartExecutionOpts['executionAdmission']> | undefined,
): binding is NonNullable<StartExecutionOpts['executionAdmission']> {
  if (binding === undefined) return false
  const values = [binding.expectedScope, binding.expectedEnvironment, binding.expectedWireModel]
  if (!values.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\0-\x1f\x7f]/u.test(value))) {
    return false
  }
  return true
}

function optsFromRow(row: LaunchFieldRow, entry: RegistryEntry): StartExecutionOpts {
  return {
    taskId: row.task_id ?? undefined,
    profile: row.profile,
    repoWriteLock: entry.repoWriteLock,
    writePaths: entry.writePaths,
    cwd: row.cwd,
    prompt: row.prompt,
    resume: row.native_session_id ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    clientFamily: row.client_family ?? undefined,
    features: parsePersistedFeatures(row.features),
  }
}

function parsePersistedFeatures(value: string | null | undefined): string[] | undefined {
  if (value === null || value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((feature) => typeof feature === 'string')
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function mapTaskStatus(status: TerminalStatus): 'done' | 'failed' | 'cancelled' | 'interrupted' {
  if (status === 'done') return 'done'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'interrupted') return 'interrupted'
  return 'failed'
}

function mapEventStatus(status: TerminalStatus): 'done' | 'failed' {
  return status === 'done' ? 'done' : 'failed'
}

function resultFromRow(row: ExecutionRecord): ExecutionResult {
  return {
    executionId: row.id,
    status: row.status,
    output: row.output,
    error: row.error,
    killReason: row.kill_reason,
  }
}

function isTerminalStatus(status: ExecutionStatus): status is TerminalStatus {
  return status === 'done'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'timeout'
    || status === 'interrupted'
}

function nextSeq(entry: RegistryEntry): number {
  entry.seq += 1
  return entry.seq
}

function generateExecutionId(): string {
  return `exec_${randomBytes(9).toString('hex')}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProp(record: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!record) return null
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function numberProp(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) next[key] = item
  }
  return next as T
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value?.trim()))
}

/**
 * Copy a retained string into a flat, exactly-sized buffer so a V8 slice cannot
 * keep a much larger incoming payload's backing store alive. The UTF-16
 * round-trip preserves every code unit, including lone surrogate halves.
 */
function detachRetainedText(value: string): string {
  return Buffer.from(value, 'utf16le').toString('utf16le')
}

/**
 * Accumulate one assistant message chunk under a hard code-unit cap.
 *
 * Below the cap the exact chunk sequence is preserved. Once the cap would be
 * crossed, the first OUTPUT_HEAD_CHARS and the newest OUTPUT_TAIL_CHARS are
 * retained with an explicit marker between them; the marker itself counts
 * toward OUTPUT_MAX_CHARS. Incoming chunks are sliced against the remaining
 * budget rather than concatenated first, so an oversized chunk is never
 * materialised in full. Empty chunks are ignored, and a region that grows into
 * many tiny parts is periodically collapsed so the array itself stays bounded.
 */
function appendOutputText(entry: RegistryEntry, text: string): void {
  if (text.length === 0) return
  if (!entry.outputTruncated) {
    if (entry.outputHeadChars + text.length <= OUTPUT_MAX_CHARS) {
      entry.outputParts.push(detachRetainedText(text))
      entry.outputHeadChars += text.length
      if (entry.outputParts.length > OUTPUT_COMPACT_PARTS) {
        const joined = entry.outputParts.join('')
        entry.outputParts = [joined]
        entry.outputHeadChars = joined.length
      }
      return
    }
    truncateOutputText(entry, text)
    return
  }
  appendOutputTail(entry, text)
}

/** Replace the middle of an over-cap sequence with the truncation marker. */
function truncateOutputText(entry: RegistryEntry, incoming: string): void {
  // The pre-truncation parts are bounded by OUTPUT_MAX_CHARS, so joining them
  // is cheap; the incoming chunk is only ever sliced.
  const existing = entry.outputParts.join('')
  const headBudget = OUTPUT_HEAD_CHARS
  const head = existing.length >= headBudget
    ? detachRetainedText(existing.slice(0, headBudget))
    : detachRetainedText(existing + incoming.slice(0, headBudget - existing.length))
  const headFromIncoming = Math.max(0, head.length - existing.length)

  const parts: string[] = []
  const tailFromIncoming = Math.min(incoming.length - headFromIncoming, OUTPUT_TAIL_CHARS)
  if (tailFromIncoming > 0) parts.push(detachRetainedText(incoming.slice(incoming.length - tailFromIncoming)))
  const neededFromExisting = OUTPUT_TAIL_CHARS - tailFromIncoming
  if (neededFromExisting > 0) {
    const suffix = detachRetainedText(existing.slice(Math.max(0, existing.length - neededFromExisting)))
    if (suffix.length > 0) parts.unshift(suffix)
  }

  entry.outputParts = [head, OUTPUT_TRUNCATION_MARKER, ...parts]
  entry.outputHeadChars = head.length
  entry.outputTailChars = parts.reduce((total, part) => total + part.length, 0)
  entry.outputTruncated = true
}

/** Append into the retained tail window of an already-truncated output. */
function appendOutputTail(entry: RegistryEntry, text: string): void {
  if (entry.outputTailChars + text.length <= OUTPUT_TAIL_CHARS) {
    entry.outputParts.push(detachRetainedText(text))
    entry.outputTailChars += text.length
    if (entry.outputParts.length - 2 > OUTPUT_COMPACT_PARTS) {
      const tail = entry.outputParts.slice(2).join('')
      entry.outputParts = [entry.outputParts[0]!, OUTPUT_TRUNCATION_MARKER, tail]
    }
    return
  }
  if (text.length >= OUTPUT_TAIL_CHARS) {
    entry.outputParts = [
      entry.outputParts[0]!,
      OUTPUT_TRUNCATION_MARKER,
      detachRetainedText(text.slice(text.length - OUTPUT_TAIL_CHARS)),
    ]
    entry.outputTailChars = OUTPUT_TAIL_CHARS
    return
  }
  const keep = OUTPUT_TAIL_CHARS - text.length
  const kept: string[] = []
  let remaining = keep
  for (let index = entry.outputParts.length - 1; index >= 2 && remaining > 0; index -= 1) {
    const part = entry.outputParts[index]!
    if (part.length <= remaining) {
      kept.unshift(part)
      remaining -= part.length
    } else {
      kept.unshift(detachRetainedText(part.slice(part.length - remaining)))
      remaining = 0
    }
  }
  kept.push(detachRetainedText(text))
  if (kept.length > OUTPUT_COMPACT_PARTS) {
    kept.splice(0, kept.length, kept.join(''))
  }
  entry.outputParts = [entry.outputParts[0]!, OUTPUT_TRUNCATION_MARKER, ...kept]
  entry.outputTailChars = keep + text.length
}

function tailString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value
  return value.slice(value.length - maxLen)
}

function chunkToString(chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  return String(chunk)
}

function defaultIsProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM means the process exists but is not signalable by this user, so only
    // ESRCH proves absence. Any other unknown failure is treated as live too, so
    // an owner we cannot inspect is never mistaken for a dead one.
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
