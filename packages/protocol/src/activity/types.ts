export interface ActivitySnapshotParams {
  /** Taskgraph ids the client still holds from the previous round; deduplicated, at most 128. */
  tracked_taskgraph_ids?: string[]
}

export interface ActivitySnapshotTask {
  task_run_id: string
  status: 'queued' | 'running'
  task_id?: string
  task_label?: string
  project?: string
  worktree?: boolean
  requested_agent_runtime?: string
  resolved_profile?: string
  created_at: string
  updated_at: string
  /** 1-based desktop-lane queue position; present only while the run waits. */
  queuePosition?: number
  taskgraph_id?: string
  node_id?: string
}

export type ActivitySnapshotNodeState =
  | 'planned'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export type ActivitySnapshotTaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ActivitySnapshotGraphState =
  | 'created'
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled'

export type ActivitySnapshotTerminalReason = 'success' | 'node_failed' | 'cancelled'

export interface ActivitySnapshotNode {
  node_id: string
  state: ActivitySnapshotNodeState
  task_run_id?: string
  task_status?: ActivitySnapshotTaskStatus
  /** Authoritative resolved task definition name (e.g. 'commit'); from the slip, omitted for legacy nodes. */
  task_id?: string
  task_category?: { id: string; display_label: string }
  display_label?: string
  description?: string
  requested_agent_runtime?: string
  resolved_profile?: string
  tool_call_count?: number
  tps?: number
  summary?: string
  /** Node wall-clock duration in integer milliseconds; running nodes are sampled to the read time, terminal nodes are frozen at completion. */
  runtime_ms?: number
}

export interface ActivitySnapshotTaskgraph {
  taskgraph_id: string
  state: ActivitySnapshotGraphState
  title?: string
  project?: string
  on_node_failure: 'pause' | 'cancel'
  cancel_requested: boolean
  structure_revision: number
  latest_seq: number
  terminal_reason?: ActivitySnapshotTerminalReason
  node_counts: Record<ActivitySnapshotNodeState, number>
  active: { running: string[]; waiting: string[] }
  nodes: ActivitySnapshotNode[]
}

export interface ActivitySnapshotV1 {
  schema_version: 'foreman.activity.snapshot.v1'
  sampled_at: string
  tasks: ActivitySnapshotTask[]
  taskgraphs: ActivitySnapshotTaskgraph[]
}
