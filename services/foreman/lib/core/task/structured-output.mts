import type { AgentRuntimePermission } from '../operations/types.mts'
import { compileSchema, validateAgainstSchema, V2SchemaValidationError, type CompiledSchema } from '../../workspace/schema-loader.mts'
import type { ZodType } from 'zod'
import {
  STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
  assertValidTimeoutMs,
  effectiveTaskTimeoutMs,
} from '../../task-timeouts.mts'
import { GateFailureError } from './failure.mts'
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
import { parseAgentRuntime } from '../agent-runtime.mts'

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
  permission?: AgentRuntimePermission
  onDelivery?: (delivery: { summary?: string; data: unknown }) => void
  beforeAttempt?: () => void | Promise<void>
  capabilities?: readonly string[]
  writePaths?: readonly string[]
}

export type StructuredOutputAgentStatus = 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'

export interface StructuredOutputAgentOptions {
  workingDirectory?: string
  timeoutMs?: number
  resume?: string
  permission?: AgentRuntimePermission
  taskId?: string
  capabilities?: readonly string[]
  writePaths?: readonly string[]
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
}

export type StructuredOutputAgent = (
  profile: string,
  prompt: string,
  opts?: StructuredOutputAgentOptions,
) => Promise<StructuredOutputAgentResult>

export async function collectStructuredOutput(opts: StructuredOutputOptions): Promise<unknown> {
  const schema = compileSchema(opts.outputSchema)
  assertValidTimeoutMs(opts.timeoutMs, 'structured output timeoutMs')
  const timeoutMs = effectiveTaskTimeoutMs(opts.timeoutMs)
  const maxResumeAttempts = opts.maxResumeAttempts ?? 3
  let lastValidationErrors: string[] | undefined
  let lastOutputExcerpt: string | undefined
  let lastActivity: string | undefined
  let resume: string | undefined
  let lastExecutionId: string | undefined
  let resolvedProfile: string | undefined

  // ── Main attempt loop: dispatch injected agent runner, parse delivery output ──
  for (let attempt = 0; attempt <= maxResumeAttempts; attempt += 1) {
    const attemptProfile = attempt === 0
      ? opts.profile
      : assertResolvedProfileForRetry(opts.profile, resolvedProfile)
    const attemptPrompt = attempt === 0
      ? firstPrompt(opts.instructions, schema)
      : resumePrompt(attempt, schema, lastValidationErrors)
    const attemptTimeoutMs = attempt === 0 ? timeoutMs : STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS
    await opts.beforeAttempt?.()
    const terminal = await runStructuredAttempt(
      opts.runAgent,
      attemptProfile,
      attemptPrompt,
      {
        workingDirectory: opts.workingDirectory,
        timeoutMs: attemptTimeoutMs,
        resume,
        permission: opts.permission,
        taskId: opts.taskId,
        capabilities: opts.capabilities,
        writePaths: opts.writePaths,
      },
    )
    lastExecutionId = terminal.executionId ?? lastExecutionId
    resume = terminal.nativeSessionId ?? resume
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
  const gateErr = new GateFailureError('post', 'output-schema',
    'valid Foreman structured output delivery block matching schema',
    rawExcerpt
      ? [
        'raw output excerpt captured',
        ...(hasPlaceholderErrors ? ['placeholder result rejected'] : []),
        ...(validationErrors.length > 0 ? [`${validationErrors.length} structured output errors`] : []),
      ].join('; ')
      : 'no valid Foreman structured output delivery block',
    {
      evidence: {
        schema: schema.schema,
        validation_errors: validationErrors,
        raw_excerpt: rawExcerpt.slice(0, 2000),
      },
      remediation: validationErrors.length > 0
        ? `Agent must return exactly one ${DELIVERY_START} block with ${SUMMARY_START} and ${RESULT_START}; ${RESULT_START} must contain one JSON value matching the schema. Fix protocol, JSON, or schema errors and retry.`
        : `Agent must return exactly one ${DELIVERY_START} block with ${SUMMARY_START} and ${RESULT_START}; ${RESULT_START} must contain one JSON value matching the schema.`,
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
): Error & { failure_category: string; error_message: string } {
  return Object.assign(
    new Error(`Agent execution failed: ${executionId}`),
    {
      failure_category: 'agent_failed',
      error_message: JSON.stringify({
        type: 'agent_failed',
        execution_id: executionId,
        status: 'failed',
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

export function firstPrompt(instructions: string, schema: CompiledSchema): string {
  return [
    instructions,
    '',
    outputContract(schema),
  ].join('\n')
}

function outputContract(schema: CompiledSchema): string {
  return [
    '<foreman-output-contract mode="structured-xml">',
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
    `Prefer not to include prose before ${DELIVERY_START} or after ${DELIVERY_END}; Foreman extracts the first complete block and ignores surrounding prose.`,
    'If the delivery block is missing or invalid, the task will fail.',
    '',
    'Output schema:',
    JSON.stringify(schema.schema, null, 2),
    '</foreman-output-contract>',
  ].join('\n')
}

export function resumePrompt(
  attempt: number,
  schema: CompiledSchema,
  validationErrors?: string[],
): string {
  const normalizedDiagnostics = normalizeDiagnostics(validationErrors)
  const errors = normalizedDiagnostics.length > 0
    ? `\n\nErrors from your previous output:\n${formatDiagnosticsForPrompt(normalizedDiagnostics)}\n\nFix these errors and return one corrected ${DELIVERY_START} block.`
    : ''
  return [
    `Your previous turn did not return a valid Foreman structured output delivery block.`,
    `Retry ${attempt}: Return one corrected ${DELIVERY_START} block.`,
    `${RESULT_START} must contain one strict JSON value matching the output schema.`,
    `Do not include markdown fences, prose, comments, or explanations inside ${RESULT_START}.`,
    errors,
    '',
    'Output schema:',
    JSON.stringify(schema.schema, null, 2),
  ].join('\n')
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
    return `forge/${resolvedProfile}`
  }
  // If the original was not a policy, re-use it directly
  try {
    const rt = parseAgentRuntime(agentRuntime)
    if (!rt.isPolicy) {
      return agentRuntime
    }
  } catch {
    // Non-agentRuntime format; re-use directly
    return agentRuntime
  }
  // Policy-based agentRuntime with no resolved profile: fail
  throw new Error(
    `A concrete resolved profile is required for policy retry. The policy-based agentRuntime '${agentRuntime}' did not produce a resolved profile.`,
  )
}
