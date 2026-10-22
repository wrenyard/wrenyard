import { randomBytes } from 'node:crypto'
import { estimateTokens } from '@wrenyard/model-call'
import { getDb } from '../../db/connection.mts'
import { ExecutionEventStore } from '../../db/stores/execution-event-store.mts'
import {
  TaskRunStore,
  type TaskRunStoreStatus,
} from '../../db/stores/task-run-store.mts'
import { executeShell as defaultShell } from '../../adapters/shell/execute.mts'
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
  TaskRunSettingsResolution,
} from '../../types.mts'
import type { ZodType } from 'zod'
import {
  ensureDiscovered,
  resolveTaskTarget,
} from '../../workspace/task-loader.mts'
import { installRuntimeGlobals } from './runtime-globals.mts'
import {
  compileSchema,
  normalizeSchema,
  V2SchemaValidationError,
  validateAgainstSchema,
} from '@wrenyard/task'
import {
  collectStructuredOutput,
  firstPrompt,
  taskTimeoutCapturedOutput,
  type StructuredOutputAgent,
} from '@wrenyard/task'
import type { TaskRunFacts } from '@wrenyard/protocol/task'
import { parseRunSyntax } from '@wrenyard/providers/catalog'
import type { RouteGuard, RouteStatus } from '@wrenyard/gateway'
import {
  createTaskArtifactDirectory,
  outputSchemaDeclaresArtifacts,
  taskArtifactPromptParagraph,
} from '@wrenyard/task'
import { resolveFeatures } from '@wrenyard/task'
import { buildTaskPrompt } from '@wrenyard/task'
import { splitTaskInputContext } from '@wrenyard/task'
import { resolveTaskWritePaths } from '@wrenyard/task'
import {
  captureRunBaseline,
  collectRunFacts,
  collectTerminalRunFactsJson,
  isTaskRunTimedOut,
  readTaskRowFactsContext,
} from './run-facts.mts'
import {
  extractGateFailure,
  GateFailureError,
  isGateError,
  type GateFailurePayload,
} from '@wrenyard/task'

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
    const result = await gate.run(gateCtx)
    if (!result.ok) {
      throw new GateFailureError(phase, gate.id, result.expected, result.actual, {
        evidence: result.evidence,
        remediation: result.remediation,
        retryable: result.retryable,
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

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function taskSummaryFromReport(report: string): string | undefined {
  return firstNonEmptyLine(report.trim())
}

function taskSummaryFromOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return taskSummaryFromReport(output)
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const record = output as Record<string, unknown>
    const report = record.report
    if (typeof report === 'string' && report.trim()) return taskSummaryFromReport(report)
    const summary = record.summary
    if (typeof summary === 'string' && summary.trim()) return summary.trim()
  }
  return undefined
}

function parseTaskRunFactsJson(factsJson: string | null): TaskRunFacts | undefined {
  if (!factsJson) return undefined
  try {
    return JSON.parse(factsJson) as TaskRunFacts
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
  facts?: string | null,
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
    facts,
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
  kind: 'task.run.started' | 'task.run.completed' | 'task.run.failed' | 'task.run.cancelled' | 'task.run.interrupted',
  options: ExecutionOptions,
): Promise<void> {
  const suffix = kind === 'task.run.started' ? 'started'
    : kind === 'task.run.completed' ? 'done'
    : kind === 'task.run.failed' ? 'failed'
    : kind === 'task.run.cancelled' ? 'cancelled'
    : 'interrupted'
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
    const taskInputContext = splitTaskInputContext(input, options.taskContext)
    await ensureDiscovered(options.workspaceRoot)
    const target = resolveTaskTarget(name, options.workspaceRoot, options.currentProject)
    if (!target) throw new Error(`Task not found: ${name}`)
    record.name = target.name
    record.source = target.source
    if (!record.project) record.project = target.project ?? ''

    const definition = target.definition as TaskDefinition
    config = definition.config

    // Effective runtime/timeout placeholders. Production execution resolves them
    // through the daemon TaskSettingsService exactly once, after pre-gates and
    // before the first agent attempt. The dispatch-resolver path below is
    // preserved only when no settings resolver was supplied (isolated tests) and
    // never runs alongside task settings resolution.
    let requestedAgentRuntime: string | undefined
    let exactAgentRuntime: string | undefined
    let dispatchSnapshot: import('@wrenyard/protocol').TaskResolvedDispatch | null = null
    let codeBuddyExecution: import('../../core/operations/types.mts').CodeBuddyExecutionBinding | undefined
    let runTimeLimitMs: number | undefined
    const effectiveInput = validateInput(config.input, taskInputContext.input, `Invalid input for task '${target.name}'`)
    const executionOptions = options
    const runCheckoutPath = executionOptions.workingDirectory ?? process.cwd()
    await captureRunBaseline(taskId, runCheckoutPath)
    // Resolve selected features from config before launching an agent.
    // Invalid selections surface as deterministic task execution errors.
    const selectedFeatures = resolveFeatures(config.features, effectiveInput)
    const resolvedWritePaths = resolveTaskWritePaths(
      config,
      effectiveInput,
      executionOptions.workingDirectory ?? process.cwd(),
    )
    const repoWriteLock = resolvedWritePaths !== undefined && resolvedWritePaths.length > 0
    const writePaths = repoWriteLock ? resolvedWritePaths : undefined
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

    const artifactDirectory = await createTaskArtifactDirectory(taskId)
    let prompt = await buildTaskPrompt(
      definition,
      effectiveInput,
      taskInputContext.ctx,
    )
    if (outputSchemaDeclaresArtifacts(outputSchema)) {
      prompt = `${prompt}\n\n${taskArtifactPromptParagraph(artifactDirectory)}`
    }
    const inputTokens = estimateTokens(firstPrompt(prompt))

    if (!options.taskSettingsResolver) {
      // Pin-free legacy recovery boundary: a scheduling:'legacy' definition is
      // never auto/alias-resolved here. Recovery reattaches an already persisted
      // task_run_id/exact execution and does not invoke this kernel, so a legacy
      // launch reaching automatic dispatch is always refused with a precise
      // error instead of re-resolving a runtime from the current definition.
      if (config.scheduling === 'legacy') {
        throw new Error(
          `Legacy task '${target.name}' cannot be auto-dispatched: legacy recovery must reattach an already persisted task_run_id/exact execution and cannot re-resolve a current definition.`,
        )
      }
      // Resolve the deterministic automatic dispatch plan before the first agent
      // attempt. Active tasks MUST resolve through a resolver: either this
      // constrained path or the daemon settings service.
      if (config.dispatch) {
        if (!options.taskDispatchResolver) {
          throw new Error(
            `Task '${target.name}' declares a constrained dispatch but no taskDispatchResolver was supplied to the daemon execution kernel.`,
          )
        }
        const resolution = await options.taskDispatchResolver.resolve({
          taskName: target.name,
          requirements: { ...config.dispatch, inputTokens },
        })
        if (!resolution.ok) throw resolution.error
        exactAgentRuntime = resolution.exactAgentRuntime
        requestedAgentRuntime = exactAgentRuntime
        dispatchSnapshot = resolution.resolved
      } else {
        throw new Error(
          `Active task '${target.name}' cannot run without a resolver: automatic selection requires a taskSettingsResolver or dispatch requirements with a taskDispatchResolver.`,
        )
      }
    }

    // Resolve task settings once per task run. The daemon TaskSettingsService
    // owns field merging and readiness; its result is authoritative: the
    // canonical exact target chosen by automatic selection is the only launched
    // runtime, the dispatch snapshot feeds telemetry, and the effective timeout
    // is the single total task_execution deadline. exactAgentRuntime is optional
    // on the resolution contract; a null target terminates the run with no
    // fallback runtime or stale agentRuntime pin.
    //
    // Each task run resolves at most one route and launches at most one attempt;
    // the caller decides whether to dispatch again.
    const taskConfig = config
    let resolution: TaskRunSettingsResolution | undefined
    const resolveRunSettings = async (): Promise<void> => {
      // Legacy recovery must never reach a new model launch through current
      // settings: refuse before the settings service can auto/alias-resolve a
      // fresh runtime for a scheduling:'legacy' definition.
      if (taskConfig.scheduling === 'legacy') {
        throw new Error(
          `Legacy task '${target.name}' cannot be launched through task settings resolution: legacy recovery must reattach an already persisted task_run_id/exact execution and cannot re-resolve a current definition.`,
        )
      }
      const settingsResolution = await options.taskSettingsResolver!({
        taskName: target.name,
        inputTokens,
        kind: target.source,
        project: target.project,
        defaults: {
          ...(taskConfig.dispatch ? { dispatch: taskConfig.dispatch as unknown as Record<string, unknown> } : {}),
        },
        ...(options.invocationSettings ? { invocation: options.invocationSettings } : {}),
        mountedFeatures: selectedFeatures,
      })
      // Consume the canonical target produced by the settings service exactly;
      // never fall back to a stale agentRuntime pin when it is absent.
      const canonicalTarget = settingsResolution.exactAgentRuntime
      if (!canonicalTarget) {
        throw new Error(
          `Task settings resolution for '${target.name}' returned no canonical exact target; refusing to launch a fallback runtime.`,
        )
      }
      exactAgentRuntime = canonicalTarget
      requestedAgentRuntime = canonicalTarget
      dispatchSnapshot = settingsResolution.dispatch
      codeBuddyExecution = settingsResolution.codeBuddyExecution
      if (settingsResolution.runTimeLimitMinutes !== undefined && settingsResolution.runTimeLimitMinutes !== null) {
        runTimeLimitMs = settingsResolution.runTimeLimitMinutes * 60_000
      }
      resolution = settingsResolution
    }

    assertTaskStillActive(taskId)
    let routeFaultSnapshot: RouteStatus | undefined

    const launchAttempt = async (): Promise<void> => {
      // ── Native-task route state ──
      // Only a launched attempt is accounted. The handle is settled at most once:
      // success on a terminal agent completion, failure on the terminal delivery
      // failure, never after the post-gates.
      let routeIdentity: { provider: string; model: string } | undefined
      let routeGuard: RouteGuard | undefined
      let routeSettled = false
      const runAgent: StructuredOutputAgent = async (profile, prompt, opts) => {
        if (routeIdentity === undefined && options.taskRouteState) {
          const identity = routeIdentityOf(profile)
          if (identity !== undefined) {
            const admission = options.taskRouteState.admit(identity.provider, identity.model, dispatchSnapshot?.mode)
            // A pinned or automatically selected route the shared circuit still
            // refuses fails clearly instead of launching a doomed attempt.
            if (admission.kind === 'blocked') {
              throw new Error(
                `Route ${identity.provider}/${identity.model} is blocked by the shared circuit ` +
                  `(${admission.status.state}, phase ${admission.status.phase}); refusing to launch an attempt. ` +
                  `Retry after ${admission.status.until} or select another route.`,
              )
            }
            routeIdentity = identity
            routeGuard = admission.guard
          }
        }
        return primitives.agent(profile, prompt, {
          ...opts,
          repoWriteLock: opts?.repoWriteLock ?? repoWriteLock,
          writePaths: opts?.writePaths,
        })
      }
      // An unresolved exact runtime must never launch a fallback: guard the
      // optional resolution result before constructing the structured run so
      // the resolved runtime is safely assigned to the required profile.
      if (!exactAgentRuntime) {
        throw new Error(
          `No exact agent runtime resolved for task '${target.name}'; refusing to launch a fallback runtime.`,
        )
      }
      const structuredOptions: Parameters<typeof collectStructuredOutput>[0] = {
        profile: exactAgentRuntime,
        instructions: prompt,
        outputSchema,
        runAgent,
        workingDirectory: executionOptions.workingDirectory,
        taskName: target.name,
        taskId,
        repoWriteLock,
        runTimeLimitMs: runTimeLimitMs ?? 60 * 60_000,
        features: selectedFeatures,
        writePaths,
        requestedAgentRuntime: requestedAgentRuntime,
        dispatchSnapshot,
        codeBuddyExecution,
        onRouteSuccess: () => {
          if (!routeSettled && routeIdentity !== undefined && options.taskRouteState) {
            routeSettled = true
            options.taskRouteState.success(routeIdentity.provider, routeIdentity.model, routeGuard)
          }
        },
        onRouteFault: (fault) => {
          if (!routeSettled && routeIdentity !== undefined && options.taskRouteState) {
            // Only a launched attempt's terminal delivery failure faults the
            // route — a structured-output/protocol failure or the upstream
            // error a failed execution reported. The payload is forwarded
            // unchanged; classification belongs to the route-state port.
            // Cancellation, time budget and functional task failures never
            // reach this hook.
            routeSettled = true
            routeFaultSnapshot = options.taskRouteState.fault(
              routeIdentity.provider,
              routeIdentity.model,
              routeGuard,
              fault,
            )
          }
        },
        beforeAttempt: () => assertTaskStillActive(taskId),
      }
      const report = await collectStructuredOutput(structuredOptions)
      assertTaskStillActive(taskId)
      const summary = taskSummaryFromReport(report) ?? null
      const factsContext = readTaskRowFactsContext(taskId)
      const finishedAt = new Date().toISOString()
      const facts = await collectRunFacts({
        taskRunId: taskId,
        status: 'done',
        failureCategory: null,
        startedAt: factsContext.startedAt,
        endedAt: finishedAt,
        timedOut: false,
        checkoutPath: runCheckoutPath,
        worktreeId: executionOptions.worktreeId ?? factsContext.worktree,
      })
      const factsJson = JSON.stringify(facts)
      // The run's deliverable is the report itself. Consumers that need the
      // task's output schema filled run the task-output compile step on demand
      // (`task.run.compile`, TaskGraph nodes with an output schema); no
      // consumer compiles inside the run.
      const output: unknown = report

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
      record.summary = summary
      record.finishedAt = finishedAt
      const terminalUpdated = updateTaskRowTerminal(
        taskId,
        'done',
        output,
        record.summary,
        null,
        record.finishedAt,
        undefined,
        undefined,
        undefined,
        factsJson,
      )
      if (terminalUpdated) {
        insertTaskLifecycleEvent(record, 'task.done')
        await recordTaskRunEvent(record, 'task.run.completed', executionOptions)
      } else {
        record.status = readTaskStatus(taskId) ?? record.status
      }
    }

    assertTaskStillActive(taskId)
    if (options.taskSettingsResolver) {
      await resolveRunSettings()
    }
    try {
      await launchAttempt()
    } catch (error) {
      const identity = exactAgentRuntime !== undefined ? routeIdentityOf(exactAgentRuntime) : undefined
      throw enrichTaskLaunchFailure(error, identity, routeFaultSnapshot)
    }

    const result: TaskExecutionResult = {
      task_id: taskId,
      name: target.name,
      project: record.project,
      status: taskResultStatus(record.status),
      output: record.output,
      summary: record.summary,
      structured: true,
      agentRuntime: requestedAgentRuntime,
    }
    return result
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
    const capturedReport = taskTimeoutCapturedOutput(error)
    if (capturedReport) {
      record.summary = taskSummaryFromReport(capturedReport) ?? record.summary ?? null
    }
    if (taskRowPersisted) {
      const factsContext = readTaskRowFactsContext(record.task_id)
      const factsJson = await collectTerminalRunFactsJson({
        taskRunId: record.task_id,
        status: record.status,
        failureCategory: record.failure_category,
        startedAt: factsContext.startedAt,
        endedAt: record.finishedAt,
        // Executions-row timeout settlement may complete after facts collection; agent_timeout is the reliable signal.
        timedOut:
          isTaskRunTimedOut(factsContext, record.status) ||
          record.failure_category === 'agent_timeout',
        checkoutPath: options.workingDirectory ?? process.cwd(),
        worktreeId: options.worktreeId ?? factsContext.worktree,
      })
      if (capturedReport) {
        const facts = parseTaskRunFactsJson(factsJson)
        record.output = facts
          ? { report: capturedReport, facts }
          : { report: capturedReport }
      }
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
        factsJson,
      )
      if (terminalUpdated) {
        // Publish exactly one final task lifecycle event matching the terminal
        // status. The successful CAS guarantees a losing late terminal update
        // (already-terminal row) emits nothing. done/failed keep their
        // historical kinds; cancelled/interrupted publish their own kinds.
        if (record.status === 'failed') {
          insertTaskLifecycleEvent(record, 'task.failed')
          await recordTaskRunEvent(record, 'task.run.failed', options)
        } else if (record.status === 'cancelled') {
          await recordTaskRunEvent(record, 'task.run.cancelled', options)
        } else if (record.status === 'interrupted') {
          await recordTaskRunEvent(record, 'task.run.interrupted', options)
        }
      } else {
        record.status = readTaskStatus(record.task_id) ?? record.status
      }
    } else {
      if (record.status === 'failed') {
        await recordTaskRunEvent(record, 'task.run.failed', options)
      } else if (record.status === 'cancelled') {
        await recordTaskRunEvent(record, 'task.run.cancelled', options)
      } else if (record.status === 'interrupted') {
        await recordTaskRunEvent(record, 'task.run.interrupted', options)
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

function enrichTaskLaunchFailure(
  error: unknown,
  route: { provider: string; model: string } | undefined,
  snapshot: RouteStatus | undefined,
): unknown {
  if (!(error instanceof Error) || route === undefined || snapshot === undefined || snapshot.phase !== 'open') {
    return error
  }
  let bareModel = route.model
  try {
    bareModel = parseRunSyntax(`${route.provider}/${route.model}`).model
  } catch {}
  const until = snapshot.until
  const routeKey = `${route.provider}/${bareModel}`
  const enriched = error as Error & { error_message?: string }
  enriched.message = `${error.message}; failed route ${routeKey} (${snapshot.state})${
    until !== undefined && until !== '' ? `; retry after ${until}` : ''
  }`
  if (typeof enriched.error_message !== 'string') return enriched
  try {
    const parsed: unknown = JSON.parse(enriched.error_message)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return enriched
    enriched.error_message = JSON.stringify({
      ...(parsed as Record<string, unknown>),
      route_provider: route.provider,
      route_model: bareModel,
      route_state: snapshot.state,
      ...(until !== undefined && until !== '' ? { route_until: until } : {}),
      ...(snapshot.faultKind !== undefined ? { route_fault_kind: snapshot.faultKind } : {}),
    })
  } catch {}
  return enriched
}

/**
 * Resolve the shared route identity of a canonical `provider/model:client`
 * execution target with the canonical run-syntax helper: the provider on its
 * own, plus the route's model key explicitly client-qualified
 * (`deepseek-v4.1-flash:cb`). Each task run resolves one route; provider and
 * model share the gateway route state and the `:client` suffix is never treated
 * as an upstream model id.
 */
function routeIdentityOf(exactAgentRuntime: string): { provider: string; model: string } | undefined {
  let provider: string
  try {
    provider = parseRunSyntax(exactAgentRuntime).provider
  } catch {
    return undefined
  }
  const model = exactAgentRuntime.slice(provider.length + 1)
  return model.length > 0 ? { provider, model } : undefined
}

function mergePrimitives(overrides: Partial<PrimitiveSet> | undefined): PrimitiveSet {
  return createPrimitiveSet({
    shell: defaultShell,
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
