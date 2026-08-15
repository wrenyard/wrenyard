export type KnownForemanEventKind =
  | 'task.run.started'
  | 'task.run.completed'
  | 'task.run.failed'
  | 'task.run.progress'
  | 'workflow.run.started'
  | 'workflow.run.completed'
  | 'workflow.run.failed'
  | 'workflow.run.checkpointed'

export type ForemanEventKind = KnownForemanEventKind | (string & {})

export type ForemanEventSeverity = 'info' | 'success' | 'warning' | 'error'

export interface ForemanEventRefs {
  executionId?: string
  taskId?: string
  taskRunId?: string
  workflowId?: string
  taskgraphId?: string
  sessionId?: string
  project?: string
  connectionId?: string
}

export interface ForemanEvent {
  id: string
  kind: ForemanEventKind
  source: string
  severity: ForemanEventSeverity
  refs: ForemanEventRefs
  data?: Record<string, unknown>
  occurredAt: string
}

export interface ForemanEventSink {
  handle(event: ForemanEvent): void | Promise<void>
}
