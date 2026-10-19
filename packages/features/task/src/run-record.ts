import type {
  RunRecord,
  RunRecordTiming,
  TaskResolvedDispatch,
  TaskUsage,
} from '@wrenyard/protocol'

/**
 * Maps one task run onto the shared run record.
 *
 * The task run row already carries every field the record needs: identity,
 * status, timing, usage and the resolved dispatch. No caller is persisted for a
 * task run, so `caller` stays undefined until one is.
 */
export interface TaskRunRecordInput {
  /** Run record id: the task run id. */
  id: string
  /** Owning task id. */
  taskId: string
  status: string
  timing: RunRecordTiming
  usage: TaskUsage
  /** Resolved dispatch; absent when the run never resolved one. */
  resolved?: TaskResolvedDispatch
  summary?: string
}

/** Builds the task-kind run record for one task run. */
export function toTaskRunRecord(input: TaskRunRecordInput): RunRecord {
  const record: RunRecord = {
    id: input.id,
    kind: 'task',
    taskId: input.taskId,
    status: input.status,
    timing: input.timing,
    usage: input.usage,
  }
  if (input.resolved !== undefined) {
    const effort = input.resolved.reasoningEffort ?? input.resolved.clientReasoningEffort
    record.route = {
      provider: input.resolved.provider,
      model: input.resolved.model,
      ...(effort === undefined ? {} : { effort }),
    }
  }
  if (input.summary !== undefined && input.summary !== '') {
    record.summary = input.summary
  }
  return record
}
