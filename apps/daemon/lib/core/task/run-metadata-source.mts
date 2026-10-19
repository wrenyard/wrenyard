/**
 * Daemon wiring for the task run-metadata projection.
 *
 * `@wrenyard/task` computes the projection purely and takes its IO through an
 * injected port; this module is the only place that binds that port to the
 * daemon's database helpers and TPS readers, which keep their default database
 * behaviour.
 */
import { get, query } from '../../db/connection.mts'
import { readExecutionTpsSamples, readTaskTps } from '../../events/tps.mts'
import type { TaskRunMetadataDeps } from '@wrenyard/task'

export const taskRunMetadataDeps: TaskRunMetadataDeps = {
  store: { get, query },
  readTaskTps,
  readExecutionTpsSamples,
}
