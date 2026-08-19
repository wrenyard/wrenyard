import { randomBytes } from 'node:crypto'
import { getDb } from '../../db/connection.mts'
import { ExecutionEventStore } from '../../db/stores/execution-event-store.mts'
import {
  TaskRunStore,
  type TaskRunStoreStatus,
} from '../../db/stores/task-run-store.mts'
import { executeShell as defaultShell } from '../../adapters/shell/execute.mts'
import { runForgeLlm as defaultLlm } from '../../adapters/forge/llm-client.mts'
import { createPrimitiveSet } from '../../core/operations/primitives/registry.mts'
import { appendForemanEvent } from '../../events/event-store.mts'
import type { ForemanEvent } from '../../events/event-types.mts'
import type {
  AgentResult,
  ExecutionOptions,
  GateFail,
  GateContext as GateContextType,
  PrimitiveSet,
  TaskDefinition,
  TaskExecutionResult,
  TaskGate,
} from '../../types.mts'
import type { ZodType } from 'zod'
import {
  ensureDiscovered,
  resolveTaskTarget,
} from '../../workspace/task-loader.mts'
import { parseAgentRuntime } from '../../core/agent-runtime.mts'
import { applyTaskAgentRuntimeOverride } from '../../config/task-runtime-override.mts'
import { installRuntimeGlobals } from './runtime-globals.mts'
import {
  compileSchema,
  normalizeSchema,
  V2SchemaValidationError,
  validateAgainstSchema,
} from '../../workspace/schema-loader.mts'
import { collectStructuredOutput, type StructuredOutputAgent } from '../../core/task/structured-output.mts'
import { resolveCapabilities } from '../../core/task/capabilities.mts'
import { buildTaskPrompt } from '../../core/task/prompt.mts'
import { splitTaskInputContext } from '../../core/task/context.mts'
import { resolveTaskWritePaths } from '../../core/task/write-targets.mts'
import {
  extractGateFailure,
  GateFailureError,
  isGateError,
  type GateFailurePayload,
} from '../../core/task/failure.mts'

type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

interface TaskRecord {
  [extra: string]: any
  task_id: string
  name: string
  project: string
  source?: 'builtin' | 'project'
  status: TaskStatus
  output: unknown
  summary?: string | null
  structured: boolean
  error: string | null
  failure_category?: string
  suggestion?: string
  error_message?: string
  error_type?: string
  validation_schema?: unknown
  validation_errors?: string[]
  agentResult?: AgentResult
  startedAt: string
  finishedAt?: string
  connectingId?: string
}

export {
  extractGateFailure,
  GateFailureError,
  isGateError,
  type GateFailurePayload,
}

async function runGates(
  gates: TaskGate[],
  gateCtx: GateContextType,
  phase: 'pre' | 'post',
): Promise<void> {
  for (const gate of gates) {
    let lastFail: GateFail | undefined
    const maxAttempts = gate.retry?.maxAttempts ?? 1
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const result = await gate.run(gateCtx)
      if (result.ok) {
        lastFail = undefined
        break // gate passed
      }
      lastFail = result
    }
    if (lastFail) {
      throw new GateFailureError(phase, gate.id, lastFail.expected, lastFail.actual, {
        evidence: lastFail.evidence,
        remediation: lastFail.remediation,
        retryable: lastFail.retryable,
      })
    }
  }
}

// ── SQLite state persistence ──────────────────────────────────────────────

function ensureExecutionDb(): void {
  try {
    getDb()
  } catch (error) {
    if (isDbUnavailable(error)) {
      throw new Error(
        'Daemon execution DB has not been initialized. Task execution must run inside Foreman service bootstrap, or tests must initialize/inject the DB explicitly before calling daemon execution APIs.',
        { cause: error },
      )
    }
    throw error
  }
}

function isDbUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Foreman DB has not been initialized')
}

function taskRuns(): TaskRunStore {
  ensureExecutionDb()
  return new TaskRunStore(getDb())
}

function executionEvents(): ExecutionEventStore {
  ensureExecutionDb()
  return new ExecutionEventStore(getDb())
}

function taskSummaryFromOutput(output: unknown): string | undefined {
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const summary = (output as Record<string, unknown>).summary
    return typeof summary === 'string' && summary.trim() ? summary.trim() : undefined
  }
  if (typeof output !== 'string') return undefined
  const trimmed = output.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return taskSummaryFromOutput(JSON.parse(trimmed) as unknown)
  } catch {
    return undefined
  }
}

function upsertRunningTaskRow(
  record: TaskRecord,
  target: { name: string; source?: 'builtin' | 'project' },
  input: unknown,
  structured: boolean,
  options: ExecutionOptions,
): 'cancelled' | 'interrupted' | null {
  return taskRuns().markRunning({
    taskRunId: record.task_id,
    template: target.name,
    project: record.project || null,
    worktree: options.worktreeId ?? null,
    input,
    workflowId: options.workflowId ?? null,
    structured,
    startedAt: record.startedAt,
    updatedAt: new Date().toISOString(),
    resumeInterruptedTask: Boolean(options.resumeInterruptedTask),
    definitionSource: target.source ?? null,
  })
}

function updateTaskRowTerminal(
  taskId: string,
  status: TaskStatus,
  output: unknown,
  summary: string | null | undefined,
  error: string | null | undefined,
  endedAt = new Date().toISOString(),
  failureCategory?: string,
  suggestion?: string,
  errorMessage?: string,
): boolean {
  if (status === 'running') throw new Error('running task status is not terminal')
  return taskRuns().markTerminal({
    taskRunId: taskId,
    status,
    output,
    summary,
    error,
    endedAt,
    failureCategory,
    suggestion,
    errorMessage,
  })
}

function readTaskStatus(taskId: string): TaskStatus | null {
  const status = taskRuns().readStatus(taskId) as TaskRunStoreStatus | null
  switch (status) {
    case 'running':
    case 'done':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return status
    default:
      return null
  }
}

function taskResultStatus(status: TaskStatus): TaskExecutionResult['status'] {
  if (status === 'running') {
    throw new Error('Task execution returned before reaching a terminal status')
  }
  return status
}

function assertTaskStillActive(taskId: string): void {
  const status = readTaskStatus(taskId)
  if (status !== 'cancelled' && status !== 'interrupted') return
  throw Object.assign(
    new Error(`Task run '${taskId}' is ${status}`),
    {
      failure_category: status === 'cancelled' ? 'task_cancelled' : 'task_interrupted',
      error_message: JSON.stringify({
        type: status === 'cancelled' ? 'task_cancelled' : 'task_interrupted',
        task_run_id: taskId,
        status,
      }),
    },
  )
}

function insertTaskLifecycleEvent(
  record: TaskRecord,
  kind: 'task.started' | 'task.done' | 'task.failed',
): void {
  executionEvents().insertTaskLifecycle({
    taskRunId: record.task_id,
    kind,
    taskName: record.name,
    project: record.project,
    status: record.status,
    summary: record.summary,
    output: record.output,
    error: record.error,
    failureCategory: record.failure_category,
    suggestion: record.suggestion,
    errorMessage: record.error_message,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    timestamp: new Date().toISOString(),
  })
}

function gateShellFn(cwd: string): GateContextType['shell'] {
  return (cmd, args) => {
    const fullCmd = args?.length ? [cmd, ...args].join(' ') : cmd
    return defaultShell(fullCmd, { cwd })
  }
}

// ── Daemon fact events ─────────────────────────────────────────────────────

async function recordTaskRunEvent(
  record: TaskRecord,
  kind: 'task.run.started' | 'task.run.completed' | 'task.run.failed',
  options: ExecutionOptions,
): Promise<void> {
  const suffix = kind === 'task.run.started' ? 'started'
    : kind === 'task.run.completed' ? 'done'
    : 'failed'
  await recordDaemonExecutionEvent({
    id: `foreman:${record.task_id}:${suffix}`,
    kind,
    severity: kind === 'task.run.failed' ? 'error' : kind === 'task.run.completed' ? 'success' : 'info',
    refs: { taskId: record.task_id, project: record.project, connectionId: options.connectingId },
    occurredAt: new Date().toISOString(),
    data: {
      taskName: record.name,
      status: record.status,
      output: record.output,
      summary: record.summary,
      error: record.error,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    },
  })
}

async function recordProgressEvent(
  detail: string,
  refs: { taskId: string; project: string },
  options: ExecutionOptions,
): Promise<void> {
  await recordDaemonExecutionEvent({
    id: `foreman:${refs.taskId}:progress_${randomBytes(4).toString('hex')}`,
    kind: 'task.run.progress',
    severity: 'info',
    refs: { ...refs, connectionId: options.connectingId },
    occurredAt: new Date().toISOString(),
    data: { detail },
  })
}

async function recordDaemonExecutionEvent(event: Omit<ForemanEvent, 'source'>): Promise<void> {
  await appendForemanEvent({
    source: 'daemon.execution.runner',
    ...event,
  })
}

export async function runTaskOutputInDaemon(name: string, input: unknown, opts: ExecutionOptions | string): Promise<unknown> {
  const result = await executeTaskInDaemon(name, input, normalizeExecutionOptions(opts))
  return result.output
}

export async function executeTaskInDaemon(name: string, input: unknown, opts: ExecutionOptions | string): Promise<TaskExecutionResult> {
  const options = normalizeExecutionOptions(opts)
  const taskInputContext = splitTaskInputContext(input, options.taskContext)
  const taskId = options.taskId ?? createKernelTaskRunId()
  const record: TaskRecord = {
    task_id: taskId,
    name,
    project: options.currentProject ?? '',
    status: 'running',
    output: '',
    structured: true,
    error: null,
    startedAt: new Date().toISOString(),
    connectingId: options.connectingId,
  }
  let restore = (): void => {}
  let config: import('../../types.mts').TaskConfig | undefined
  let taskRowPersisted = false
  try {
    await ensureDiscovered(options.workspaceRoot)
    const target = resolveTaskTarget(name, options.workspaceRoot, options.currentProject)
    if (!target) throw new Error(`Task not found: ${name}`)
    record.name = target.name
    record.source = target.source
    if (!record.project) record.project = target.project ?? ''

    const definition = target.definition as TaskDefinition
    config = definition.config
    const taskProfile = config.profile
    const declaredAgentRuntime = config.agentRuntime
      ? parseAgentRuntime(config.agentRuntime).toString()
      : `forge/${taskProfile}`
    const requestedAgentRuntime = applyTaskAgentRuntimeOverride(target.name, declaredAgentRuntime)
    parseAgentRuntime(requestedAgentRuntime)
    const executionOptions = options
    const effectiveInput = validateInput(config.input, taskInputContext.input, `Invalid input for task '${target.name}'`)
    // Resolve selected capabilities from config before spawning Forge.
    // Invalid selections surface as deterministic task execution errors.
    const selectedCapabilities = resolveCapabilities(config.capabilities, effectiveInput)
    const writePaths = resolveTaskWritePaths(
      config,
      effectiveInput,
      executionOptions.workingDirectory ?? process.cwd(),
    )
    // AC-5 final state: definition output schemas are ZodType only. Pass the
    // original ZodType to collectStructuredOutput, which converts to draft-07
    // JSON Schema internally for validation. `normalizeSchema`/JSON conversion
    // is reserved for any public/persisted JSON metadata, not for the runtime
    // collection path.
    const outputSchema = config.output
    if (!outputSchema) {
      throw new Error(`Task '${target.name}' must declare an output schema`)
    }
    record.structured = true
    const terminalStatus = upsertRunningTaskRow(record, target, effectiveInput, record.structured, executionOptions)
    taskRowPersisted = true
    if (terminalStatus) {
      record.status = terminalStatus
      return {
        task_id: taskId,
        name: target.name,
        project: record.project,
        status: terminalStatus,
        output: null,
        summary: null,
        structured: true,
        agentRuntime: requestedAgentRuntime,
      }
    }
    insertTaskLifecycleEvent(record, 'task.started')
    await recordTaskRunEvent(record, 'task.run.started', executionOptions)
    const primitives = mergePrimitives(executionOptions.primitives)
    restore = installRuntimeGlobals({
      primitives,
    })

    // ── Pre-gates ──
    assertTaskStillActive(taskId)
    const gateState: Record<string, unknown> = {}
    const preGates = definition.config.gates?.pre
    if (preGates && preGates.length > 0) {
      const workDir = executionOptions.workingDirectory ?? process.cwd()
      await runGates(preGates, {
        task: { name: target.name, sourcePath: target.sourcePath },
        input: effectiveInput,
        workDir,
        workspaceRoot: executionOptions.workspaceRoot,
        project: record.project,
        taskId,
        state: gateState,
        shell: gateShellFn(workDir),
      }, 'pre')
      await recordProgressEvent(`Pre-gates passed for ${target.name}`, { taskId, project: record.project }, options)
    }

    const prompt = await buildTaskPrompt(definition, effectiveInput, taskInputContext.ctx)
    assertTaskStillActive(taskId)
    let structuredSummary: string | undefined

    try {
      const runAgent: StructuredOutputAgent = (profile, prompt, opts) => {
        return primitives.agent(profile, prompt, {
          ...opts,
          permission: opts?.permission ?? 'edit',
          writePaths: opts?.writePaths,
        })
      }
      const structuredOptions: Parameters<typeof collectStructuredOutput>[0] = {
        profile: requestedAgentRuntime,
        instructions: prompt,
        outputSchema,
        runAgent,
        workingDirectory: executionOptions.workingDirectory,
        taskName: target.name,
        taskId,
        permission: definition.config.permission,
        timeoutMs: config.timeoutMs,
        capabilities: selectedCapabilities,
        writePaths,
        onDelivery: (delivery) => {
          structuredSummary = delivery.summary
        },
        beforeAttempt: () => assertTaskStillActive(taskId),
      }
      const output = await collectStructuredOutput(structuredOptions)
      assertTaskStillActive(taskId)

      // ── Post-gates ──
      const postGates = definition.config.gates?.post
      if (postGates && postGates.length > 0) {
        const workDir = executionOptions.workingDirectory ?? process.cwd()
        await runGates(postGates, {
          task: { name: target.name, sourcePath: target.sourcePath },
          input: effectiveInput,
          output,
          workDir,
          workspaceRoot: executionOptions.workspaceRoot,
          project: record.project,
          taskId,
          state: gateState,
          shell: gateShellFn(workDir),
        }, 'post')
        assertTaskStillActive(taskId)
        await recordProgressEvent(`Post-gates passed for ${target.name}`, { taskId, project: record.project }, options)
      }

      assertTaskStillActive(taskId)
      record.status = 'done'
      record.output = output
      record.summary = structuredSummary ?? taskSummaryFromOutput(output) ?? null
      record.finishedAt = new Date().toISOString()
      const terminalUpdated = updateTaskRowTerminal(taskId, 'done', output, record.summary, null, record.finishedAt)
      if (terminalUpdated) {
        insertTaskLifecycleEvent(record, 'task.done')
        await recordTaskRunEvent(record, 'task.run.completed', executionOptions)
      } else {
        record.status = readTaskStatus(taskId) ?? record.status
      }
    } catch (error) {
      record.status = 'failed'
      record.error = errorMessage(error)
      record.finishedAt = new Date().toISOString()
      throw error
    }

    return {
      task_id: taskId,
      name: target.name,
      project: record.project,
      status: taskResultStatus(record.status),
      output: record.output,
      summary: record.summary,
      structured: true,
      agentRuntime: requestedAgentRuntime,
    }
  } catch (error) {
    record.status = stoppedTaskStatusFromError(error) ?? 'failed'
    record.error = errorMessage(error)
    record.failure_category = taskFailureCategory(error)
    record.suggestion = taskSuggestion(error)
    record.error_message = taskErrorMessage(error)
    if (error instanceof V2SchemaValidationError) {
      record.error_type = 'input_validation_failed'
      if (config) record.validation_schema = normalizeSchema(config.input as any)
      record.validation_errors = error.details
    }
    record.finishedAt = new Date().toISOString()
    if (taskRowPersisted) {
      const terminalUpdated = updateTaskRowTerminal(
        record.task_id,
        record.status,
        record.output,
        record.summary,
        record.error,
        record.finishedAt,
        record.failure_category,
        record.suggestion,
        record.error_message,
      )
      if (terminalUpdated) {
        if (record.status === 'failed') {
          insertTaskLifecycleEvent(record, 'task.failed')
          await recordTaskRunEvent(record, 'task.run.failed', options)
        }
      } else {
        record.status = readTaskStatus(record.task_id) ?? record.status
      }
    } else {
      if (record.status === 'failed') {
        await recordTaskRunEvent(record, 'task.run.failed', options)
      }
    }
    throw error
  } finally {
    restore()
  }
}

function normalizeExecutionOptions(opts: ExecutionOptions | string): ExecutionOptions {
  return typeof opts === 'string' ? { workspaceRoot: opts } : opts
}

function createKernelTaskRunId(): string {
  return `task_${randomBytes(4).toString('hex')}`
}

function mergePrimitives(overrides: Partial<PrimitiveSet> | undefined): PrimitiveSet {
  return createPrimitiveSet({
    shell: defaultShell,
    llm: defaultLlm,
    ...overrides,
  })
}

function validateInput(schemaLike: unknown, input: unknown, subject: string): unknown {
  const schema = normalizeSchema(schemaLike as ZodType | undefined)
  if (!schema) return input
  const value = input === undefined ? {} : input
  validateAgainstSchema(compileSchema(schema), value, subject)
  return value
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function taskFailureCategory(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'failure_category' in error) {
    const value = (error as Record<string, unknown>).failure_category
    if (typeof value === 'string') return value
  }
  return undefined
}

function stoppedTaskStatusFromError(error: unknown): 'cancelled' | 'interrupted' | undefined {
  switch (taskFailureCategory(error)) {
    case 'agent_cancelled':
    case 'task_cancelled':
      return 'cancelled'
    case 'agent_interrupted':
    case 'task_interrupted':
      return 'interrupted'
    default:
      return undefined
  }
}

function taskSuggestion(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'suggestion' in error) {
    const value = (error as Record<string, unknown>).suggestion
    if (typeof value === 'string') return value
  }
  return undefined
}

function taskErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'error_message' in error) {
    const value = (error as Record<string, unknown>).error_message
    if (typeof value === 'string') return value
  }
  return undefined
}

