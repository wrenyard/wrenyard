import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { ForemanDatabase } from '../../db/types.mts'
import { ExecutionEventStore } from '../../db/stores/execution-event-store.mts'
import { TaskRunStore } from '../../db/stores/task-run-store.mts'
import {
  buildForgeCommand,
  readStreamJson,
  spawnForge,
  type ForgeStreamJsonEvent,
} from '../../adapters/forge/direct-client.mts'
import { assertValidTimeoutMs } from '../../task-timeouts.mts'
import { killProcessTree } from '../../adapters/shell/process.mts'
import { redactEvent, redactJsonString } from './redaction.mts'
import { extractForemanTaskOutputSummary } from '../../core/task/delivery-protocol.mts'
import { RepoWriteLocks, requiresRepoWriteLock } from './repo-write-locks.mts'
import { parseAgentRuntime } from '../../core/agent-runtime.mts'
import type {
  AgentExecutionHost,
  AgentRuntimePermission,
  ClientFamily,
  ExecutionHandle,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
  StartAgentExecutionOptions as StartExecutionOpts,
} from '../../core/operations/types.mts'
import type { AgentEventStore, AgentDelegationRecord } from '../../core/agent/agent-event-store.mts'
export type {
  ClientFamily,
  ExecutionHandle,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
  StartAgentExecutionOptions as StartExecutionOpts,
} from '../../core/operations/types.mts'

// ─── Delegation types ─────────────────────────────────────────────────

export type DelegationResolution = 'terminal' | 'active' | 'lost'

export interface DelegationResourceResolver {
  /**
   * Check the current status of a delegation resource.
   * Returns true if terminal (done/failed/cancelled), false if active,
   * undefined if the resource does not exist (lost).
   */
  checkResourceStatus(resourceId: string): DelegationResolution | undefined

  /**
   * Get the terminal payload for a resource (result/output) to include
   * in the delegation_terminal event and system_completion turn text.
   */
  getResourcePayload?(resourceId: string): string | undefined
}

const MAX_CONCURRENT_EXECUTIONS = 10
const SHUTDOWN_GRACE_MS = 10_000
const STDERR_TAIL_MAX_LEN = 4_000
/**
 * Default bound for settling a registered active-execution cancellation when
 * the child-close/stream observer is absent or stalled. After the process-tree
 * kill succeeds (or the registered PID is already absent), the supervisor waits
 * up to this long for the observer to commit the terminal state, then uses the
 * shared compare-and-set reconciler to durably terminalize the execution as
 * cancelled.
 */
const CANCEL_SETTLEMENT_TIMEOUT_MS = 5_000

export interface AgentExecutionSupervisorOptions {
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
  permission: AgentRuntimePermission
  writePaths?: readonly string[]
  child?: ChildProcess
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
}

type TerminalStatus = 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'
type KillReason = 'cancel' | 'timeout' | 'shutdown' | 'crash' | 'spawn-error' | null
type TerminalIntent =
  | { kind: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: 'cancel' }
  | { kind: 'timeout' }
  | { kind: 'shutdown' }
type StreamEventRecord = Record<string, unknown>
type BClassEvent = { type: 'message' | 'tool_call' | 'tool_result' | 'turn_usage'; data: Record<string, unknown> }

export class AgentExecutionSupervisor implements AgentExecutionHost {
  private readonly db: ForemanDatabase
  private readonly repoWriteLocks: RepoWriteLocks
  private readonly logger?: SupervisorLogger
  private readonly cancelSettlementTimeoutMs: number
  private readonly killProcessTreeFn: (pid: number, pgid?: number) => Promise<void>
  private readonly isProcessLiveFn: (pid: number) => boolean
  private readonly registry = new Map<string, RegistryEntry>()
  private acceptingNew = true
  private promoting = false

  constructor({ db, repoWriteLocks, logger, cancelSettlementTimeoutMs, killProcessTreeImpl, isProcessLiveImpl }: AgentExecutionSupervisorOptions) {
    this.db = db
    this.repoWriteLocks = repoWriteLocks
    this.logger = logger
    this.cancelSettlementTimeoutMs = cancelSettlementTimeoutMs ?? CANCEL_SETTLEMENT_TIMEOUT_MS
    this.killProcessTreeFn = killProcessTreeImpl ?? killProcessTree
    this.isProcessLiveFn = isProcessLiveImpl ?? defaultIsProcessLive
  }

  private taskRuns(): TaskRunStore {
    return new TaskRunStore(this.db)
  }

  private executionEvents(): ExecutionEventStore {
    return new ExecutionEventStore(this.db)
  }

  async startExecution(opts: StartExecutionOpts): Promise<ExecutionHandle> {
    if (!this.acceptingNew) throw new Error('AgentExecutionSupervisor is not accepting new executions')
    assertStartExecutionOpts(opts)

    const executionId = generateExecutionId()
    const createdAt = nowIso()
    const canRunNow = this.runningCount() < MAX_CONCURRENT_EXECUTIONS
    let hasRepoLock = false
    const requiresLock = requiresRepoWriteLock(opts.permission)
    let entry: RegistryEntry | undefined

    const initialEventType = canRunNow ? 'dispatch' : 'queue-waiting'

    let attachFailed = false
    try {
      this.tx(() => {
        this.run(
          `INSERT INTO executions (
            id, task_id, profile, permission, cwd, prompt,
            status, native_session_id, client_family, timeout_ms,
            requested_agent_runtime, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
          executionId,
          opts.taskId ?? null,
          opts.profile,
          opts.permission,
          opts.cwd,
          opts.prompt,
          opts.resume ?? null,
          opts.clientFamily ?? null,
          opts.timeoutMs ?? null,
          opts.requestedAgentRuntime ?? null,
          createdAt,
          createdAt,
        )

        if (opts.taskId) {
          const attached = this.taskRuns().attachExecution(opts.taskId, executionId, createdAt)
          if (!attached) attachFailed = true
        }

        if (requiresRepoWriteLock(opts.permission)) {
          const lock = this.repoWriteLocks.tryAcquire(opts.cwd, executionId, opts.permission, opts.writePaths)
          hasRepoLock = lock.acquired
        }

        // Repo lock conflicts wait in the FIFO queue and emit queue-waiting; lock-lost is reserved
        // for an execution that previously held a write lock and then loses it.
        this.insertEvent({
          executionId,
          taskId: opts.taskId,
          seq: 1,
          type: hasRepoLock || !requiresLock ? initialEventType : 'queue-waiting',
          data: {},
          timestamp: createdAt,
        })
      })

      if (attachFailed) {
        // The task became terminal before this execution could bind to it. Do not launch
        // Forge; synchronously terminalize the new execution as cancelled and release any
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

    if (!entry.child || !entry.pid) {
      if (claimed) this.terminalizeQueued(entry, 'cancelled', 'cancel', 'cancelled')
      return
    }

    // Request Forge termination, then block until child close and stream completion
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
      `SELECT id, task_id, profile, permission, cwd, prompt, status,
        native_session_id, client_family, pid, pgid, output, raw_result, error, exit_code,
        kill_reason, timeout_ms, requested_agent_runtime, resolved_profile
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
   * absent). Safely processless rows (queued, or pid-less starting/running) use
   * the idempotent compare-and-set terminalizer.
   */
  async markInterruptedOnStartup(): Promise<ExecutionTerminationFailure[]> {
    const timestamp = nowIso()

    // Persisted rows are the authoritative kill source for a fresh supervisor.
    const staleRows = this.query<{ id: string; task_id: string | null; pid: number | null; pgid: number | null }>(
      `SELECT id, task_id, pid, pgid
       FROM executions
       WHERE status IN ('queued', 'starting', 'running')`,
    )

    const interruptible: Array<{ id: string; taskId: string | null }> = []
    const failures: ExecutionTerminationFailure[] = []
    const failedTaskIds = new Set<string>()

    for (const row of staleRows) {
      // No recorded process to protect; the idempotent CAS terminalizer may proceed.
      if (row.pid === null || row.pid === undefined) {
        interruptible.push({ id: row.id, taskId: row.task_id })
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
        if (row.task_id) failedTaskIds.add(row.task_id)
        continue
      }
      interruptible.push({ id: row.id, taskId: row.task_id })
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
      this.taskRuns().markTerminal({
        taskRunId: task.id,
        status: 'interrupted',
        error: 'interrupted on startup',
        endedAt: timestamp,
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
    const activeEntries = [...this.registry.values()].filter((entry) => entry.child && entry.pid)
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
      if (!entry.child || !entry.pid) {
        if (this.claimTerminalIntent(entry, { kind: 'shutdown' })) {
          this.terminalizeQueued(entry, 'interrupted', 'shutdown', 'shutdown')
        }
        continue
      }
      entry.shutdownRequested = true
      this.claimTerminalIntent(entry, { kind: 'shutdown' })
      await this.requestKillOnce(entry)
    }

    await Promise.allSettled([...this.registry.values()].map((entry) => entry.waitPromise))
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
      permission: opts.permission,
      writePaths: opts.writePaths ? [...opts.writePaths] : undefined,
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
      stderrTail: '',
      resultErrorTail: '',
      sawTerminalResult: false,
      sawErrorResult: false,
      pendingClientFamily: opts.clientFamily,
    }
  }

  private async launchExecution(entry: RegistryEntry, opts: StartExecutionOpts, fromQueue: boolean): Promise<void> {
    if (entry.terminalGeneration > 0) return

    const claimed = this.run(
      `UPDATE executions
      SET status = 'starting', updated_at = ?
      WHERE id = ? AND status = 'queued'`,
      nowIso(),
      entry.executionId,
    )
    if (claimed.changes !== 1) return

    const resolvedProfile = this.readResolvedProfile(entry.executionId)

    let spawnResult: ReturnType<typeof spawnForge>
    try {
      const commandArgs = buildForgeCommand({
        profile: opts.profile,
        permission: opts.permission,
        cwd: opts.cwd,
        prompt: opts.prompt,
        resume: opts.resume,
        resolvedProfile: resolvedProfile ?? undefined,
        capabilities: opts.capabilities,
      })
      this.log('debug', `[foreman] starting forge execution ${entry.executionId}`, { args: commandArgs })
      spawnResult = spawnForge({
        profile: opts.profile,
        permission: opts.permission,
        cwd: opts.cwd,
        prompt: opts.prompt,
        resume: opts.resume,
        resolvedProfile: resolvedProfile ?? undefined,
        capabilities: opts.capabilities,
        // The authoritative task run id is always derived from `opts.taskId`, whether the
        // execution launched immediately or was reconstructed from a persisted execution row.
        env: resolveTaskAgentEnv(process.env, opts.taskId),
      })
    } catch (error) {
      this.terminalizeStartingFailure(entry, error)
      return
    }

    entry.child = spawnResult.child
    entry.pid = spawnResult.pid
    entry.pgid = spawnResult.pgid

    const timestamp = nowIso()
    this.tx(() => {
      this.run(
        `UPDATE executions
        SET status = 'running', pid = ?, pgid = ?, started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'starting'`,
        spawnResult.pid,
        spawnResult.pgid ?? null,
        timestamp,
        timestamp,
        entry.executionId,
      )
      this.insertEvent({
        executionId: entry.executionId,
        taskId: entry.taskId,
        seq: nextSeq(entry),
        type: fromQueue ? 'queue-acquired' : 'child-start',
        data: {},
        timestamp,
      })
    })

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      entry.timeoutTimer = setTimeout(() => {
        if (this.claimTerminalIntent(entry, { kind: 'timeout' })) {
          entry.timedOut = true
          void this.requestKillOnce(entry).catch((error: unknown) => {
            this.log('warn', `[foreman] Timeout kill failed for ${entry.executionId}: ${errorMessage(error)}`)
          })
        }
      }, opts.timeoutMs)
    }

    this.attachChildObservers(entry)
  }

  private attachChildObservers(entry: RegistryEntry): void {
    const child = entry.child
    if (!child) return

    if (child.stderr) {
      child.stderr.on('data', (chunk: unknown) => {
        entry.stderrTail = tailString(entry.stderrTail + chunkToString(chunk), STDERR_TAIL_MAX_LEN)
      })
    }

    child.once('error', (error) => {
      entry.childError = error.message
    })

    child.once('close', (exitCode, signal) => {
      void this.handleChildClose(entry, exitCode, signal ?? null).catch((error: unknown) => {
        this.log('error', `[foreman] close handler failed for ${entry.executionId}: ${errorMessage(error)}`)
      })
    })

    entry.streamDone = this.consumeStream(entry).catch((error: unknown) => {
      entry.streamError = errorMessage(error)
      this.log('warn', `[foreman] stream consumer failed for ${entry.executionId}: ${entry.streamError}`)
    })
  }

  private async consumeStream(entry: RegistryEntry): Promise<void> {
    if (!entry.child) return

    for await (const rawEvent of readStreamJson(entry.child)) {
      // A bounded cancellation may have terminalized and forgotten this entry
      // while the stream is stalled; late stream events must not mutate the
      // terminal state or insert post-terminal events.
      if (entry.terminalGeneration > 0) return
      const event = normalizeForgeStreamEvent(rawEvent)
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
          `${entry.resultErrorTail}${entry.resultErrorTail ? '\n' : ''}${streamErrorText}`,
          STDERR_TAIL_MAX_LEN,
        )
      }

      for (const mapped of mapStreamEventToBClass(event)) {
        if (mapped.type === 'message' && typeof mapped.data.text === 'string') {
          entry.outputParts.push(mapped.data.text)
        }

        const redacted = redactEvent(mapped.type, mapped.data)
        this.tx(() => {
          this.insertEvent({
            executionId: entry.executionId,
            taskId: entry.taskId,
            seq: nextSeq(entry),
            type: mapped.type,
            data: redacted,
          })
        })
      }
    }
  }

  private async handleChildClose(entry: RegistryEntry, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.claimTerminalIntent(entry, { kind: 'exit', exitCode, signal })
    const intent = entry.terminalIntent
    await entry.streamDone
    const status = this.determineTerminalStatus(entry, intent)
    const killReason = this.determineKillReason(entry, status, intent)
    const output = (entry.finalOutput ?? entry.outputParts.join('')).trim() || null
    const error = this.determineTerminalError(entry, status)

    this.terminalizeRunning(entry, {
      status,
      exitCode,
      signal,
      killReason,
      output,
      error,
    })
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

  private determineTerminalError(entry: RegistryEntry, status: TerminalStatus): string | null {
    if (status === 'done') return null
    if (status === 'cancelled') return 'cancelled'
    if (status === 'timeout') return 'timeout'
    const capturedError = entry.childError ?? entry.streamError ?? (entry.resultErrorTail || entry.stderrTail)
    if (!entry.sawTerminalResult && !entry.sawErrorResult) return capturedError || 'no terminal event'
    return capturedError || 'execution failed'
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
    },
  ): void {
    if (entry.terminalGeneration > 0) return

    const endedAt = nowIso()
    const eventStatus = mapEventStatus(terminal.status)
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
        committed = true

        if (terminal.status === 'done') this.persistNativeSessionIfCaptured(entry, endedAt)

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

      if (committed) {
        result = {
          executionId: entry.executionId,
          status: terminal.status,
          output: terminal.output,
          error: terminal.error,
          exitCode: terminal.exitCode,
          killReason: terminal.killReason,
        }
      } else {
        const row = this.getExecution(entry.executionId)
        if (row && isTerminalStatus(row.status)) result = resultFromRow(row)
        else terminalError = new Error(`Execution '${entry.executionId}' terminal transaction did not commit`)
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
    status: Extract<TerminalStatus, 'cancelled' | 'interrupted'>,
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
        const rows = this.query<ExecutionRecord>(
          `SELECT id, task_id, profile, permission, cwd, prompt, status,
            native_session_id, client_family, pid, pgid, output, raw_result, error, exit_code,
            kill_reason, timeout_ms, requested_agent_runtime, resolved_profile
          FROM executions
          WHERE status = 'queued'
          ORDER BY created_at ASC, id ASC`,
        )

        let promoted = false
        for (const row of rows) {
          if (this.runningCount() >= MAX_CONCURRENT_EXECUTIONS) break

          const entry = this.registry.get(row.id)
          if (!entry) continue
          if (entry.terminalGeneration > 0) continue

          if (requiresRepoWriteLock(row.permission) && !entry.hasRepoLock) {
            const lock = this.repoWriteLocks.tryAcquire(row.cwd, row.id, row.permission, entry.writePaths)
            if (!lock.acquired) continue
            entry.hasRepoLock = true
          }

          const opts = optsFromRow(row)
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

  private runningCount(): number {
    let count = 0
    for (const entry of this.registry.values()) {
      if (entry.child && entry.terminalGeneration === 0) count += 1
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
    entry.resolveWait(result)
  }

  private rejectAndForget(entry: RegistryEntry, error: unknown): void {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
    this.registry.delete(entry.executionId)
    entry.rejectWait(error)
  }

  private claimTerminalIntent(entry: RegistryEntry, intent: TerminalIntent): boolean {
    if (entry.terminalGeneration > 0 || entry.terminalIntent) return false
    entry.terminalIntent = intent
    return true
  }

  private requestKillOnce(entry: RegistryEntry): Promise<void> {
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

/**
 * Callback payload size limit for system_completion turn text.
 * Hard boundary: 16 KiB UTF-8. If the payload exceeds this, it is
 * truncated and a truncation marker is appended.
 */
const SYSTEM_COMPLETION_PAYLOAD_MAX_BYTES = 16 * 1024
const SYSTEM_COMPLETION_TRUNCATION_MARKER = '\n[truncated: payload too large]'

/**
 * DelegationResolver handles the terminal lifecycle of a delegation:
 * - Resolves pending delegations to terminal
 * - Appends a delegation_terminal agent event
 * - Enqueues exactly one bounded typed system_completion Work turn
 * - Restart reconciliation for pending bindings
 *
 * This is a stateless resolver: call it when a resource reaches terminal
 * or during startup recovery. It never polls.
 */
export function createDelegationResolver(
  eventStore: AgentEventStore,
  resourceResolver: DelegationResourceResolver,
): DelegationResolver {
  return new DelegationResolver(eventStore, resourceResolver)
}

export class DelegationResolver {
  constructor(
    private readonly eventStore: AgentEventStore,
    private readonly resourceResolver: DelegationResourceResolver,
  ) {}

  /**
   * Finalize a single delegation. Uses the new atomic event-store finalizer
   * that resolves the pending row, appends delegation_terminal event, creates
   * the system_completion turn, and advances sequences in one transaction.
   * Returns the durable callback turn when resolved, or false if the resource
   * is still active, already terminal, or not found.
   */
  resolveDelegation(address: string, delegationId: string): { turn_seq: number; event_seq: number } | false {
    const delegations = this.eventStore.getDelegations(address)
    const delegation = delegations.find(d => d.delegation_id === delegationId)
    if (!delegation) return false

    const resourceStatus = this.resourceResolver.checkResourceStatus(delegation.resource_id)
    if (resourceStatus === undefined) {
      // Resource does not exist — resolve as lost
      const result = this.eventStore.resolveDelegationWithCallback({
        address,
        delegation_id: delegationId,
        resource_id: delegation.resource_id,
        tool_name: delegation.tool_name,
        resolution: 'lost',
        completion_text: buildBoundedCompletionText(delegation, 'lost', null),
      })
      return result
    } else if (resourceStatus !== 'active') {
      const payload = this.resourceResolver.getResourcePayload?.(delegation.resource_id)
      const result = this.eventStore.resolveDelegationWithCallback({
        address,
        delegation_id: delegationId,
        resource_id: delegation.resource_id,
        tool_name: delegation.tool_name,
        resolution: 'terminal',
        completion_text: buildBoundedCompletionText(delegation, 'terminal', payload ?? null),
      })
      return result
    }

    return false
  }

  /**
   * One-time restart recovery scan. Reads all pending delegations for
   * the given address and reconciles them:
   * - Terminal resource → resolve delegation, append event, enqueue turn
   * - Active resource → stay pending (wait for authoritative signal)
   * - Missing resource → resolve as lost
   *
   * Never polls; processes each pending delegation exactly once.
   */
  reconcileOnStartup(address: string): { resolved: number; active: number; lost: number } {
    const delegations = this.eventStore.getDelegations(address)
    const pending = delegations.filter(d => d.status === 'pending')

    let resolved = 0
    let active = 0
    let lost = 0

    for (const delegation of pending) {
      const status = this.resourceResolver.checkResourceStatus(delegation.resource_id)
      if (status === 'terminal') {
        const payload = this.resourceResolver.getResourcePayload?.(delegation.resource_id)
        const result = this.eventStore.resolveDelegationWithCallback({
          address,
          delegation_id: delegation.delegation_id,
          resource_id: delegation.resource_id,
          tool_name: delegation.tool_name,
          resolution: 'terminal',
          completion_text: buildBoundedCompletionText(delegation, 'terminal', payload ?? null),
        })
        if (result !== false) resolved++
      } else if (status === undefined) {
        const result = this.eventStore.resolveDelegationWithCallback({
          address,
          delegation_id: delegation.delegation_id,
          resource_id: delegation.resource_id,
          tool_name: delegation.tool_name,
          resolution: 'lost',
          completion_text: buildBoundedCompletionText(delegation, 'lost', null),
        })
        if (result !== false) lost++
      } else {
        // Resource still active — stay pending
        active++
      }
    }

    return { resolved, active, lost }
  }

}

function buildBoundedCompletionText(
  delegation: AgentDelegationRecord,
  resolution: Exclude<DelegationResolution, 'active'>,
  payload: string | null,
): string {
  const statusText = resolution === 'terminal' ? 'completed' : 'lost'
  let text = `Delegation ${delegation.delegation_id} (${delegation.tool_name}) ${statusText}.`
  text += resolution === 'terminal'
    ? '\nThis is the terminal callback. Do not run or inspect this delegation again; answer the original request using the result below.'
    : '\nThis is the terminal callback. Do not retry automatically; explain that the delegated resource was lost.'
  if (payload) {
    text += `\n\nResult:\n${payload}`
  }

  // Bound to 16 KiB UTF-8
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= SYSTEM_COMPLETION_PAYLOAD_MAX_BYTES) return text

  const truncated = buf.subarray(0, SYSTEM_COMPLETION_PAYLOAD_MAX_BYTES - Buffer.byteLength(SYSTEM_COMPLETION_TRUNCATION_MARKER, 'utf-8'))
  return truncated.toString('utf-8') + SYSTEM_COMPLETION_TRUNCATION_MARKER
}

function resolveTaskAgentEnv(env: NodeJS.ProcessEnv, taskRunId?: string): NodeJS.ProcessEnv {
  // Copy the inherited environment so unrelated values (PATH, credentials, etc.) reach the
  // Forge child unchanged, then drop any stale inherited task context...
  const next: NodeJS.ProcessEnv = { ...env }
  delete next.FOREMAN_TASK_RUN_ID
  // ...and inject the authoritative current task run id only when one exists.
  if (taskRunId) {
    next.FOREMAN_TASK_RUN_ID = taskRunId
  }
  return next
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
        duration_ms: numberProp(event, 'duration_ms'),
        // Preserve the exact normalized three-field versioned contract so only
        // a genuine token_scope=agent_turn, duration_scope=agent_turn, and
        // tps_contract=agent_turn_v1 event can reach the telemetry gate. A
        // missing value is omitted and a wrong value is never upgraded; the
        // mapper never infers or upgrades provenance.
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

function normalizeForgeStreamEvent(event: StreamEventRecord): StreamEventRecord | undefined {
  if (!isForgeAgentStreamV1(event)) {
    return undefined
  }

  const type = stringProp(event, 'type')
  const data = recordProp(event, 'data')
  if (!type || !data) return undefined

  return dropUndefined({
    ...data,
    type,
    timestamp: stringProp(event, 'timestamp') ?? undefined,
    protocol: stringProp(event, 'protocol') ?? undefined,
    version: numberProp(event, 'version'),
    run_id: stringProp(event, 'run_id') ?? undefined,
    seq: numberProp(event, 'seq'),
  })
}

function isForgeAgentStreamV1(event: StreamEventRecord): boolean {
  return stringProp(event, 'protocol') === 'forge.agent.stream' && numberProp(event, 'version') === 1
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
  return value === 'claude' || value === 'codex' || value === 'opencode'
}

function detectResolvedProfile(event: StreamEventRecord): string | undefined {
  const type = stringProp(event, 'type')
  if (type !== 'run_started' && !(type === 'run_finished' && isForgeAgentStreamV1(event))) {
    return undefined
  }
  const profile = stringProp(event, 'profile')
  return profile ? profile.trim() : undefined
}

function extractFinalResult(event: StreamEventRecord): { isError: boolean; output?: string } | undefined {
  const type = stringProp(event, 'type')
  if (type === 'run_finished' && isForgeAgentStreamV1(event)) {
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
  if (!['readonly', 'edit', 'yolo'].includes(opts.permission)) {
    throw new Error(`Invalid execution permission '${opts.permission}'`)
  }
  if (opts.clientFamily !== undefined && !isClientFamily(opts.clientFamily)) {
    throw new Error(`Invalid client family '${opts.clientFamily}'`)
  }
  assertValidTimeoutMs(opts.timeoutMs, 'startExecution timeoutMs')
}

function optsFromRow(row: ExecutionRecord): StartExecutionOpts {
  return {
    taskId: row.task_id ?? undefined,
    profile: row.profile,
    permission: row.permission,
    cwd: row.cwd,
    prompt: row.prompt,
    resume: row.native_session_id ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    clientFamily: row.client_family ?? undefined,
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
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
