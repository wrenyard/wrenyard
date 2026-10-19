import type {
  AuxiliaryRunRecordInput,
  RunRecord,
  RunRecordRoute,
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

/**
 * Maps one auxiliary run onto the shared run record.
 *
 * An auxiliary run has no task id and a known caller session, so it is tagged
 * `kind: 'auxiliary'` with its role and the owning session as the caller. The
 * resolved route, status, timing, usage and summary are carried verbatim; the
 * wire/database layers decide how much of that to project.
 */
export function toAuxiliaryRunRecord(input: AuxiliaryRunRecordInput): RunRecord {
  const record: RunRecord = {
    id: input.id,
    kind: 'auxiliary',
    role: input.role,
    caller: { origin: 'session', id: input.callerSessionId },
    status: input.status,
    timing: {
      createdAt: input.startedAt,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    },
  }
  if (input.route !== undefined) {
    const route: RunRecordRoute = {}
    if (input.route.provider !== undefined && input.route.provider !== '') route.provider = input.route.provider
    if (input.route.model !== undefined && input.route.model !== '') route.model = input.route.model
    if (input.route.effort !== undefined && input.route.effort !== '') route.effort = input.route.effort
    if (route.provider !== undefined || route.model !== undefined || route.effort !== undefined) {
      record.route = route
    }
  }
  if (input.usage !== undefined) record.usage = input.usage
  if (input.summary !== undefined && input.summary !== '') record.summary = input.summary
  return record
}
