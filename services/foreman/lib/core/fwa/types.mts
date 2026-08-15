/** Locked native FWA domain contracts. */

import type { TaskGraphStatusResult, TaskGraphEventsResult } from '../taskgraph/contracts.mts'
import type { TaskContext } from '../task/context.mts'

export type FwaSessionStatus = 'idle' | 'running_turn' | 'failed' | 'closed'

export interface FwaTranscriptToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
  type: 'tool_call'
}

export interface FwaTranscriptEntry {
  seq: number
  role: 'human' | 'assistant' | 'tool'
  content: string
  tool_calls?: FwaTranscriptToolCall[]
  tool_call_id?: string
  tool_name?: string
  created_at: string
}

export interface FwaSession {
  id: string
  message_address: string
  ticket_id: string
  project_id: string
  status: FwaSessionStatus
  queue_depth: number
  active_turn_seq?: number
  last_error?: string
  created_at: string
  updated_at: string
  graph_refs: string[]
  task_refs: string[]
}

export type FwaTurnTrigger = 'assign' | 'message' | 'event'

export interface FwaPendingTurn {
  seq: number
  trigger: FwaTurnTrigger
  prompt: string
  created_at: string
}

export interface FwaNativeConfig {
  workspaceRoot: string
  llm: {
    model: string
    turn_timeout_ms: number
    http_timeout_ms?: number
    max_retries?: number
    retry_backoff_ms?: number
  }
}

export interface FwaInspectableQueue {
  pending: Array<{ seq: number; trigger: string; created_at: string }>
}

export interface FwaInspectableStatus {
  session_id: string
  message_address: string
  ticket_id: string
  project_id: string
  status: FwaSessionStatus
  queue_depth: number
  active_turn_seq: number | null
  last_error: string | null
  graph_refs: string[]
  task_refs: string[]
  created_at: string
  updated_at: string
}

/** Callback for instance-local ref persistence within a single runtime/tool set. */
export type ToolRefCallback = (graphRefs: string[], taskRefs: string[]) => Promise<void>

/** A single journal entry from a TaskGraph event stream. */
export interface TaskGraphJournalEntry {
  event_id: string
  taskgraph_id: string
  seq: number
  type: string
  occurred_at: string
  refs?: { task_run_id?: string }
  data: Record<string, unknown>
}

/** Port: service used to dispatch tasks on the shared TaskGraph. */
export interface TaskGraphPort {
  create(params: {
    template: string
    project?: string
    title?: string
    on_node_failure?: 'pause' | 'cancel'
    tg_ctx?: TaskContext
  }): Promise<{ taskgraph: { id: string; revision: number } }>
  signal(params: { taskgraph_id: string; signal: unknown }): Promise<unknown>
  patch(params: { taskgraph_id: string; operation: unknown }): Promise<unknown>
  status(params: { taskgraph_id: string }): Promise<TaskGraphStatusResult>
  events(params: { taskgraph_id: string; after_seq?: number; limit?: number }): Promise<TaskGraphEventsResult>
  inspect(params: { taskgraph_id: string; node_id: string }): Promise<unknown>
}

/** Port: service used to dispatch task runs. */
export interface TaskServicePort {
  run(params: { taskId: string; project?: string; input?: unknown }): Promise<{ task_run_id: string; status: string }>
  describe(params: { task_id: string; project?: string }): Promise<unknown>
  output(params: { task_run_id: string }): Promise<unknown>
  status(params: { task_run_id: string }): Promise<unknown>
  cancel(params: { task_run_id: string }): Promise<unknown>
  list(project?: string): Promise<unknown>
  /** Look up authoritative project metadata for a task run, used for
   *  scope authorization. Returns undefined when the run is unknown. */
  getTaskRun?(params: { task_run_id: string }): Promise<{ task_run_id: string; project?: string } | undefined>
}

/** Port: service used to reply to messages. */
export interface MessagePort {
  reply(params: { to: string; text: string; sender?: { role: string } }): Promise<{ ok: boolean }>
}

/** Port: service used for workspace document operations. */
export interface WorkspaceDocPort {
  read(path: string): Promise<{ content: string } | null>
  write(path: string, content: string): Promise<void>
  create(path: string, content: string): Promise<{ session_id: string }>
  list(dir: string): Promise<string[]>
  delete(path: string): Promise<boolean>
}
