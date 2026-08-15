import { get as dbGet, query as dbQuery } from '../../db/connection.mts'
import { ProjectManager } from '../project/manager.mts'
import { discoverProjects } from '../project/loader.mts'
import type { OperationHost, TaskWorkflowRunHost } from '../operations/types.mts'
import { getTaskWorkflowRunHost } from '../operations/primitives/runner.mts'
import {
  QualifiedDefinitionIdError,
} from '../../workspace/definition-registry.mts'
import { ForemanWorkspace } from '../../workspace/workspace.mts'
import { validateAnyJsonValue } from '../../workspace/schema-loader.mts'
import type { ListedDefinition } from '../../workspace/definition-registry.mts'
import { FOREMAN_WORK_ADDRESS } from '../../message/address.mts'
import {
  TaskContextError,
  splitTaskInputContext,
  type TaskContext,
} from './context.mts'

type JsonRecord = Record<string, unknown>

type TaskRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

interface DbTaskEventRow {
  id: number
  execution_id: string
  task_id: string
  seq: number
  type: string
  timestamp: string
  data: string | null
  status: string | null
  exit_code: number | null
  is_error: number | null
}

interface DbTaskStatusRow {
  id: string
  template: string
  project: string | null
  worktree: string | null
  output: string | null
  summary: string | null
  error: string | null
  status: TaskRunStatus
  structured: number | null
  execution_id: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  execution_status: string | null
  execution_output: string | null
  execution_error: string | null
  execution_pid: number | null
  exit_code: number | null
  kill_reason: string | null
  failure_category: string | null
  suggestion: string | null
  error_message: string | null
  requested_agent_runtime: string | null
  resolved_profile: string | null
}

export interface TaskServiceOptions {
  workspaceRoot: string
  operations?: OperationHost
}

export interface TaskRunAccepted {
  id: string
  task_run_id: string
  hint: string
}

export interface TaskInputRequired {
  error_type: 'input_required'
  task: string
  schema?: unknown
  input_example?: unknown
  hint: string
}

export interface TaskInputValidationFailed {
  error_type: 'input_validation_failed'
  task: string
  schema?: unknown
  errors: string[]
  hint: string
}

export interface TaskDefinitionLoadFailed {
  error_type: 'definition_load_failed'
  task: string
  load_error: string
  last_good_available: true
}

export type TaskRunResponse =
  | TaskRunAccepted
  | TaskInputRequired
  | TaskInputValidationFailed
  | TaskDefinitionLoadFailed

export class TaskServiceError extends Error {
  readonly code: string
  readonly statusCode: number
  readonly details: JsonRecord | undefined

  constructor(code: string, message: string, statusCode = 400, details?: JsonRecord) {
    super(message)
    this.name = 'TaskServiceError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

export function isTaskRunRejection(value: unknown): value is Exclude<TaskRunResponse, TaskRunAccepted> {
  return Boolean(value && typeof value === 'object' && 'error_type' in value)
}

export class TaskService {
  private readonly workspaceRoot: string
  private readonly workspace: ForemanWorkspace
  private readonly operations: OperationHost

  constructor(options: TaskServiceOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.workspace = new ForemanWorkspace({ root: options.workspaceRoot })
    this.operations = options.operations ?? {}
  }

  async list(project?: string): Promise<Array<{
    name: string
    source: string
    project?: string
    description?: string
    timeoutMs?: number
    effectiveTimeoutMs?: number
    structuredRetryTimeoutMs?: number
    timeoutScope?: 'agent_attempt'
  }>> {
    await this.workspace.ensureDiscovered()
    if (project) this.requireRegisteredProject(project)
    return this.workspace.tasks.listDefinitions(project)
  }

  async describe(taskId: string, project?: string): Promise<ListedDefinition> {
    await this.workspace.ensureDiscovered()
    if (project) this.requireRegisteredProject(project)

    let task: ListedDefinition | null
    try {
      task = this.workspace.tasks.find(taskId, project)
    } catch (error) {
      if (error instanceof QualifiedDefinitionIdError) {
        throw new TaskServiceError('invalid_task_id', error.message, 400, { task: taskId })
      }
      throw error
    }

    if (!task) {
      throw new TaskServiceError('task_not_found', `Task definition '${taskId}' not found`, 404, { task: taskId })
    }
    return task
  }

  async run(params: {
    taskId: string
    project: string
    worktree?: string
    input: unknown
    /** Inherited API/TaskGraph context; embedded input.ctx overrides matching keys. */
    ctx?: TaskContext
    connectingId?: string
    delegationAdmission?: {
      address: string
      turn_seq: number
      delegation_id: string
      tool_name: string
      input: Record<string, unknown>
    }
    /** Internal compatibility path used only by TaskGraph dispatch so a
     *  persisted graph can resume a legacy definition. */
    allowLegacyTask?: boolean
  }): Promise<TaskRunResponse> {
    const taskId = params.taskId.trim()
    const project = params.project.trim()
    if (!taskId) throw new TaskServiceError('invalid_task_id', 'task_id is required', 400)
    if (!project) throw new TaskServiceError('invalid_project', 'project is required', 400)
    if (taskId.includes('/')) {
      throw new TaskServiceError(
        'invalid_task_id',
        `Qualified task ids containing '/' are not supported: '${taskId}'. Use a plain task id.`,
        400,
        { task: taskId },
      )
    }

    this.requireRegisteredProject(project)
    const description = await this.describe(taskId, project)
    if (description.scheduling === 'legacy' && !params.allowLegacyTask) {
      throw new TaskServiceError(
        'legacy_task_not_schedulable',
        `Task '${taskId}' is legacy-only and cannot start new work. Compose atomic edit and test tasks instead.`,
        409,
        { task: taskId, replacement: ['edit', 'test'] },
      )
    }

    // Front-desk constraint: the Work agent may run readonly tasks directly.
    // Any write work must be dispatched via pm.ticket.create + fwa.assign. The
    // delegation admission descriptor is internal-only and is attached solely by
    // the Work agent's tool adapter, so its address identifies the Work caller.
    if (params.delegationAdmission?.address === FOREMAN_WORK_ADDRESS) {
      const permission = description.permission
      if (permission !== 'readonly') {
        throw new TaskServiceError(
          'work_agent_readonly_only',
          `Task '${taskId}' requires '${permission ?? 'unknown'}' permission, which the Work agent cannot run directly. Dispatch write work via pm.ticket.create + fwa.assign instead.`,
          403,
          { task: taskId, permission: permission ?? null },
        )
      }
    }

    if (params.input === undefined || params.input === null) {
      return {
        error_type: 'input_required',
        task: taskId,
        schema: description.input_schema,
        input_example: description.input_example,
        hint: 'Input JSON is required. Use the schema and example above to construct valid input.',
      }
    }

    const rawInput = this.normalizeTaskInput(params.input)
    let input: unknown
    let taskContext: TaskContext | undefined
    try {
      const split = splitTaskInputContext(rawInput, params.ctx)
      input = split.input
      taskContext = split.ctx
    } catch (error) {
      if (error instanceof TaskContextError) {
        throw new TaskServiceError('invalid_context', error.message, 400)
      }
      throw error
    }
    const target = this.workspace.tasks.resolve(taskId, project)
    if (!target) {
      throw new TaskServiceError('task_resolution_failed', `Task definition '${taskId}' could not be resolved`, 500)
    }

    if (this.workspace.isPathStale(target.sourcePath)) {
      const loadError = this.workspace.getLoadErrors().find((entry) => entry.sourcePath === target.sourcePath)
      return {
        error_type: 'definition_load_failed',
        task: target.name,
        load_error: loadError?.load_error ?? 'Definition file failed to load',
        last_good_available: true,
      }
    }

    const validation = this.validateInput(description, input)
    if (validation) return validation

    let workingDirectory: string
    try {
      workingDirectory = this.resolveWorkingDirectory(project, params.worktree)
    } catch (error) {
      throw new TaskServiceError(
        'project_resolution_failed',
        `Could not resolve working directory for project '${project}': ${errorMessage(error)}`,
        400,
      )
    }

    return this.requireRunner().startTaskRun({
      definitionName: taskId,
      taskName: target.name,
      project,
      executionProject: project,
      source: target.source,
      input,
      workspaceRoot: this.workspaceRoot,
      workingDirectory,
      worktree: params.worktree,
      connectingId: params.connectingId,
      taskContext,
      delegationAdmission: params.delegationAdmission,
    })
  }

  async cancel(taskRunId: string): Promise<JsonRecord> {
    return this.requireRunner().cancelTaskRun(taskRunId)
  }

  activeRuns(): { tasks: string[]; count: number } {
    const rows = dbQuery<{ id: string }>(
      `SELECT id
      FROM tasks
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC, id ASC`,
    )
    const tasks = rows.map((row) => row.id)
    return { tasks, count: tasks.length }
  }

  status(taskRunId: string): JsonRecord | null {
    const row = readTaskStatusRow(taskRunId)
    return row ? taskStatusRowToJson(row) : null
  }

  async taskRunEvents(params: {
    taskRunId: string
    afterSeq?: number
    limit?: number
  }): Promise<{
    task_run_id: string
    events: Array<{
      seq: number
      type: string
      timestamp: string
      data: unknown
      status?: string
      exit_code?: number
      is_error?: boolean
    }>
    next_seq: number
    has_more: boolean
  }> {
    const taskRow = dbGet<DbTaskStatusRow>(
      `SELECT
        t.id, t.template, t.project, t.worktree, t.output, t.summary, t.error,
        t.status, t.structured, t.execution_id, t.created_at, t.updated_at, t.ended_at,
        t.failure_category, t.suggestion, t.error_message,
        e.status AS execution_status, e.output AS execution_output, e.error AS execution_error,
        e.pid AS execution_pid, e.exit_code, e.kill_reason,
        e.requested_agent_runtime, e.resolved_profile
      FROM tasks t
      LEFT JOIN executions e ON e.id = t.execution_id
      WHERE t.id = ?`,
      params.taskRunId,
    )
    if (!taskRow) {
      throw new TaskServiceError('task_not_found', `Task run '${params.taskRunId}' not found`, 404)
    }

    const limit = typeof params.limit === 'number'
      ? Math.max(1, Math.min(500, Math.floor(params.limit)))
      : 200
    const afterSeq = typeof params.afterSeq === 'number' ? Math.max(0, Math.floor(params.afterSeq)) : 0

    const eventRows = dbQuery<DbTaskEventRow>(
      `SELECT id, execution_id, task_id, id AS seq, type, timestamp, data,
              status, exit_code, is_error
       FROM events
       WHERE (execution_id = ? OR (execution_id IS NULL AND task_id = ?))
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      taskRow.execution_id,
      params.taskRunId,
      afterSeq,
      limit + 1,
    )
    const hasMore = eventRows.length > limit
    const selected = hasMore ? eventRows.slice(0, limit) : eventRows
    const events = selected.map((row) => {
      const parsed = parseEventData(row.data)
      const data = typeof parsed === 'object' && parsed !== null
        ? safeEventProjection(row.type, parsed)
        : {}
      return {
        seq: row.seq,
        type: row.type,
        timestamp: row.timestamp,
        data,
        ...(row.status !== null ? { status: row.status } : {}),
        ...(row.exit_code !== null ? { exit_code: row.exit_code } : {}),
        ...(row.is_error !== null ? { is_error: row.is_error === 1 } : {}),
      }
    })
    return {
      task_run_id: params.taskRunId,
      events,
      next_seq: events.at(-1)?.seq ?? afterSeq,
      has_more: hasMore,
    }
  }

  output(taskRunId: string): JsonRecord | null {
    const row = readTaskStatusRow(taskRunId)
    if (!row) return null

    const output = row.output ?? row.execution_output ?? ''
    const parsedOutput = row.status === 'done' ? parseJsonValue(output) : undefined
    return {
      task_run_id: row.id,
      status: row.status,
      ...(row.summary ? { summary: row.summary } : {}),
      output: parsedOutput === undefined ? output : parsedOutput,
      error: row.error ?? row.execution_error ?? null,
      ...taskFailureFields(row),
      ...(row.execution_pid === null ? {} : { pid: row.execution_pid }),
      _meta: taskRowMeta(row),
    }
  }

  private normalizeTaskInput(input: unknown): unknown {
    let value = input
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown
      } catch {
        throw new TaskServiceError('invalid_input', 'input must be valid JSON', 400)
      }
    }

    return value
  }

  private validateInput(task: ListedDefinition, input: unknown): TaskInputValidationFailed | null {
    if (!task.input_schema) return null

    const schema = task.input_schema as JsonRecord
    const result = validateAnyJsonValue(schema as any, input)
    if (result.valid) return null

    return {
      error_type: 'input_validation_failed',
      task: task.name,
      schema,
      errors: result.errors,
      hint: 'call task_describe for the contract',
    }
  }

  private requireRegisteredProject(project: string): void {
    try {
      this.projectManager().getProject(project)
    } catch (error) {
      const suggestions = projectSuggestions(this.workspaceRoot, project)
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : ''
      throw new TaskServiceError('project_not_found', `${errorMessage(error)}${hint}`, 404, {
        project,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      })
    }
  }

  private requireRunner(): TaskWorkflowRunHost {
    if (this.operations.runner) return this.operations.runner
    try {
      return getTaskWorkflowRunHost()
    } catch (error) {
      throw new TaskServiceError(
        'task_runner_unavailable',
        'Task execution requires a daemon-owned task workflow runner. Start `foreman daemon start`.',
        503,
        { cause: errorMessage(error) },
      )
    }
  }

  private projectManager(): ProjectManager {
    return new ProjectManager({ workspaceRoot: this.workspaceRoot })
  }

  private resolveWorkingDirectory(project: string, worktree?: string): string {
    const manager = this.projectManager()
    const entry = manager.getProject(project)
    if (worktree?.trim()) {
      if (entry.noWorktree) throw new Error(`Project '${entry.name}' does not support worktrees`)
      return manager.resolveWorktreePath(worktree, project)
    }
    return manager.resolveBasePath(project)
  }
}

function readTaskStatusRow(taskRunId: string): DbTaskStatusRow | null {
  return dbGet<DbTaskStatusRow>(
    `SELECT
      t.id, t.template, t.project, t.worktree, t.output, t.summary, t.error,
      t.status, t.structured, t.execution_id, t.created_at, t.updated_at, t.ended_at,
      t.failure_category, t.suggestion, t.error_message,
      e.status AS execution_status, e.output AS execution_output, e.error AS execution_error,
      e.pid AS execution_pid, e.exit_code, e.kill_reason,
      e.requested_agent_runtime, e.resolved_profile
    FROM tasks t
    LEFT JOIN executions e ON e.id = t.execution_id
    WHERE t.id = ?`,
    taskRunId,
  ) ?? null
}

function taskStatusRowToJson(row: DbTaskStatusRow): JsonRecord {
  const output = row.output ?? row.execution_output
  return {
    task_run_id: row.id,
    status: row.status,
    ...(row.worktree ? { worktree: row.worktree } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    error: row.error ?? row.execution_error ?? null,
    ...taskFailureFields(row),
    has_output: output !== null && output !== undefined && output !== '',
    ...(row.execution_pid === null ? {} : { pid: row.execution_pid }),
    _meta: taskRowMeta(row),
  }
}

function taskRowMeta(row: DbTaskStatusRow): JsonRecord {
  return compactRecord({
    source: 'sqlite',
    task_run_id: row.id,
    template: row.template,
    project: row.project,
    worktree: row.worktree,
    execution_id: row.execution_id,
    execution_status: row.execution_status,
    exit_code: row.exit_code,
    kill_reason: row.kill_reason,
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at,
    requested_agent_runtime: row.requested_agent_runtime,
    resolved_profile: row.resolved_profile,
  })
}

function parseJsonValue(value: string | null): unknown | undefined {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function compactRecord(value: JsonRecord): JsonRecord {
  const next: JsonRecord = {}
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined && field !== null) next[key] = field
  }
  return next
}

function taskFailureFields(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object') return {}
  const record = value as {
    failure_category?: unknown
    suggestion?: unknown
    error_message?: unknown
  }
  return {
    ...(typeof record.failure_category === 'string' ? { failure_category: record.failure_category } : {}),
    ...(typeof record.suggestion === 'string' ? { suggestion: record.suggestion } : {}),
    ...(typeof record.error_message === 'string' ? { error_message: record.error_message } : {}),
  }
}

function taskErrorField(error: unknown, field: string): string | undefined {
  if (error && typeof error === 'object' && field in error) {
    const value = (error as Record<string, unknown>)[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

function projectSuggestions(workspaceRoot: string, project: string): string[] {
  const query = normalizeProjectName(project)
  if (!query) return []

  return [...discoverProjects(workspaceRoot).keys()]
    .map((name) => ({ name, score: projectSuggestionScore(query, name) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((entry) => entry.name)
}

function projectSuggestionScore(query: string, name: string): number {
  const candidate = normalizeProjectName(name)
  const lastSegment = candidate.split('/').pop() ?? candidate
  if (candidate === query) return 0
  if (lastSegment === query) return 1
  if (candidate.endsWith(`/${query}`)) return 2
  if (candidate.includes(query)) return 5
  const distance = Math.min(
    levenshteinDistance(query, lastSegment),
    levenshteinDistance(query, candidate),
  )
  const size = Math.max(query.length, lastSegment.length, 1)
  const ratio = distance / size
  return ratio <= 0.45 ? 10 + ratio : Number.POSITIVE_INFINITY
}

function normalizeProjectName(value: string): string {
  return value.trim().toLowerCase().replace(/\\/gu, '/')
}

function levenshteinDistance(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1)
  const current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      )
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }
  return previous[b.length]
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function safeEventProjection(type: string, data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object') return {}

  const record = data as Record<string, unknown>

  switch (type) {
    case 'message': {
      const result: Record<string, unknown> = {
        message_summary: safeTextSummary(
          record.message_summary ?? record.text ?? record.content,
          1_200,
        ) ?? 'Message recorded',
      }
      const role = safeIdentifier(record.role, 24)
      if (role) result.role = role
      return result
    }
    case 'tool_call': {
      const result: Record<string, unknown> = {
        input_summary: safeTextSummary(record.input_summary, 500) ?? 'Tool input recorded',
      }
      const toolName = safeIdentifier(record.tool_name ?? record.name, 80)
      const callId = safeIdentifier(record.call_id, 120)
      if (toolName) result.tool_name = toolName
      if (callId) result.call_id = callId
      const input = record.input_summary ?? record.input ?? record.arguments
      if (input === undefined || input === null) result.input_summary = 'No tool input recorded'
      return result
    }
    case 'tool_result': {
      const outputSource = record.output_summary
        ?? record.output_tail
        ?? record.output
        ?? record.result
        ?? record.text
        ?? record.content
      const result: Record<string, unknown> = {
        output_summary: safeTextSummary(outputSource, 500) ?? 'Tool output recorded',
      }
      const toolName = safeIdentifier(record.tool_name ?? record.name, 80)
      const callId = safeIdentifier(record.call_id, 120)
      const status = safeIdentifier(record.status, 40)
      if (toolName) result.tool_name = toolName
      if (callId) result.call_id = callId
      if (status) result.status = status
      if (typeof record.is_error === 'boolean') result.is_error = record.is_error
      if (outputSource === undefined || outputSource === null) result.output_summary = 'No tool output recorded'
      return result
    }
    case 'turn_usage': {
      const result: Record<string, unknown> = {}
      if (typeof record.input_tokens === 'number' && Number.isFinite(record.input_tokens) && record.input_tokens >= 0)
        result.input_tokens = record.input_tokens
      if (typeof record.output_tokens === 'number' && Number.isFinite(record.output_tokens) && record.output_tokens >= 0)
        result.output_tokens = record.output_tokens
      if (typeof record.total_tokens === 'number' && Number.isFinite(record.total_tokens) && record.total_tokens >= 0)
        result.total_tokens = record.total_tokens
      if (typeof record.duration_ms === 'number' && Number.isFinite(record.duration_ms) && record.duration_ms >= 0)
        result.duration_ms = record.duration_ms
      return result
    }
    default: {
      if (SAFE_LIFECYCLE_EVENTS.has(type)) {
        const result: Record<string, unknown> = { event: type }
        if (typeof record.status === 'string' && SAFE_LIFECYCLE_STATUSES.has(record.status)) {
          result.status = record.status
        }
        return result
      }
      // Unknown event type: empty object
      return {}
    }
  }
}

const SAFE_LIFECYCLE_EVENTS = new Set([
  'dispatch', 'workflow.started', 'workflow.completed', 'workflow.failed',
  'task.started', 'task.done', 'task.completed', 'task.failed', 'task.cancelled',
  'agent.started', 'agent.completed', 'agent.failed',
  'execution.started', 'execution.completed',
  'plan_generated', 'plan_accepted', 'plan_rejected',
])

const SAFE_LIFECYCLE_STATUSES = new Set([
  'created', 'queued', 'running', 'done', 'completed', 'failed', 'cancelled',
  'interrupted', 'paused', 'waiting', 'blocked',
])

function safeIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined
  return /^[a-z0-9_.:/-]+$/iu.test(value) ? value : undefined
}

/**
 * Project one already-redacted transcript scalar into a bounded display
 * summary.  The event API never forwards nested input/output objects and
 * performs a final defence-in-depth pass for common credential forms before
 * making the summary observable to desktop clients.
 */
function safeTextSummary(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined

  let text = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim()
  if (!text) return undefined

  text = text
    .replace(/(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/giu, '$1[REDACTED]')
    .replace(
      /(\b(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|credential|authorization|auth)\b\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk-[a-z0-9_-]{8,}|tok_[a-z0-9_+=/-]{8,}|ghp_[a-z0-9]{8,}|github_pat_[a-z0-9_]{8,})\b/giu, '[REDACTED]')
    .replace(/\$(?:\{)?[a-z0-9_]*(?:token|secret|password|passwd|key|auth|credential)[a-z0-9_]*(?:\})?/giu, '[REDACTED]')

  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function parseEventData(data: string | null): unknown {
  if (data === null) return null
  try {
    return JSON.parse(data) as unknown
  } catch {
    return data
  }
}
