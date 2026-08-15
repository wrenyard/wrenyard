export type RuntimeOperationName = 'agent' | 'shell' | 'llm'
export type DomainOperationName = 'task'
export type ControlOperationName = 'checkpoint'
export type OperationName = DomainOperationName | RuntimeOperationName | ControlOperationName

export type OperationKind = 'domain' | 'runtime' | 'control'

export interface OperationDescriptor {
  name: OperationName
  kind: OperationKind
  description: string
}

export type AgentRuntimePermission = 'readonly' | 'edit' | 'yolo'
export type ClientFamily = 'claude' | 'codex' | 'opencode'
export type ExecutionStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'interrupted'

export interface StartAgentExecutionOptions {
  taskId?: string
  profile: string
  permission: AgentRuntimePermission
  cwd: string
  prompt: string
  resume?: string
  timeoutMs?: number
  clientFamily?: ClientFamily
  /** Normalized agent runtime string ('<runtime>/<config-id>') carried from the
   *  task definition. Null for historical/legacy executions that predate this field. */
  requestedAgentRuntime?: string
  /** Selected Forge capability ids passed to the agent at launch. */
  capabilities?: readonly string[]
  /** Canonical exact file paths for file-scoped edit admission. Undefined or
   *  empty retains conservative repo-wide write locking. */
  writePaths?: readonly string[]
}

export interface ExecutionResult {
  executionId: string
  status: ExecutionStatus
  output?: string | null
  error?: string | null
  exitCode?: number | null
  killReason?: string | null
}

export interface ExecutionHandle {
  executionId: string
  pid?: number
  wait(): Promise<ExecutionResult>
  cancel(): Promise<void>
}

export interface ExecutionRecord {
  id: string
  task_id: string | null
  profile: string
  permission: AgentRuntimePermission
  cwd: string
  prompt: string
  status: ExecutionStatus
  native_session_id: string | null
  client_family: ClientFamily | null
  pid: number | null
  pgid: number | null
  output: string | null
  raw_result: string | null
  error: string | null
  exit_code: number | null
  kill_reason: string | null
  timeout_ms: number | null
  requested_agent_runtime?: string | null
  resolved_profile?: string | null
}

export interface AgentExecutionHost {
  startExecution(opts: StartAgentExecutionOptions): Promise<ExecutionHandle>
  waitExecution(executionId: string): Promise<ExecutionResult>
  getExecution(executionId: string): ExecutionRecord | undefined
  cancelExecution(executionId: string): Promise<void>
}

export interface TaskRunAcceptedHandle {
  id: string
  task_run_id: string
  hint: string
}

export interface StartTaskRunOptions {
  definitionName: string
  taskName: string
  project: string
  executionProject: string
  input: unknown
  workspaceRoot: string
  workingDirectory: string
  worktree?: string
  connectingId?: string
  /** Bounded JSON-safe context injected separately from definition input. */
  taskContext?: import('../task/context.mts').TaskContext
  /** Authoritative resolved definition provenance. Absent for legacy/direct
   *  callers that predate source threading; never guessed from project/id. */
  source?: 'builtin' | 'project'
  /** Internal-only delegation admission descriptor for Work-created tasks. */
  delegationAdmission?: {
    address: string
    turn_seq: number
    delegation_id: string
    tool_name: string
    input: Record<string, unknown>
  }
}

export interface TaskWorkflowRunHost {
  startTaskRun(opts: StartTaskRunOptions): Promise<TaskRunAcceptedHandle>
  cancelTaskRun(taskRunId: string): Promise<Record<string, unknown>>
}

export interface OperationHost {
  agent?: AgentExecutionHost
  runner?: TaskWorkflowRunHost
}
