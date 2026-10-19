import { createAgentClients, type AgentRequest, type AgentSession } from '@wrenyard/clients';
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
import { extractForemanTaskOutputSummary } from '@wrenyard/task'
import { MODEL_REJECTION_FAILURE_CLASS, QUOTA_OR_RATE_LIMITED_FAILURE_CLASS } from '@wrenyard/task'
import { RepoWriteLocks } from './repo-write-locks.mts'
import { desktopLane, DesktopLaneClosedError, toOperationIds, OperationAdapter, type PreparedOperations } from './operation-adapter.mts'
import { parseRunSyntax, type ReasoningEffort } from '@wrenyard/providers/catalog'
import { createBuiltinCatalog } from '@wrenyard/providers'
import type {
  AgentExecutionHost,
  ClientFamily,
  CodeBuddyExecutionBinding,
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
 * Default bound on how long an attempt may run without processing a mapped
 * stream event before it is treated as a stalled route and terminalized as a
 * timeout. Mirrors the wall-clock attempt deadline but measures progress
 * instead of elapsed time, so a route that never streams is abandoned without
 * waiting for the full attempt timeout.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000

/**
 * Fixed value written to the INERT `executions.permission` DB legacy column.
 * The column is retained only for schema compatibility: it is never read,
 * interpreted, or migrated. There is no permission concept in execution.
 */
const EXECUTIONS_LEGACY_PERMISSION = 'yolo'

export interface AgentExecutionSupervisorOptions {
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
   * Injectable idle-without-stream-progress bound. An attempt that launches and
   * then processes no mapped stream event for this long is terminalized as a
   * timeout, using the same terminal path as the wall-clock attempt deadline.
   * Defaults to DEFAULT_IDLE_TIMEOUT_MS.
   */
  idleTimeoutMs?: number
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
  codeBuddyExecution?: CodeBuddyExecutionBinding
  session?: AgentSession
  pendingExit?: { exitCode: number | null; signal: NodeJS.Signals | null }
  pid?: number
  pgid?: number
  timeoutTimer?: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  /** Tool calls seen but not yet answered by their tool_result. While this set
   *  is non-empty the idle bound is suspended, not refreshed. */
  outstandingToolCalls?: Set<string>
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
  /** Code units held before truncation, or in the retained head afterwards. */
  outputHeadChars: number
  /** Code units held after the truncation marker. */
  outputTailChars: number
  /** True once the middle of the output has been replaced by the marker. */
  outputTruncated: boolean
  finalOutput?: string
  stderrTail: string
  rawResult?: string
  resultErrorTail: string
  streamError?: string
  streamDone?: Promise<void>
  childError?: string
  sawTerminalResult: boolean
  sawErrorResult: boolean
  pendingNativeSessionId?: string
  pendingClientFamily?: ClientFamily
  pendingFailureClass?: string
  /** Resolved by the attempt-deadline (timeout) handler so a bounded
   *  stream-drain await converges at the deadline instead of hanging on a
   *  held stdio pipe after an early child close. */
  attemptDeadlinePromise?: Promise<void>
  attemptDeadlineResolve?: () => void
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
  | { kind: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: 'cancel' }
  | { kind: 'timeout' }
  | { kind: 'shutdown' }
type StreamEventRecord = Record<string, unknown>
type BClassEvent = {
  type: 'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'turn_usage'
  data: Record<string, unknown>
}

export class AgentExecutionSupervisor implements AgentExecutionHost {
  private readonly db: ForemanDatabase
  private readonly repoWriteLocks: RepoWriteLocks
  private readonly logger?: SupervisorLogger
  private readonly cancelSettlementTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly killProcessTreeFn: (pid: number, pgid?: number) => Promise<void>
  private readonly isProcessLiveFn: (pid: number) => boolean
  private readonly catalog: ReturnType<typeof createBuiltinCatalog>
  private readonly execService: ExecService
  private readonly operations?: OperationAdapter
  private readonly onExecutionCompleted?: (executionId: string) => void
  /** True when this supervisor built its own fallback ExecService and must
   *  close it on shutdown. A shared, externally supplied service is never
   *  closed here. */
  private readonly ownsExecService: boolean
  private readonly registry = new Map<string, RegistryEntry>()
  private acceptingNew = true
  private promoting = false
  private readonly canStartExecution?: AgentExecutionSupervisorOptions['canStartExecution']

  constructor({ db, repoWriteLocks, logger, cancelSettlementTimeoutMs, idleTimeoutMs, killProcessTreeImpl, isProcessLiveImpl, catalog, execService, operations, canStartExecution, onExecutionCompleted }: AgentExecutionSupervisorOptions) {
    this.db = db
    this.repoWriteLocks = repoWriteLocks
    this.logger = logger
    this.cancelSettlementTimeoutMs = cancelSettlementTimeoutMs ?? CANCEL_SETTLEMENT_TIMEOUT_MS
    this.idleTimeoutMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.killProcessTreeFn = killProcessTreeImpl ?? killProcessTree
    this.isProcessLiveFn = isProcessLiveImpl ?? defaultIsProcessLive
    this.catalog = catalog ?? createBuiltinCatalog()
    // A standalone supervisor (isolated tests, library use) always runs through
    // an ExecService. It builds one over its own client map when the daemon does
    // not supply the shared configured service, so the supervisor never has a
    // direct client.start fallback and always owns only what it created.
    this.execService = execService ?? new ExecService({ clients: agentClients })
    this.ownsExecService = execService === undefined
    this.operations = operations
    this.canStartExecution = canStartExecution
    this.onExecutionCompleted = onExecutionCompleted
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
   * absent). Queued operation runs are re-driven through the normal launch path;
   * the remaining processless rows (queued non-operation runs, or pid-less
   * starting/running) use the idempotent compare-and-set terminalizer.
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
    const resumedTaskIds = new Set<string>()

    for (const row of staleRows) {
      // No recorded process to protect; a queued operation run may resume below,
      // everything else uses the idempotent CAS terminalizer.
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

    // A queued operation run waits on a host resource rather than on a process of
    // its own: re-drive it through prepare (readiness, then the FIFO lane) and the
    // queued->starting claim instead of interrupting it. A failed resume falls
    // back to the same interruption the sweep would have applied.
    for (const stale of processlessRows) {
      const row = this.get<ExecutionRecordWithFeatures>(
        `SELECT id, task_id, profile, cwd, prompt, status,
          native_session_id, client_family, pid, pgid, output, raw_result, error, exit_code,
          kill_reason, timeout_ms, requested_agent_runtime, resolved_profile, features
        FROM executions
        WHERE id = ?`,
        stale.id,
      )
      let resumable = false
      if (row?.status === 'queued') {
        const features = parsePersistedFeatures(row.features)
        if (features) {
          try {
            const operationIds = toOperationIds(features)
            resumable = operationIds.includes('desktop') || operationIds.includes('browser')
          } catch {
            resumable = false
          }
        }
      }
      if (!row || !resumable) {
        interruptible.push({ id: stale.id, taskId: stale.task_id })
        continue
      }
      try {
        const entryOpts: StartExecutionOpts = {
          taskId: row.task_id ?? undefined,
          profile: row.profile,
          cwd: row.cwd,
          prompt: row.prompt,
          resume: row.native_session_id ?? undefined,
          timeoutMs: row.timeout_ms ?? undefined,
          clientFamily: row.client_family ?? undefined,
          features: parsePersistedFeatures(row.features),
        }
        const entry = this.createRegistryEntry(row.id, entryOpts, false, this.maxSeq(row.id))
        this.registry.set(row.id, entry)
        entry.wasQueued = true
        await this.launchExecution(entry, optsFromRow(row, entry), true, { skipAdmissionCheck: true })
        if (row.task_id) resumedTaskIds.add(row.task_id)
      } catch (error: unknown) {
        this.log('warn', `[foreman] Failed to resume queued execution ${stale.id} on startup`, {
          executionId: stale.id,
          action: 'resume',
          phase: 'startup-resume',
          result: 'failed',
          error: errorMessage(error),
        })
        interruptible.push({ id: stale.id, taskId: stale.task_id })
      }
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
          })
        }
        this.repoWriteLocks.releaseByExecution(target.id)
      })
    }

    // Tasks whose execution could not be verified dead stay active; the
    // remaining processless queued/running tasks are interrupted.
    for (const task of this.query<{ id: string }>(`SELECT id FROM tasks WHERE status IN ('queued', 'running')`)) {
      if (failedTaskIds.has(task.id)) continue
      if (resumedTaskIds.has(task.id)) continue
      this.taskRuns().markTerminal({
        taskRunId: task.id,
        status: 'interrupted',
        error: 'interrupted on startup',
        endedAt: timestamp,
      })
    }

    for (const entry of [...this.registry.values()]) {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
      this.clearIdleTimer(entry)
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
      codeBuddyExecution: isCodeBuddyExecution(opts) && opts.codeBuddyExecution
        ? Object.freeze({ ...opts.codeBuddyExecution })
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
      outputHeadChars: 0,
      outputTailChars: 0,
      outputTruncated: false,
      stderrTail: '',
      resultErrorTail: '',
      sawTerminalResult: false,
      sawErrorResult: false,
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
    let prepared: PreparedOperations | undefined
    const laneAbort = new AbortController()
    try {
      const profile = resolvedProfile ?? opts.profile;
      const syntax = profile.includes(':') ? parseRunSyntax(profile) : undefined;
      const clientId = syntax?.client ?? opts.clientFamily;
      const client = clientId ? agentClients.get(clientId) : undefined;
      if (!client?.capabilities.run) throw new Error('Execution requires a resolved agent client');
      if (!syntax?.model) throw new Error('Execution requires a resolved model');
      const plan = this.buildReasoningEffortPlanEnv(entry.executionId, opts.dispatchSnapshot?.fast)?.plan ?? this.catalog.resolveRun(syntax.client, syntax.provider, syntax.model, opts.dispatchSnapshot?.reasoningEffort, opts.dispatchSnapshot?.fast);
      // A native dispatch must hand the CLI the exact wire spelling the
      // installed product/login declares — e.g. canonical `claude-sonnet-5` is
      // the product's 1M row `claude-sonnet-5-1m`, not the 200K row that shares
      // the public id. The admission binding already carries that wire id for
      // this exact execution (resolved from the current product snapshot when
      // the run was admitted); an explicit reasoning-effort-mapped substitution still
      // wins. The public canonical id stays in canonicalModel, so observed ids
      // normalize back and no wire spelling ever reaches a public surface.
      const launchModel = plan.upstreamModel
        ?? (plan.mode === 'native' ? entry.codeBuddyExecution?.expectedWireModel : undefined)
        ?? syntax.model;
      this.log('debug', '[foreman] starting agent execution ' + entry.executionId, {client: client.id, model: syntax.model});
      // The resolved client/provider/model/mode/reasoning-effort/cwd are all owned by
      // the task layer. The daemon's shared ExecService only runs the resolved
      // client, so both this path and an explicit `wrenyard exec` share one
      // launch/feature/replay implementation.
      if (plan.reasoningEffort === undefined) throw new Error("Execution requires a persisted reasoningEffort");
      const agentRequest: AgentRequest = {
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
      };
      const operationIds = toOperationIds(opts.features)
      if (operationIds.length > 0) {
        if (!this.operations) throw new Error('Operation components are not available in this runtime')
        const laneWatch = setInterval(() => {
          if (entry.cancelRequested || entry.terminalIntent) laneAbort.abort()
        }, 250)
        try {
          prepared = await this.operations.prepare({
            prompt: opts.prompt,
            ids: operationIds,
            runId: entry.executionId,
            owner: opts.taskId ?? entry.executionId,
            clientId,
            signal: laneAbort.signal,
            onQueued: () => {
              if (opts.taskId) this.taskRuns().markWaiting(opts.taskId, nowIso())
            },
          })
        } finally {
          clearInterval(laneWatch)
        }
      }
      // The fully resolved user request is shaped once, then lowered onto the
      // shared exec surface. Requested operation components (legacy ids
      // browser/browser-use and computer/computer-use) are resolved by the shared
      // operation adapter: it checks readiness on this host, attaches the CLI
      // environment or MCP server and the guidance text, and fails before spawn
      // when a component is not ready. An unknown id still throws.
      const execRequest: ExecRequest = {
        ...agentRequest,
        prompt: prepared?.prompt ?? agentRequest.prompt,
        ...(prepared?.mcpServers ? { mcpServers: prepared.mcpServers } : {}),
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
      const operationOptions = {
        env: prepared ? prepared.applyEnv(baseEnv) : baseEnv,
      };
      const claimed = this.run(
        `UPDATE executions
        SET status = 'starting', updated_at = ?
        WHERE id = ? AND status = 'queued'`,
        nowIso(),
        entry.executionId,
      )
      if (claimed.changes !== 1) {
        await prepared?.release().catch(() => undefined)
        return
      }
      if (opts.taskId) this.taskRuns().markStarted(opts.taskId, nowIso())
      session = await this.execService.start(execRequest, operationOptions)
      if (prepared) {
        const release = prepared
        void Promise.resolve(session.result).catch(() => undefined).finally(() => { void release.release() })
      }
    } catch (error) {
      await prepared?.release().catch(() => undefined)
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
    this.tx(() => {
      this.run(
        `UPDATE executions
        SET status = 'running', pid = ?, pgid = ?, started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'starting'`,
        session.diagnostics.pid ?? null,
        null,
        timestamp,
        timestamp,
        entry.executionId,
      )
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

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      let resolveDeadline!: () => void
      const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve })
      entry.attemptDeadlinePromise = deadline
      entry.attemptDeadlineResolve = resolveDeadline
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

    this.armIdleTimer(entry)

    this.attachChildObservers(entry)
  }

  /**
   * Arms the per-attempt idle bound. The timer is suspended while a tool call is
   * outstanding and re-armed when its tool_result arrives; otherwise it is
   * refreshed only by real model output as decided by isModelOutputProgress: a
   * tool_call, a tool_result, or a message/reasoning event whose text is not
   * blank. Heartbeat, status and usage events do not reset it. Expiry commits
   * the same terminal intent as the wall-clock attempt deadline; a committed
   * terminal state is never overridden.
   */
  private armIdleTimer(entry: RegistryEntry): void {
    if (this.idleTimeoutMs <= 0) return
    this.clearIdleTimer(entry)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined
      if (entry.terminalGeneration > 0) return
      entry.terminalIntent = { kind: 'timeout' }
      entry.timedOut = true
      entry.attemptDeadlineResolve?.()
      void this.requestKillOnce(entry).catch((error: unknown) => {
        this.log('warn', `[foreman] Idle-timeout kill failed for ${entry.executionId}: ${errorMessage(error)}`)
      })
      void this.settleAttemptTimeout(entry)
    }, this.idleTimeoutMs)
  }

  private clearIdleTimer(entry: RegistryEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private attachChildObservers(entry: RegistryEntry): void {
    if (!entry.session) return

    entry.streamDone = this.consumeStream(entry).catch((error: unknown) => {
      entry.streamError = redactDiagnosticText(errorMessage(error))
      this.log('warn', `[foreman] stream consumer failed for ${entry.executionId}: ${entry.streamError}`)
    })
    void entry.streamDone.then(() => {
      const exit = entry.pendingExit
      if (!exit) return
      void this.handleChildClose(entry, exit.exitCode, exit.signal).catch((error: unknown) => {
        this.log('error', `[foreman] close handler failed for ${entry.executionId}: ${errorMessage(error)}`)
      })
    })
  }

  private async consumeStream(entry: RegistryEntry): Promise<void> {
    if (!entry.session) return

    for await (const agentEvent of entry.session.events) {
      if (agentEvent.type === 'stderr') {
        // Scrub the combined previous/current text (not just the new chunk)
        // before bounding, so a sensitive key split across chunk boundaries is
        // still redacted without losing its label to the tail cut.
        entry.stderrTail = tailString(
          redactDiagnosticText(entry.stderrTail + agentEvent.text),
          STDERR_TAIL_MAX_LEN,
        )
        continue
      }
      if (agentEvent.type === 'error') {
        entry.childError = redactDiagnosticText(agentEvent.message)
        continue
      }
      if (agentEvent.type === 'exit') {
        entry.pendingExit = { exitCode: agentEvent.exitCode, signal: agentEvent.signal }
        return
      }
      // A bounded cancellation may have terminalized and forgotten this entry
      // while the stream is stalled; late stream events must not mutate the
      // terminal state or insert post-terminal events.
      if (entry.terminalGeneration > 0) return
      const rawEvent = agentEvent.record
      const event = normalizeClientEvent(rawEvent)
      if (!event) continue
      const detectedNative = detectNativeSession(event)
      if (detectedNative) {
        entry.pendingNativeSessionId = detectedNative.nativeSessionId
        entry.pendingClientFamily = detectedNative.clientFamily
      }
      const detectedProfile = detectResolvedProfile(event)
      if (detectedProfile) {
        this.captureResolvedProfileOnce(entry.executionId, detectedProfile, nowIso())
      }

      const detectedFailureClass = detectFailureClass(event)
      if (detectedFailureClass) {
        entry.pendingFailureClass = detectedFailureClass
      }

      const final = extractFinalResult(event)
      if (final) {
        entry.rawResult = redactJsonString(stableStringify(rawEvent))
        entry.sawTerminalResult ||= !final.isError
        entry.sawErrorResult ||= final.isError
        if (final.output) entry.finalOutput = final.output
      }
      const streamErrorText = extractStreamJsonErrorText(event, final)
      if (streamErrorText) {
        entry.resultErrorTail = tailString(
          redactDiagnosticText(`${entry.resultErrorTail}${entry.resultErrorTail ? '\n' : ''}${streamErrorText}`),
          STDERR_TAIL_MAX_LEN,
        )
      }

      const mappedEvents = mapStreamEventToBClass(event)
      if (mappedEvents.length > 0) {
        this.tx(() => {
          for (const mapped of mappedEvents) {
            // A tool call suspends the idle bound until its tool_result arrives, so
            // a legitimately long-running tool cannot be killed while it runs. The
            // wall-clock attempt deadline still applies.
            if (mapped.type === 'tool_call') {
              entry.outstandingToolCalls ??= new Set()
              entry.outstandingToolCalls.add(typeof mapped.data.call_id === 'string' ? mapped.data.call_id : '')
              if (entry.outstandingToolCalls.size === 1) this.clearIdleTimer(entry)
            } else if (mapped.type === 'tool_result') {
              entry.outstandingToolCalls?.delete(typeof mapped.data.call_id === 'string' ? mapped.data.call_id : '')
              if (entry.outstandingToolCalls && entry.outstandingToolCalls.size === 0) this.armIdleTimer(entry)
            }
            // With no tool outstanding, only real model output resets the idle
            // bound: a tool_call, a tool_result, or non-blank message/reasoning text.
            // Status, heartbeat, token accounting and blank text are not progress.
            if (isModelOutputProgress(mapped)) {
              entry.idleTimer?.refresh()
            }
            if (mapped.type === 'message' && typeof mapped.data.text === 'string') {
              appendOutputText(entry, mapped.data.text)
            }

            const redacted = redactEvent(mapped.type, mapped.data)
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

  private async handleChildClose(entry: RegistryEntry, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.claimTerminalIntent(entry, { kind: 'exit', exitCode, signal })
    const intent = entry.terminalIntent
    await this.drainStreamAtDeadline(entry)
    const status = this.determineTerminalStatus(entry, intent)
    const killReason = this.determineKillReason(entry, status, intent)
    const rawAgentOutput = (entry.finalOutput ?? entry.outputParts.join('')).trim() || null
    // A failed execution keeps a bounded, redacted diagnostic tail of the
    // child's captured error signals, so the real cause (e.g. an HTTP 400
    // unsupported-model message) is retained even when a generic child error
    // also exists. The tail is carried in the execution output as well as the
    // error. Any failed agent output that accompanies the diagnostics is
    // scrubbed too: a failed child can echo plain-text credentials that no
    // structured field would have caught.
    const failureDiagnostic = status === 'failed' ? this.failedDiagnosticTail(entry) : null
    const agentOutput = status === 'failed' && rawAgentOutput !== null
      ? redactDiagnosticText(rawAgentOutput)
      : rawAgentOutput
    const output = failureDiagnostic === null
      ? agentOutput
      : (agentOutput === null ? failureDiagnostic : `${agentOutput}\n${failureDiagnostic}`)
    const error = this.determineTerminalError(entry, status, failureDiagnostic)

    this.terminalizeRunning(entry, {
      status,
      exitCode,
      signal,
      killReason,
      output,
      error,
      failureClass: this.classifyClientFailure(entry, failureDiagnostic),
    })
  }

  /**
   * Bounded, redacted diagnostic tail of a failed execution assembled from every
   * captured client signal (raw stderr tail, structured result error tail, stream
   * error, child error). The concise, structured causes follow the raw stderr so
   * they survive the tail bound, each part is scrubbed with the shared
   * diagnostic-text redactor (JSON/JSONL keys plus plain key=value and token
   * forms) before it is retained, persisted or published, and the joined text is
   * bounded to STDERR_TAIL_MAX_LEN. Returns null when nothing was captured.
   */
  private failedDiagnosticTail(entry: RegistryEntry): string | null {
    const parts = compactStrings([
      entry.stderrTail,
      entry.resultErrorTail,
      entry.streamError,
      entry.childError,
    ]).map((part) => redactDiagnosticText(part))
    if (parts.length === 0) return null
    return tailString(parts.join('\n'), STDERR_TAIL_MAX_LEN)
  }

  /**
   * The failure classification carried to route health. A client-supplied class
   * (from a run_finished record) wins; otherwise a bounded diagnostic matching a
   * specific model-rejection signature is classified as `model_rejected` so the
   * exact route is marked unhealthy. An ordinary failed execution stays
   * unclassified (null).
   */
  private classifyClientFailure(entry: RegistryEntry, failureDiagnostic: string | null): string | null {
    // A client-supplied class normally wins, but a generic missing-terminal-result
    // delivery failure must not mask an upstream quota/rate-limit diagnostic:
    // those CLIs print the quota error and exit without a result record, and the
    // quota class is the actionable one for route health and automatic retry.
    if (entry.pendingFailureClass === 'protocol_missing_terminal_result' &&
        failureDiagnostic !== null && isQuotaOrRateLimitText(failureDiagnostic)) {
      return QUOTA_OR_RATE_LIMITED_FAILURE_CLASS
    }
    if (entry.pendingFailureClass) return entry.pendingFailureClass
    if (failureDiagnostic !== null && isModelRejectionText(failureDiagnostic)) {
      return MODEL_REJECTION_FAILURE_CLASS
    }
    if (failureDiagnostic !== null && isQuotaOrRateLimitText(failureDiagnostic)) {
      return QUOTA_OR_RATE_LIMITED_FAILURE_CLASS
    }
    return null
  }

  private determineTerminalStatus(entry: RegistryEntry, intent: TerminalIntent | undefined): TerminalStatus {
    if (intent?.kind === 'shutdown') return 'interrupted'
    if (intent?.kind === 'cancel') return 'cancelled'
    if (intent?.kind === 'timeout') return 'timeout'
    const exitCode = intent?.kind === 'exit' ? intent.exitCode : null
    if (exitCode === 0 && entry.sawTerminalResult && !entry.sawErrorResult) return 'done'
    return 'failed'
  }

  private determineKillReason(
    entry: RegistryEntry,
    status: TerminalStatus,
    intent: TerminalIntent | undefined,
  ): KillReason {
    if (status === 'cancelled') return 'cancel'
    if (status === 'timeout') return 'timeout'
    if (status === 'interrupted') return 'shutdown'
    const exitCode = intent?.kind === 'exit' ? intent.exitCode : null
    if (status === 'failed' && exitCode !== 0) return 'crash'
    return null
  }

  private determineTerminalError(
    entry: RegistryEntry,
    status: TerminalStatus,
    failureDiagnostic: string | null,
  ): string | null {
    if (status === 'done') return null
    if (status === 'cancelled') return 'cancelled'
    if (status === 'timeout') return 'timeout'
    // The whole bounded, redacted diagnostic tail is reported instead of only the
    // first truthy captured field, so a generic child error never hides the real
    // cause.
    if (!entry.sawTerminalResult && !entry.sawErrorResult) return failureDiagnostic ?? 'no terminal event'
    return failureDiagnostic ?? 'execution failed'
  }

  private terminalizeRunning(
    entry: RegistryEntry,
  terminal: {
    status: TerminalStatus
    exitCode: number | null
    signal: NodeJS.Signals | null
    killReason: KillReason
    output: string | null
    error: string | null
    failureClass?: string | null
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
      const terminalSummary = extractForemanTaskOutputSummary(terminal.output)
      this.tx(() => {
        const updateResult = this.run(
          `UPDATE executions
          SET status = ?, ended_at = ?, exit_code = ?, kill_signal = ?, kill_reason = ?,
            output = ?, raw_result = ?, error = ?, updated_at = ?
          WHERE id = ? AND status = 'running'`,
          terminal.status,
          endedAt,
          terminal.exitCode,
          terminal.signal,
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
          exitCode: terminal.status === 'cancelled' ? undefined : terminal.exitCode,
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
            exitCode: terminal.exitCode,
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
        result = {
          executionId: entry.executionId,
          status: terminal.status,
          output: terminal.output,
          error: terminal.error,
          exitCode: terminal.exitCode,
          killReason: terminal.killReason,
          failureClass: terminal.failureClass ?? null,
        }
      } else {
        const row = this.getExecution(entry.executionId)
        if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
        else terminalError = new Error(`Execution '${entry.executionId}' terminal transaction did not commit`)
      }

      // Optional native-session persistence happens strictly AFTER the terminal
      // commit and is best-effort: a failure here can never roll back the
      // committed terminal result, never leak the repo write lock, and never
      // discard the usage/events captured before the failure.
      if (committed && terminal.status === 'done') {
        try {
          this.persistNativeSessionIfCaptured(entry, endedAt)
        } catch (sessionError) {
          this.log(
            'warn',
            `[foreman] Failed to persist native session for ${entry.executionId}: ${errorMessage(sessionError)}`,
          )
        }
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
          exitCode: null,
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
        this.resolveAndForget(entry, result ?? {
          executionId: entry.executionId,
          status: 'failed',
          error: message,
          killReason: 'spawn-error',
        })
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
          exitCode: null,
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
        this.resolveAndForget(entry, result ?? {
          executionId: entry.executionId,
          status,
          error,
          killReason,
        })
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
        exitCode: null,
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
    const won = this.reconcileTimeout(entry.executionId, nowIso())
    let result: ExecutionResult | undefined
    if (won) {
      result = {
        executionId: entry.executionId,
        status: 'timeout',
        output: (entry.finalOutput ?? entry.outputParts.join('')).trim() || null,
        error: 'timeout',
        exitCode: null,
        killReason: 'timeout',
      }
    } else {
      const row = this.getExecution(entry.executionId)
      if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
    }
    if (result) {
      entry.terminalGeneration += 1
      this.resolveAndForget(entry, result)
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
        exitCode: null,
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
    this.clearIdleTimer(entry)
    this.registry.delete(entry.executionId)
    entry.resolveWait(result)
  }

  private rejectAndForget(entry: RegistryEntry, error: unknown): void {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
    this.clearIdleTimer(entry)
    // A terminal transaction that threw rolled back together with its
    // in-transaction repo-lock release, so release again here as a guaranteed
    // fallback on the error path (releaseByExecution is idempotent).
    this.repoWriteLocks.releaseByExecution(entry.executionId)
    this.registry.delete(entry.executionId)
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
    exitCode?: number | null
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
      exitCode: opts.exitCode,
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

/**
 * Reports whether a mapped stream event is real model output: a tool call, a
 * tool result, or a message/reasoning event carrying non-whitespace text. Usage
 * accounting, blank text and status noise are not idle-watchdog progress; a
 * tool that is still running is handled by the outstanding-call suspension
 * rather than by refreshing the idle bound.
 */
function isModelOutputProgress(mapped: BClassEvent): boolean {
  if (mapped.type === 'tool_call' || mapped.type === 'tool_result') return true
  if (mapped.type === 'message' || mapped.type === 'reasoning') {
    return typeof mapped.data.text === 'string' && mapped.data.text.trim().length > 0
  }
  return false
}

export function mapStreamEventToBClass(event: StreamEventRecord): BClassEvent[] {
  const type = stringProp(event, 'type')
  const mapped: BClassEvent[] = []

  if (type === 'assistant') {
    const message = recordProp(event, 'message')
    const content = arrayProp(message, 'content')
    const text = contentText(content)
    if (text) mapped.push({ type: 'message', data: { role: 'assistant', text } })

    for (const block of content) {
      if (!isRecord(block) || stringProp(block, 'type') !== 'tool_use') continue
      const name = stringProp(block, 'name') ?? 'tool'
      mapped.push({
        type: 'tool_call',
        data: {
          name,
          input_summary: summarizeUnknown(block.input),
          call_id: stringProp(block, 'id') ?? stringProp(block, 'call_id'),
        },
      })
    }
  } else if (type === 'user') {
    const message = recordProp(event, 'message')
    const content = arrayProp(message, 'content')
    for (const block of content) {
      if (!isRecord(block) || stringProp(block, 'type') !== 'tool_result') continue
      mapped.push({
        type: 'tool_result',
        data: {
          call_id: stringProp(block, 'tool_use_id') ?? stringProp(block, 'call_id') ?? stringProp(block, 'id'),
          status: block.is_error === true ? 'error' : 'ok',
          output_tail: tailString(contentText(arrayProp(block, 'content')) || stringifyOutput(block.content), STDERR_TAIL_MAX_LEN),
        },
      })
    }
  } else if (type === 'item.started') {
    const item = recordProp(event, 'item')
    if (isCodexToolItem(item)) {
      mapped.push({
        type: 'tool_call',
        data: {
          name: stringProp(item, 'name') ?? stringProp(item, 'tool_name') ?? stringProp(item, 'type') ?? 'tool',
          input_summary: summarizeUnknown(item.arguments ?? item.input ?? item.command),
          call_id: stringProp(item, 'id') ?? stringProp(item, 'call_id'),
        },
      })
    }
  } else if (type === 'item.completed') {
    const item = recordProp(event, 'item')
    if (stringProp(item, 'type') === 'agent_message') {
      const text = stringProp(item, 'text')
      if (text) mapped.push({ type: 'message', data: { role: 'assistant', text } })
    } else if (isCodexToolResultItem(item)) {
      mapped.push({
        type: 'tool_result',
        data: {
          call_id: stringProp(item, 'call_id') ?? stringProp(item, 'id'),
          status: isErrorToolItem(item) ? 'error' : 'ok',
          output_tail: tailString(stringifyOutput(item.output ?? item.result ?? item.text ?? item.aggregated_output), STDERR_TAIL_MAX_LEN),
        },
      })
    }
  } else if (type === 'message') {
    const text = stringProp(event, 'text')
    if (text) {
      mapped.push({
        type: 'message',
        data: {
          role: stringProp(event, 'role') ?? 'assistant',
          text,
        },
      })
    }
  } else if (type === 'reasoning') {
    const text = stringProp(event, 'text')
    if (text) mapped.push({ type: 'reasoning', data: { text } })
  } else if (type === 'tool_call') {
    mapped.push({
      type: 'tool_call',
      data: {
        name: stringProp(event, 'name') ?? 'tool',
        input_summary: stringProp(event, 'input_summary') ?? summarizeUnknown(event.input ?? event.arguments ?? event.command),
        call_id: stringProp(event, 'call_id') ?? stringProp(event, 'id'),
      },
    })
  } else if (type === 'tool_result') {
    mapped.push({
      type: 'tool_result',
      data: {
        call_id: stringProp(event, 'call_id') ?? stringProp(event, 'tool_use_id') ?? stringProp(event, 'id'),
        status: stringProp(event, 'status') ?? (event.is_error === true ? 'error' : 'ok'),
        output_tail: tailString(
          stringProp(event, 'output_tail') ?? stringifyOutput(event.output ?? event.result ?? event.text ?? event.content),
          STDERR_TAIL_MAX_LEN,
        ),
      },
    })
  }

  if (type === 'turn_usage') {
    mapped.push({
      type: 'turn_usage',
      data: {
        input_tokens: numberProp(event, 'input_tokens'),
        output_tokens: numberProp(event, 'output_tokens'),
        // Preserve the cache partition and aggregate total fields so Cursor's
        // normalized token usage survives the mapping untouched. The mapper
        // never infers trust or fabricates values: a missing cache partition
        // is omitted and an invalid number is never upgraded.
        cached_input_tokens: numberProp(event, 'cached_input_tokens'),
        cache_read_input_tokens: numberProp(event, 'cache_read_input_tokens'),
        cache_creation_input_tokens: numberProp(event, 'cache_creation_input_tokens'),
        total_tokens: numberProp(event, 'total_tokens'),
        duration_ms: numberProp(event, 'duration_ms'),
        // Preserve normalized response samples only when supplied.
        tps_samples: mapTpsSamples(event.tps_samples),
        token_scope: stringProp(event, 'token_scope') ?? undefined,
        duration_scope: stringProp(event, 'duration_scope') ?? undefined,
        tps_contract: stringProp(event, 'tps_contract') ?? undefined,
      },
    })
  }

  return mapped.map((item) => ({
    type: item.type,
    data: dropUndefined(item.data),
  }))
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

function normalizeClientEvent(event: StreamEventRecord): StreamEventRecord | undefined {
  return stringProp(event, 'type') ? event : undefined
}

function detectNativeSession(event: StreamEventRecord): { nativeSessionId: string; clientFamily: ClientFamily } | undefined {
  if (stringProp(event, 'type') !== 'run_finished') return undefined

  const nativeSessionId = stringProp(event, 'native_session_id')
  const clientFamily = stringProp(event, 'client_family')
  if (nativeSessionId && isClientFamily(clientFamily)) {
    return { nativeSessionId, clientFamily }
  }

  return undefined
}

function isClientFamily(value: string | null | undefined): value is ClientFamily {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'cursor' || value === 'grok' || value === 'dsh' || value === 'codebuddy'
}

function detectResolvedProfile(event: StreamEventRecord): string | undefined {
  const type = stringProp(event, 'type')
  if (type !== 'run_started' && type !== 'run_finished') {
    return undefined
  }
  const profile = stringProp(event, 'profile')
  return profile ? profile.trim() : undefined
}

function detectFailureClass(event: StreamEventRecord): string | undefined {
  if (stringProp(event, 'type') !== 'run_finished') {
    return undefined
  }
  const fc = stringProp(event, 'failure_class')
  return fc ? fc.trim() : undefined
}

/**
 * Signatures of a client-reported model rejection: the client child refusing the
 * resolved model because it is unsupported for its product/account, or an
 * upstream model-not-found response. These are deliberately narrow and specific
 * so an ordinary execution failure is never misclassified as a model/route
 * problem.
 */
const MODEL_REJECTION_PATTERNS: readonly RegExp[] = [
  /not supported when using [a-z0-9._-]+/iu,
  /model ['"`]?[A-Za-z0-9._:/-]+['"`]? is not supported/iu,
  /\bunsupported (?:model|model id)\b/iu,
  /\bmodel_(?:not_found|not_supported|unavailable)\b/iu,
  /\b(?:unknown|no such|invalid) model\b/iu,
  /(?:do(?:es)? not|don't) have access to (?:the )?model/iu,
  // The free promotion ending is reported as a free-tier rejection or as an
  // explicit promotion end; both mean this exact route no longer serves.
  /\bFreeTierError\b/iu,
  /free[ _-]?(?:tier|promotion)\b[^.]{0,60}\b(?:end|expir|no longer|unavailable|exhaust)/iu,
]

/** True when a captured diagnostic text matches a specific model-rejection signature. */
function isModelRejectionText(text: string): boolean {
  return MODEL_REJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Signatures of a provider quota-exhausted or rate-limited response surfaced
 * through the native client path (the opencode child exits non-zero with an
 * HTTP 402/429 or a quota/rate-limit message in its stderr). The gateway's
 * HTTP status classifier does not run on the native path, so the daemon must
 * recognize the signature from the child's diagnostic text instead.
 *
 * These are deliberately narrow: every pattern requires a billing/quota/rate
 * keyword (or the literal 402/429 status) so an ordinary model error is never
 * misclassified as a recoverable quota condition. The bare token "exceeded" is
 * never matched on its own — it is only a quota signal when it is anchored to a
 * billing/quota/rate keyword within the same short message fragment.
 */
const QUOTA_OR_RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b402\b/iu,
  /\b429\b/iu,
  /\bquota\b/iu,
  /\binsufficient_quota\b/iu,
  /\brate[ _-]?limit/iu,
  /\busage[ _-]?limit/iu,
  /\bbilling\b/iu,
  /\bexceed(?:ed|s)?[^.]{0,40}\b(?:quota|rate[ _-]?limit|usage[ _-]?limit|billing)\b/i,
]

/** True when a captured diagnostic text indicates a quota-exhausted or rate-limited condition. */
function isQuotaOrRateLimitText(text: string): boolean {
  return QUOTA_OR_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))
}

function extractFinalResult(event: StreamEventRecord): { isError: boolean; output?: string } | undefined {
  const type = stringProp(event, 'type')
  if (type === 'run_finished') {
    const status = stringProp(event, 'status')
    const exitCode = numberProp(event, 'exit_code')
    return {
      isError: event.is_error === true || status === 'failed' || (exitCode !== undefined && exitCode !== 0),
      output: stringProp(event, 'output') ?? stringProp(event, 'summary') ?? undefined,
    }
  }

  return undefined
}

function extractStreamJsonErrorText(
  event: StreamEventRecord,
  final: { isError: boolean; output?: string } | undefined,
): string | undefined {
  const type = stringProp(event, 'type')
  if (final?.isError) {
    return compactStrings([
      final.output,
      stringProp(event, 'error'),
      stringProp(recordProp(event, 'error'), 'message'),
      stringProp(event, 'message'),
      stringProp(event, 'reason'),
      stringProp(event, 'details'),
    ]).join('\n') || stableStringify(event)
  }

  if (type !== 'error' && type !== 'turn.failed') return undefined

  return compactStrings([
    stringProp(event, 'error'),
    stringProp(recordProp(event, 'error'), 'message'),
    stringProp(event, 'message'),
    stringProp(event, 'reason'),
    stringProp(event, 'details'),
    stringProp(event, 'result'),
    stringProp(event, 'output'),
    stringProp(event, 'summary'),
  ]).join('\n') || stableStringify(event)
}

function isCodexToolItem(item: Record<string, unknown> | null): item is Record<string, unknown> {
  if (!item) return false
  const itemType = stringProp(item, 'type') ?? ''
  return itemType.includes('tool') || itemType.includes('function_call') || itemType === 'command_execution'
}

function isCodexToolResultItem(item: Record<string, unknown> | null): item is Record<string, unknown> {
  if (!item) return false
  const itemType = stringProp(item, 'type') ?? ''
  return itemType.includes('tool') || itemType.includes('function_call_output') || itemType === 'command_execution'
}

function isErrorToolItem(item: Record<string, unknown>): boolean {
  const status = stringProp(item, 'status')
  const exitCode = numberProp(item, 'exit_code')
  return item.is_error === true || status === 'failed' || status === 'error' || (exitCode !== undefined && exitCode !== 0)
}

function assertStartExecutionOpts(opts: StartExecutionOpts): void {
  if (!opts.profile.trim()) throw new Error('startExecution profile is required')
  if (!opts.cwd.trim()) throw new Error('startExecution cwd is required')
  if (!opts.prompt.trim()) throw new Error('startExecution prompt is required')
  if (opts.clientFamily !== undefined && !isClientFamily(opts.clientFamily)) {
    throw new Error(`Invalid client family '${opts.clientFamily}'`)
  }
  if (isCodeBuddyExecution(opts) && !validCodeBuddyExecutionBinding(opts.codeBuddyExecution)) {
    // Generic by design: no expected/current scope, environment, or wire value
    // may enter an error string or log record.
    throw new Error('CodeBuddy execution admission binding is unavailable')
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

function isCodeBuddyExecution(opts: StartExecutionOpts): boolean {
  const snapshot = opts.dispatchSnapshot
  if (snapshot?.provider === 'codebuddy' && snapshot.client === 'codebuddy' && snapshot.mode === 'native') {
    return true
  }
  try {
    const parsed = parseRunSyntax(opts.profile)
    return parsed.provider === 'codebuddy' && parsed.client === 'codebuddy'
  } catch {
    return false
  }
}

function validCodeBuddyExecutionBinding(
  binding: CodeBuddyExecutionBinding | undefined,
): binding is CodeBuddyExecutionBinding {
  if (binding === undefined) return false
  const values = [binding.expectedScope, binding.expectedEnvironment, binding.expectedWireModel]
  if (!values.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0'))) {
    return false
  }
  return ['internal', 'ioa', 'cloudhosted', 'external', 'unknown'].includes(binding.expectedEnvironment)
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
    exitCode: row.exit_code,
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

function recordProp(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  if (!record) return null
  const value = record[key]
  return isRecord(value) ? value : null
}

function arrayProp(record: Record<string, unknown> | null | undefined, key: string): unknown[] {
  if (!record) return []
  const value = record[key]
  return Array.isArray(value) ? value : []
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

function contentText(content: unknown[]): string {
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
    } else if (isRecord(item) && typeof item.text === 'string') {
      parts.push(item.text)
    }
  }
  return parts.join('')
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : stableStringify(value)
  return tailString(text, 500)
}

function stringifyOutput(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return stableStringify(value)
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
