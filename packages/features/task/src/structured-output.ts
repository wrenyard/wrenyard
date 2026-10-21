import type { ZodType } from 'zod'
import { agentFailedError } from './failure.ts'
import type { MarkableFailure } from '@wrenyard/gateway'
import type { TaskResolvedDispatch } from '@wrenyard/protocol'

/**
 * Private CodeBuddy admission binding. Declared here so the task package stays
 * free of daemon operation wiring: the daemon's own binding is structurally
 * identical and satisfies this shape.
 */
export interface CodeBuddyExecutionBinding {
  readonly expectedScope: string
  readonly expectedEnvironment: string
  readonly expectedWireModel: string
}

/**
 * Output schema accepted by `collectStructuredOutput`. Task definition schemas
 * accept ZodType only.
 */
export type StructuredOutputJsonSchema = ZodType

/**
 * The upstream HTTP status and error identity a failed native client reported.
 * It is carried verbatim to the route-state port, which classifies it with the
 * gateway classifier; this layer never interprets it.
 */
export interface TaskUpstreamError {
  status?: number
  errorType?: string
  message?: string
  /** An explicitly stated reset instant, as an ISO timestamp. */
  resetsAt?: string
}

/**
 * A terminal route fault: the gateway's structured-output delivery failure
 * payload, or the upstream error a failed native execution reported.
 */
export type TaskRouteFault = MarkableFailure | TaskUpstreamError

/** The gateway's structured-output delivery failure, scoped to the exact route. */
const STRUCTURED_OUTPUT_FAILURE: MarkableFailure = {
  state: 'model_unavailable',
  scope: 'route',
  faultKind: 'structured_output',
}

export interface StructuredOutputOptions {
  profile: string
  instructions: string
  outputSchema: StructuredOutputJsonSchema
  runAgent: StructuredOutputAgent
  workingDirectory?: string
  /** Total wall-clock model-execution budget in ms for the single agent attempt. */
  runTimeLimitMs: number
  taskName?: string
  taskId?: string
  /** Repository coordination only. Defaults to true when omitted. */
  repoWriteLock?: boolean
  onDelivery?: (delivery: { summary?: string; report: string }) => void
  beforeAttempt?: () => void | Promise<void>
  features?: readonly string[]
  writePaths?: readonly string[]
  /** Original requested agent runtime, carried separately from the exact
   *  approved execution target passed as `profile`. */
  requestedAgentRuntime?: string
  /** Full per-attempt dispatch snapshot produced by the daemon resolver. */
  dispatchSnapshot?: TaskResolvedDispatch | null
  /** Private CodeBuddy admission binding, forwarded unchanged to the attempt. */
  codeBuddyExecution?: CodeBuddyExecutionBinding
  /** Optional shared-circuit accounting for this structured run. */
  onRouteSuccess?: () => void
  onRouteFault?: (fault: TaskRouteFault) => void
}

export type StructuredOutputAgentStatus = 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'

/**
 * The client-observed failure class of a CodeBuddy process that exited without
 * its terminal result record.
 */
const MISSING_TERMINAL_RESULT_FAILURE_CLASS = 'protocol_missing_terminal_result'

const RESET_TIME_PATTERNS: readonly RegExp[] = [
  /(?:resets?|resetting)\s+(?:at|after|on)\s+([^.,;，。；\n]{3,64})/iu,
  /try\s+again\s+(?:after|at)\s+([^.,;，。；\n]{3,64})/iu,
  /(?:将在|将于|预计|在)\s*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?:\s*(?:UTC|GMT)?\s*[+-][0-9]{1,2}(?::?[0-9]{2})?)?)[^\n]{0,16}?(?:重置|恢复)/u,
  /([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?:\s*(?:UTC|GMT)?\s*[+-][0-9]{1,2}(?::?[0-9]{2})?)?)\s*(?:重置|恢复)/u,
]

const RELATIVE_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

/** Normalize one captured instant or delay into an absolute ISO timestamp. */
function normalizeResetInstant(raw: string): string | undefined {
  const value = raw.trim().replace(/\s+/gu, ' ')
  const delay = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/iu.exec(value)
  if (delay !== null) {
    const unit = RELATIVE_UNIT_MS[delay[2]!.toLowerCase()]
    if (unit !== undefined) return new Date(Date.now() + Number(delay[1]) * unit).toISOString()
  }
  const normalized = value
    .replace(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u, (_match, year: string, month: string, day: string) => (
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    ))
    .replace(/^(\d{4}-\d{2}-\d{2})[ T]/u, '$1T')
    .replace(/\s*(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/iu, (_match, sign: string, hours: string, minutes?: string) => (
      `${sign}${hours.padStart(2, '0')}:${minutes ?? '00'}`
    ))
    .replace(/\s*(?:UTC|GMT)$/iu, 'Z')
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** The upstream-stated reset instant in a failure diagnostic, if any. */
export function parseResetInstant(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined || text.length === 0) return undefined
  for (const pattern of RESET_TIME_PATTERNS) {
    const match = pattern.exec(text)
    if (match?.[1] === undefined) continue
    const instant = normalizeResetInstant(match[1])
    if (instant !== undefined) return instant
  }
  return undefined
}

export interface StructuredOutputAgentOptions {
  workingDirectory?: string
  timeoutMs?: number
  resume?: string
  repoWriteLock?: boolean
  taskId?: string
  features?: readonly string[]
  writePaths?: readonly string[]
  requestedAgentRuntime?: string
  dispatchSnapshot?: TaskResolvedDispatch | null
  codeBuddyExecution?: CodeBuddyExecutionBinding
}

export interface StructuredOutputAgentResult {
  output?: string | null
  status: 'done' | 'failed' | 'cancelled'
  executionId?: string
  executionStatus?: StructuredOutputAgentStatus
  nativeSessionId?: string
  error?: string | null
  exitCode?: number | null
  killReason?: string | null
  resolvedProfile?: string
  failureClass?: string | null
  upstreamError?: TaskUpstreamError
  queueWaitMs?: number
}

export type StructuredOutputAgent = (
  profile: string,
  prompt: string,
  opts?: StructuredOutputAgentOptions,
) => Promise<StructuredOutputAgentResult>

/** Task instructions sent to the executor without an output contract prefix. */
export function firstPrompt(instructions: string, _schema?: unknown): string {
  return instructions
}

function summaryFromReport(report: string): string | undefined {
  for (const line of report.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

export async function collectStructuredOutput(opts: StructuredOutputOptions): Promise<string> {
  const totalBudgetMs = opts.runTimeLimitMs
  let lastExecutionId: string | undefined
  let lastActivity: string | undefined

  await opts.beforeAttempt?.()
  const deadlineMs = Date.now() + totalBudgetMs
  const remainingTotalMs = deadlineMs - Date.now()
  if (remainingTotalMs <= 0) {
    throw agentTimeoutError(
      lastExecutionId ?? 'unknown',
      1,
      totalBudgetMs,
      lastActivity ?? 'no model execution started after the shared task execution deadline',
    )
  }

  const attemptPrompt = firstPrompt(opts.instructions)
  const attemptTimeoutMs = Math.min(totalBudgetMs, remainingTotalMs)

  let terminal: Awaited<ReturnType<typeof runStructuredAttempt>>
  try {
    terminal = await runStructuredAttempt(
      opts.runAgent,
      opts.profile,
      attemptPrompt,
      {
        workingDirectory: opts.workingDirectory,
        timeoutMs: attemptTimeoutMs,
        repoWriteLock: opts.repoWriteLock,
        taskId: opts.taskId,
        features: opts.features,
        writePaths: opts.writePaths,
        requestedAgentRuntime: opts.requestedAgentRuntime,
        dispatchSnapshot: opts.dispatchSnapshot,
        codeBuddyExecution: opts.codeBuddyExecution,
      },
    )
  } catch (error) {
    if (error instanceof Error && lastActivity) {
      error.message = `${error.message}\n\nOutput the run produced before this failure:\n${lastActivity}`
    }
    throw error
  }

  lastExecutionId = terminal.executionId ?? lastExecutionId
  if (terminal.output) {
    lastActivity = terminal.output.slice(0, 200)
  }

  if (terminal.status === 'timeout') {
    lastActivity = terminal.output ?? 'agent execution still running at deadline'
    const captured = terminal.output?.trim()
    throw agentTimeoutError(
      terminal.executionId ?? lastExecutionId ?? 'unknown',
      1,
      attemptTimeoutMs,
      lastActivity,
      captured || undefined,
    )
  }
  if (terminal.status === 'cancelled' || terminal.status === 'interrupted') {
    throw agentStoppedError(
      terminal.status,
      terminal.executionId ?? lastExecutionId ?? 'unknown',
      terminal.error ?? terminal.output,
    )
  }
  if (terminal.status === 'failed') {
    if (terminal.failureClass === MISSING_TERMINAL_RESULT_FAILURE_CLASS) opts.onRouteFault?.(STRUCTURED_OUTPUT_FAILURE)
    if (terminal.upstreamError !== undefined) opts.onRouteFault?.(terminal.upstreamError)
    throw agentFailedError(
      terminal.executionId ?? lastExecutionId ?? 'unknown',
      terminal.error ?? terminal.output,
      terminal.failureClass,
      terminal.upstreamError,
    )
  }

  const report = terminal.output?.trim() ?? ''
  opts.onRouteSuccess?.()
  opts.onDelivery?.({ summary: summaryFromReport(report), report })
  return report
}

interface StructuredExecutionTerminal {
  executionId?: string
  status: StructuredOutputAgentStatus
  output?: string
  error?: string | null
  nativeSessionId?: string
  resolvedProfile?: string
  failureClass?: string | null
  upstreamError?: TaskUpstreamError
  queueWaitMs?: number
}

async function runStructuredAttempt(
  runAgent: StructuredOutputAgent,
  profile: string,
  prompt: string,
  agentOptions: StructuredOutputAgentOptions,
): Promise<StructuredExecutionTerminal> {
  const result = await runAgent(profile, prompt, agentOptions)
  return {
    executionId: result.executionId,
    status: result.executionStatus ?? result.status,
    output: result.output ?? undefined,
    error: result.error,
    nativeSessionId: result.nativeSessionId,
    resolvedProfile: result.resolvedProfile,
    failureClass: result.failureClass ?? null,
    upstreamError: result.upstreamError,
    queueWaitMs: result.queueWaitMs,
  }
}

function agentStoppedError(
  status: 'cancelled' | 'interrupted',
  executionId: string,
  detail?: string | null,
): Error & { failure_category: string; error_message: string } {
  return Object.assign(
    new Error(`Agent execution ${status}: ${executionId}`),
    {
      failure_category: status === 'cancelled' ? 'agent_cancelled' : 'agent_interrupted',
      error_message: JSON.stringify({
        type: status === 'cancelled' ? 'agent_cancelled' : 'agent_interrupted',
        execution_id: executionId,
        status,
        ...(detail ? { detail: detail.slice(0, 2000) } : {}),
      }),
    },
  )
}

export function agentTimeoutError(
  executionId: string,
  attemptsUsed: number,
  timeoutMs: number,
  lastActivity?: string,
  capturedOutput?: string,
): Error & { failure_category: string; error_message: string; captured_output?: string } {
  return Object.assign(
    new Error(`Agent execution timed out: ${executionId} (attempt ${attemptsUsed}, last activity: ${lastActivity ?? 'none'})`),
    {
      failure_category: 'agent_timeout' as const,
      captured_output: capturedOutput,
      error_message: JSON.stringify({
        type: 'agent_timeout',
        execution_id: executionId,
        last_known_state: 'running',
        attempts_used: attemptsUsed,
        timeout_ms: timeoutMs,
        ...(lastActivity ? { last_activity: lastActivity } : {}),
        ...(capturedOutput ? { captured_output: capturedOutput.slice(0, 4000) } : {}),
      }),
    },
  )
}

/** Report text captured on an agent timeout error, when present. */
export function taskTimeoutCapturedOutput(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const direct = (error as Record<string, unknown>).captured_output
    if (typeof direct === 'string' && direct.trim()) return direct
  }
  const payload = taskErrorMessageJson(error)
  if (payload && typeof payload.captured_output === 'string' && payload.captured_output.trim()) {
    return payload.captured_output
  }
  return undefined
}

function taskErrorMessageJson(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object' || !('error_message' in error)) return undefined
  const value = (error as Record<string, unknown>).error_message
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return undefined
}
