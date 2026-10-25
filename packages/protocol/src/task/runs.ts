import type { JsonRecord } from '../common/jsonrpc.ts'
import type { TaskResolvedDispatch, TaskUsage } from './run-metadata.ts'
import type { TaskSettingsLayer } from './settings.ts'

export const taskRunStatusValues = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
] as const

export type TaskRunStatus = typeof taskRunStatusValues[number]

export interface TaskRunFactsCommit {
  sha: string
  subject: string
}

export interface TaskRunFactsArtifactFile {
  path: string
  bytes: number
}

export interface TaskRunFacts {
  status: TaskRunStatus | string
  failure_category?: string
  duration_ms: number | null
  timed_out: boolean
  checkout_path?: string
  worktree_id?: string
  changed_files: string[]
  commits: TaskRunFactsCommit[]
  artifact_files: TaskRunFactsArtifactFile[]
}

export interface TaskRunCreateParams {
  task_id: string
  project: string
  worktree?: string
  input?: unknown
  /** Bounded JSON-safe KV context inherited by this task run. */
  ctx?: JsonRecord
  /** Optional one-shot invocation settings layer for this run only. Sits at the
   *  top of the field precedence chain (system < builtin < user global < user
   *  per-task < invocation) and is never persisted. */
  invocation_settings?: TaskSettingsLayer
}

export interface TaskRunAccepted {
  id: string
  task_run_id: string
  hint: string
  /** Authoritative display name from the resolved definition (builtin or
   *  project); omitted when the definition declares none. */
  task_name?: string
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

export type TaskRunCreateResult =
  | TaskRunAccepted
  | TaskInputRequired
  | TaskInputValidationFailed
  | TaskDefinitionLoadFailed

export interface TaskRunListParams {}

export interface TaskRunListResult {
  tasks: string[]
  count: number
}

export interface TaskRunStatusParams {
  task_run_id: string
}

/** Cumulative gateway-side usage of a still-running task run. Reported values
 *  are approximate; the run's final usage is decided by the terminal record. */
export interface TaskUsageLive {
  input: number
  cachedInput: number
  output: number
  requests: number
}

export interface TaskUsageLiveListParams {
  /** Active gateway execution ids to read cumulative live usage for. */
  execution_ids: string[]
}

/** One live usage record keyed by its gateway execution identity. */
export interface TaskUsageLiveRecord {
  executionId: string
  taskRunId?: string
  usage: TaskUsageLive
}

export interface TaskUsageLiveListResult {
  /** execution_id -> identity-bearing cumulative usage, present only for
   *  still-running gateway executions that already produced at least one
   *  gateway request. Native executions are never reported. */
  usage: Record<string, TaskUsageLiveRecord>
}

export interface TaskRunStatusResult {
  task_run_id: string
  task_id: string
  /** Authoritative definition display name when resolvable; optional and
   *  omitted rather than guessed when the registry has no definition. */
  task_name?: string
  status: TaskRunStatus
  summary?: string
  resolved?: TaskResolvedDispatch
  recorded?: { provider: string; model: string }
  usage: TaskUsage
  /** Current execution id backing this run, when an execution exists. */
  executionId?: string
  /** Resolved dispatch mode of the current execution ('gateway' | 'native'),
   *  when one was recorded. */
  executionMode?: 'native' | 'gateway'
  error?: string | null
  failure_category?: string
  suggestion?: string
  error_message?: string
  has_output?: boolean
  facts?: TaskRunFacts
  pid?: number
  _meta?: JsonRecord
}

export interface TaskRunOutputParams {
  task_run_id: string
}

export interface TaskRunOutputResult {
  task_run_id: string
  task_id: string
  /** Authoritative definition display name when resolvable; optional and
   *  omitted rather than guessed when the registry has no definition. */
  task_name?: string
  status: TaskRunStatus
  summary?: string
  resolved?: TaskResolvedDispatch
  usage: TaskUsage
  output: unknown
  error?: string | null
  failure_category?: string
  suggestion?: string
  error_message?: string
  facts?: TaskRunFacts
  pid?: number
  _meta?: JsonRecord
}

export interface TaskRunWaitParams {
  task_run_id: string
  /**
   * Optional explicit wait deadline (ms). When omitted, task.run.wait waits for
   * the authoritative task terminal with no task-duration deadline. Terminal is
   * defined as done/failed/cancelled/interrupted; a nonterminal result is never
   * returned even when an execution reports terminal first.
   */
  timeout_ms?: number
}

/** Reuses the authoritative complete task run output returned by task.run.output. */
export type TaskRunWaitResult = TaskRunOutputResult

export interface TaskRunCompileParams {
  task_run_id: string
}

/**
 * The result of running the task-output compile step for one existing run.
 * `ok` means `output` is schema-valid; otherwise `compile_error` carries why
 * the compile failed and `report`/`facts` repeat what the run recorded.
 */
export interface TaskRunCompileResult {
  task_run_id: string
  ok: boolean
  /** The schema-valid compiled output; only present when `ok` is true. */
  output?: unknown
  /** Why the compile failed; only present when `ok` is false. */
  compile_error?: string
  report: string
  facts?: TaskRunFacts
}

export interface TaskRunCancelParams {
  task_run_id: string
}

export interface TaskRunCancelResult {
  ok: boolean
  task_run_id: string
  status?: TaskRunStatus | string
  message?: string
}

export interface TaskRunEventsParams {
  task_run_id: string
  after_seq?: number
  limit?: number
}

export interface TaskRunEventItem {
  seq: number
  type: string
  timestamp: string
  data: Record<string, unknown>
  status?: string
  exit_code?: number
  is_error?: boolean
}

export interface TaskRunEventsResult {
  task_run_id: string
  events: TaskRunEventItem[]
  next_seq: number
  has_more: boolean
}
