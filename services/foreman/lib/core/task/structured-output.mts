import { compileSchema, validateAgainstSchema, V2SchemaValidationError, type CompiledSchema } from '../../workspace/schema-loader.mts'
import type { ZodType } from 'zod'
import {
  STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
  assertValidTimeoutMs,
  effectiveTaskTimeoutMs,
} from '../../task-timeouts.mts'
import { GateFailureError, mapAgentFailureClass } from './failure.mts'
import {
  DELIVERY_END,
  DELIVERY_START,
  RESULT_END,
  RESULT_START,
  SUMMARY_END,
  SUMMARY_START,
  parseForemanTaskOutput,
  protocolDiagnostic,
  type StructuredOutputDiagnostic,
  type StructuredOutputErrorKind,
} from './delivery-protocol.mts'

/**
 * Output schema accepted by `collectStructuredOutput`. AC-5 final state:
 * task definition schemas accept ZodType only. Aliased here for the
 * structured-output call sites.
 */
export type StructuredOutputJsonSchema = ZodType

// Trivial placeholder strings that agents sometimes return as "done"
// without doing real work. Rejected outright in required string fields.
const PLACEHOLDER_STRINGS = new Set([
  'test',
  'todo',
  'placeholder',
  '...',
])

function rejectPlaceholders(data: unknown, schema: CompiledSchema): string[] {
  const errors: string[] = []
  if (typeof data !== 'object' || data === null) return errors

  const schemaObj = schema.schema
  if (typeof schemaObj !== 'object' || schemaObj === null) return errors

  const requiredValue = (schemaObj as Record<string, unknown>).required
  const required = Array.isArray(requiredValue)
    ? requiredValue.filter((field: unknown): field is string => typeof field === 'string')
    : []

  for (const field of required) {
    const value = (data as Record<string, unknown>)[field]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed === '') {
        errors.push(`required field '${field}' is empty/whitespace`)
      } else if (PLACEHOLDER_STRINGS.has(trimmed)) {
        errors.push(`required field '${field}' contains placeholder value '${trimmed}'`)
      }
    }
    // Only check string fields — booleans, numbers, objects, arrays
    // are exempt (e.g. needs_split: false is legitimate).
  }

  return errors
}

export interface StructuredOutputOptions {
  profile: string
  instructions: string
  outputSchema: StructuredOutputJsonSchema
  runAgent: StructuredOutputAgent
  workingDirectory?: string
  maxResumeAttempts?: number
  timeoutMs?: number
  taskName?: string
  taskId?: string
  /** Repository coordination only. Explicit false keeps observational tasks
   *  retryable even though production clients always launch in their
   *  unrestricted runtime mode. Defaults to true when omitted. */
  repoWriteLock?: boolean
  onDelivery?: (delivery: { summary?: string; data: unknown }) => void
  beforeAttempt?: () => void | Promise<void>
  features?: readonly string[]
  writePaths?: readonly string[]
  /** Original requested agent runtime, carried separately from the exact
   *  approved execution target passed as `profile`. */
  requestedAgentRuntime?: string
  /** Full per-attempt dispatch snapshot produced by the daemon resolver. Forwarded
   *  unchanged on the initial attempt and on every structured retry. */
  dispatchSnapshot?: import('../../task-run-metadata-types.mts').TaskResolvedDispatch | null
  /** Private CodeBuddy admission binding, forwarded unchanged to every attempt. */
  codeBuddyExecution?: import('../operations/types.mts').CodeBuddyExecutionBinding
}

export type StructuredOutputAgentStatus = 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'

export interface StructuredOutputAgentOptions {
  workingDirectory?: string
  timeoutMs?: number
  resume?: string
  repoWriteLock?: boolean
  taskId?: string
  features?: readonly string[]
  writePaths?: readonly string[]
  /** Original requested agent runtime, carried separately from the exact approved execution target passed as `profile`. */
  requestedAgentRuntime?: string
  /** Full per-attempt dispatch snapshot produced by the daemon resolver. Forwarded unchanged on every structured retry. */
  dispatchSnapshot?: import('../../task-run-metadata-types.mts').TaskResolvedDispatch | null
  /** Private CodeBuddy admission binding, unchanged across retries/resume. */
  codeBuddyExecution?: import('../operations/types.mts').CodeBuddyExecutionBinding
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
  /** Canonical agent-runtime failure class captured from `run_finished`, if present. */
  failureClass?: string | null
}

export type StructuredOutputAgent = (
  profile: string,
  prompt: string,
  opts?: StructuredOutputAgentOptions,
) => Promise<StructuredOutputAgentResult>

export async function collectStructuredOutput(opts: StructuredOutputOptions): Promise<unknown> {
  const schema = compileSchema(opts.outputSchema)
  assertValidTimeoutMs(opts.timeoutMs, 'structured output timeoutMs')
  const totalBudgetMs = effectiveTaskTimeoutMs(opts.timeoutMs)
  // ── Mutation-aware evidence only ──
  // Task coordination metadata, not the runtime mode, decides whether an
  // attempt may have changed repository state. It no longer gates retries:
  // every task — including edit/commit — gets the same bounded in-session
  // output correction. The marker is only used to attach unverified-side-effect
  // evidence when every attempt is exhausted. An omitted repoWriteLock keeps
  // the conservative default (mutation-capable).
  const mutationCapable =
    (opts.repoWriteLock ?? true) ||
    (opts.features?.length ?? 0) > 0
  // Default remains three corrections after the initial attempt.
  const maxResumeAttempts = opts.maxResumeAttempts ?? 3
  let lastValidationErrors: string[] | undefined
  let lastOutputExcerpt: string | undefined
  let lastActivity: string | undefined
  let resume: string | undefined
  let lastExecutionId: string | undefined
  let resolvedProfile: string | undefined

  // ── Main attempt loop: dispatch injected agent runner, parse delivery output ──
  //
  // timeoutMs is one total model-execution budget shared by the initial attempt
  // and every structured correction attempt: the single deadline is fixed here
  // when collection begins (queue/admission/pre-gates run before this function
  // and never consume it), and it is never renewed. Before each attempt the
  // dispatched timeout is min(attempt cap, positive remaining total) — the
  // initial cap is the total budget, the correction cap stays
  // STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS. An expired budget throws the existing
  // agent-timeout classification without starting another agent.
  const deadlineMs = Date.now() + totalBudgetMs
  for (let attempt = 0; attempt <= maxResumeAttempts; attempt += 1) {
    await opts.beforeAttempt?.()
    const remainingTotalMs = deadlineMs - Date.now()
    if (remainingTotalMs <= 0) {
      throw agentTimeoutError(
        lastExecutionId ?? 'unknown',
        attempt,
        totalBudgetMs,
        lastActivity ?? 'no model execution started after the shared task execution deadline',
      )
    }
    // A correction is only ever a continuation of the original native session,
    // on the same resolved model/profile. Without a concrete resumable session
    // there is nothing safe to correct: fail with a precise diagnostic instead
    // of replaying the original task as a fresh run. The session check runs
    // before profile resolution so the missing-session diagnostic is always the
    // one reported.
    if (attempt > 0 && !resume) {
      throw new Error(
        `Cannot correct invalid structured output (attempt ${attempt + 1}): the previous turn returned no resumable native session id. ` +
          'A correction continues the original native session only; replaying the original task as a fresh run is refused. ' +
          `Previous diagnostics: ${describeCorrectionErrors(lastValidationErrors)}`,
      )
    }
    const attemptProfile = attempt === 0
      ? opts.profile
      : assertResolvedProfileForRetry(opts.profile, resolvedProfile)
    const attemptPrompt = attempt === 0
      ? firstPrompt(opts.instructions, schema)
      : resumePrompt(attempt, schema, lastValidationErrors)
    const attemptCapMs = attempt === 0 ? totalBudgetMs : STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS
    const attemptTimeoutMs = Math.min(attemptCapMs, remainingTotalMs)
    const terminal = await runStructuredAttempt(
        opts.runAgent,
        attemptProfile,
        attemptPrompt,
        {
          workingDirectory: opts.workingDirectory,
          timeoutMs: attemptTimeoutMs,
          resume,
          repoWriteLock: opts.repoWriteLock,
          taskId: opts.taskId,
          features: opts.features,
          writePaths: opts.writePaths,
          requestedAgentRuntime: opts.requestedAgentRuntime,
          dispatchSnapshot: opts.dispatchSnapshot,
          codeBuddyExecution: opts.codeBuddyExecution,
        },
      )
    lastExecutionId = terminal.executionId ?? lastExecutionId
    resume = terminal.nativeSessionId?.trim() || resume
    if (terminal.resolvedProfile) {
      resolvedProfile = terminal.resolvedProfile
    }

    // Timeout/wait/cancellation mechanics belong to the injected agent runtime.
    // Task logic only classifies the terminal agent result it receives.
    if (terminal.status === 'timeout') {
      lastActivity = terminal.output ?? 'agent execution still running at deadline'
      throw agentTimeoutError(terminal.executionId ?? lastExecutionId ?? 'unknown', attempt + 1, attemptTimeoutMs, lastActivity)
    }
    if (terminal.status === 'cancelled' || terminal.status === 'interrupted') {
      throw agentStoppedError(
        terminal.status,
        terminal.executionId ?? lastExecutionId ?? 'unknown',
        terminal.error ?? terminal.output,
      )
    }
    // A runtime failure is not invalid structured output: surface the agent
    // error immediately instead of entering a structured-output retry, which
    // would otherwise demand a concrete resolved profile that a failed policy
    // execution never produced.
    if (terminal.status === 'failed') {
      throw agentFailedError(
        terminal.executionId ?? lastExecutionId ?? 'unknown',
        terminal.error ?? terminal.output,
        terminal.failureClass,
      )
    }

    const parsed = parseStructuredFinalOutput(terminal.output, schema)
    if (parsed.success) {
      opts.onDelivery?.({ summary: parsed.summary, data: parsed.data })
      return parsed.data
    }

    lastValidationErrors = parsed.validationErrors
    const sessionOutput = terminal.output
    if (sessionOutput) {
      lastActivity = sessionOutput.slice(0, 200)
      if (!lastOutputExcerpt) {
        lastOutputExcerpt = sessionOutput.slice(0, 2000)
      }
    }
  }

  // All attempts exhausted without valid output.
  const validationErrors = lastValidationErrors ?? []
  const rawExcerpt = lastOutputExcerpt ?? ''
  const hasPlaceholderErrors = validationErrors.some((e) => e.includes('placeholder'))

  // When a mutation-capable run does not return valid structured output, the
  // outcome is unverifiable: a prior attempt may already have changed task
  // targets, so we must not infer success from a clean tree or a stable HEAD.
  // We surface machine-readable evidence so downstream callers (and humans) know
  // the action is unverified and side effects may have occurred, and we add a
  // remediation that forbids automatic retry.
  const unverifiedEvidence: Record<string, unknown> = mutationCapable
    ? { outcome_unverified: true, side_effects_may_have_occurred: true }
    : {}
  const remediationBase = validationErrors.length > 0
    ? `Agent must return exactly one ${DELIVERY_START} block with ${SUMMARY_START} and ${RESULT_START}; ${RESULT_START} must contain one JSON value matching the schema. Fix protocol, JSON, or schema errors and retry.`
    : `Agent must return exactly one ${DELIVERY_START} block with ${SUMMARY_START} and ${RESULT_START}; ${RESULT_START} must contain one JSON value matching the schema.`
  const remediation = mutationCapable
    ? `${remediationBase} Every automatic in-session output correction was attempted and exhausted. The action outcome is UNVERIFIED and side effects may have occurred: inspect the exact task targets and the captured evidence before any explicit task replay, and never auto-replay. Do not infer success from a clean working tree or a stable HEAD.`
    : remediationBase

  const gateErr = new GateFailureError('post', 'output-schema',
    'valid Foreman structured output delivery block matching schema',
    rawExcerpt
      ? [
        'raw output excerpt captured',
        ...(hasPlaceholderErrors ? ['placeholder result rejected'] : []),
        ...(validationErrors.length > 0 ? [`${validationErrors.length} structured output errors`] : []),
        ...(mutationCapable ? ['mutation-capable run exhausted in-session output corrections'] : []),
      ].join('; ')
      : 'no valid Foreman structured output delivery block',
    {
      evidence: {
        schema: schema.schema,
        validation_errors: validationErrors,
        raw_excerpt: rawExcerpt.slice(0, 2000),
        ...unverifiedEvidence,
      },
      remediation,
      retryable: false,
    },
  )
  throw gateErr
}

interface StructuredExecutionTerminal {
  executionId?: string
  status: StructuredOutputAgentStatus
  output?: string
  error?: string | null
  nativeSessionId?: string
  resolvedProfile?: string
  failureClass?: string | null
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

function agentFailedError(
  executionId: string,
  detail?: string | null,
  failureClass?: string | null,
): Error & { failure_category: string; error_message: string } {
  // Map a canonical agent-runtime FailureClass onto a stable task failure
  // category so a capacity/policy exhaustion is reported as
  // runtime_status/transport rather than collapsed into the generic
  // agent_failed bucket. Missing/unknown class defaults to agent_failed.
  const category = mapAgentFailureClass(failureClass) ?? 'agent_failed'
  return Object.assign(
    new Error(`Agent execution failed: ${executionId}`),
    {
      failure_category: category,
      error_message: JSON.stringify({
        type: category,
        execution_id: executionId,
        status: 'failed',
        ...(failureClass ? { agent_failure_class: failureClass } : {}),
        ...(detail ? { detail: detail.slice(0, 2000) } : {}),
      }),
    },
  )
}

function agentTimeoutError(
  executionId: string,
  attemptsUsed: number,
  timeoutMs: number,
  lastActivity?: string,
): Error & { failure_category: string; error_message: string } {
  return Object.assign(
    new Error(`Agent execution timed out: ${executionId} (attempt ${attemptsUsed}, last activity: ${lastActivity ?? 'none'})`),
    {
      failure_category: 'agent_timeout' as const,
      error_message: JSON.stringify({
        type: 'agent_timeout',
        execution_id: executionId,
        last_known_state: 'running',
        attempts_used: attemptsUsed,
        timeout_ms: timeoutMs,
        ...(lastActivity ? { last_activity: lastActivity } : {}),
      }),
    },
  )
}

type ParsedStructuredOutput =
  | { success: true; data: unknown; summary?: string }
  | { success: false; diagnostics: StructuredOutputDiagnostic[]; validationErrors: string[] }

function parseStructuredFinalOutput(output: string | null | undefined, schema: CompiledSchema): ParsedStructuredOutput {
  const text = output?.trim()
  if (!text) return failWithDiagnostics([{ kind: 'json', message: 'final output is empty' }])

  const delivery = parseForemanTaskOutput(text)
  if (delivery.present) {
    if (!delivery.success) return failWithDiagnostics(delivery.diagnostics)
    const parsed = parseResultJson(delivery.result, schema, '<result>')
    if (!parsed.success) return parsed
    return {
      ...parsed,
      summary: delivery.summary || summaryFromStructuredData(parsed.data),
    }
  }

  return failWithDiagnostics([protocolDiagnostic(`missing exact ${DELIVERY_START} start tag`)])
}

function parseResultJson(rawJson: string, schema: CompiledSchema, subject: string): ParsedStructuredOutput {
  const text = rawJson.trim()
  if (!text) return failWithDiagnostics([{ kind: 'json', message: `${subject} JSON is empty` }])

  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch (error) {
    return failWithDiagnostics([{ kind: 'json', message: `${subject} is not valid JSON: ${errorMessage(error)}` }])
  }

  const diagnostics: StructuredOutputDiagnostic[] = []

  try {
    validateAgainstSchema(schema, data, subject === '<result>' ? '<result> JSON' : 'structured final output')
  } catch (error) {
    if (error instanceof V2SchemaValidationError) {
      const details = error.details.length > 0 ? error.details : [error.message]
      diagnostics.push(...details.map((detail) => ({
        kind: 'schema' as const,
        message: `${subject} schema validation failed: ${detail}`,
      })))
    } else {
      throw error
    }
  }

  const placeholderErrors = rejectPlaceholders(data, schema)
  if (placeholderErrors.length > 0) {
    diagnostics.push(...placeholderErrors.map((message) => ({ kind: 'schema' as const, message })))
  }

  if (diagnostics.length > 0) return failWithDiagnostics(diagnostics)

  return { success: true, data }
}

function summaryFromStructuredData(data: unknown): string | undefined {
  if (!isJsonObject(data)) return undefined
  const summary = data.summary
  return typeof summary === 'string' && summary.trim() ? summary.trim() : undefined
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failWithDiagnostics(diagnostics: StructuredOutputDiagnostic[]): ParsedStructuredOutput {
  return {
    success: false,
    diagnostics,
    validationErrors: diagnostics.map(formatDiagnostic),
  }
}

function formatDiagnostic(diagnostic: StructuredOutputDiagnostic): string {
  return `${diagnostic.kind} error: ${diagnostic.message}`
}

// ── Prompt helpers ──

/**
 * Stable output contract and schema first, then the task instruction body.
 * The contract is byte-identical for the same output schema, so it leads the prompt and the
 * per-run task instructions follow it.
 */
export function firstPrompt(instructions: string, schema: CompiledSchema): string {
  return [
    outputContract(schema),
    '',
    instructions,
  ].join('\n')
}

function outputContract(schema: CompiledSchema): string {
  return [
    '<wy-system>',
    '<wy-instruction mode="structured-xml">',
    'IMPORTANT: Return one Foreman structured output block as your final response:',
    DELIVERY_START,
    SUMMARY_START,
    'Short human-readable summary.',
    SUMMARY_END,
    RESULT_START,
    '{ ... }',
    RESULT_END,
    DELIVERY_END,
    '',
    `The XML wrapper is only the delivery boundary. The JSON value inside ${RESULT_START} is validated and persisted as the task output.`,
    `Foreman also records the ${SUMMARY_START} text as the task summary; if the output schema has a summary field, keep it consistent with ${SUMMARY_START}.`,
    `The ${RESULT_START} content must be one strict JSON value matching the output schema below.`,
    `Do not include markdown fences, prose, comments, or explanations inside ${RESULT_START}.`,
    'Escape literal newline, tab, and other control characters inside JSON strings (`\\n`, `\\t`, `\\u0000`); never emit a raw control character inside a JSON string.',
    `Prefer not to include prose before ${DELIVERY_START} or after ${DELIVERY_END}; Foreman extracts the first complete block and ignores surrounding prose.`,
    'If the delivery block is missing or invalid, the task will fail.',
    '',
    'Output schema:',
    JSON.stringify(schema.schema, null, 2),
    '</wy-instruction>',
    '</wy-system>',
  ].join('\n')
}

/**
 * Correction-only continuation of the original native session.
 *
 * Stable `wy-system`/`wy-instruction` (correction rules + schema) come first,
 * then the per-attempt `wy-ctx-error` diagnostics, with the `wy-sysinfo`
 * attempt counter last.
 */
export function resumePrompt(
  attempt: number,
  schema: CompiledSchema,
  validationErrors?: string[],
): string {
  const normalizedDiagnostics = normalizeDiagnostics(validationErrors)
  return [
    '<wy-system>',
    [
      '<wy-instruction>',
      '## Output Correction Only',
      `Your previous final output did not produce a valid Foreman ${DELIVERY_START} structured delivery block.`,
      'This is a correction of that final output only.',
      'Do NOT use any tools or actions, do not repeat, redo, or continue the original task, and do not change any files, repository, or external state.',
      `Only fix the previous final output so it becomes one valid ${DELIVERY_START} block.`,
      `The corrected block must contain ${SUMMARY_START} and ${RESULT_START}, and ${RESULT_START} must hold one strict JSON value matching the output schema below.`,
      `Do not include markdown fences, prose, comments, or explanations inside ${RESULT_START}.`,
      'Escape literal newline, tab, and other control characters inside JSON strings (`\\n`, `\\t`, `\\u0000`); never emit a raw control character inside a JSON string.',
      '',
      'Output schema:',
      JSON.stringify(schema.schema, null, 2),
      '</wy-instruction>',
    ].join('\n'),
    renderCorrectionDiagnostics(normalizedDiagnostics),
    `<wy-sysinfo attempt="${attempt}"/>`,
    '</wy-system>',
  ].join('\n')
}

function renderCorrectionDiagnostics(diagnostics: StructuredOutputDiagnostic[]): string {
  const body = diagnostics.length > 0
    ? formatDiagnosticsForPrompt(diagnostics)
    : 'No structured diagnostics were captured for the previous output.'
  return [
    '<wy-ctx-error>',
    body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    '</wy-ctx-error>',
  ].join('\n')
}

/** Compact, single-line rendering of the last correction errors for a failure message. */
function describeCorrectionErrors(validationErrors: string[] | undefined): string {
  const normalized = normalizeDiagnostics(validationErrors)
  return normalized.length > 0
    ? normalized.map((diagnostic) => `${diagnostic.kind}: ${diagnostic.message}`).join('; ')
    : 'none captured'
}

function normalizeDiagnostics(diagnostics: string[] | undefined): StructuredOutputDiagnostic[] {
  if (!diagnostics || diagnostics.length === 0) return []
  return diagnostics.map((diagnostic) => {
    const match = diagnostic.match(/^(protocol|json|schema) error:\s*(.*)$/iu)
    if (match) {
      return {
        kind: match[1].toLowerCase() as StructuredOutputErrorKind,
        message: match[2],
      }
    }
    return { kind: 'schema', message: diagnostic }
  })
}

function formatDiagnosticsForPrompt(diagnostics: StructuredOutputDiagnostic[]): string {
  const sections: Array<[StructuredOutputErrorKind, string]> = [
    ['protocol', 'Protocol errors'],
    ['json', 'JSON errors'],
    ['schema', 'Schema errors'],
  ]
  const lines: string[] = []
  for (const [kind, label] of sections) {
    const messages = diagnostics.filter((diagnostic) => diagnostic.kind === kind)
    if (messages.length === 0) continue
    lines.push(`${label}:`)
    lines.push(...messages.map((diagnostic) => `  - ${diagnostic.message}`))
  }
  return lines.join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertResolvedProfileForRetry(agentRuntime: string, resolvedProfile: string | undefined): string {
  if (resolvedProfile) {
    // The resolved profile is the canonical exact execution target
    // (provider/model:client) captured by the supervisor from the terminal
    // stream event. It is reused verbatim as the retry profile; it is never
    // wrapped or reinterpreted as a legacy runtime identity.
    return resolvedProfile
  }
  return agentRuntime
}
