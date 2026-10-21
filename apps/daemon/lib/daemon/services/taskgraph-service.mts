import type { OperationHost } from '../../core/operations/types.mts'
import {
  TaskGraphService,
  type TaskGraphEvent,
  type TaskGraphServiceOptions,
} from '../../core/taskgraph/index.mts'
import { getDb } from '../../db/connection.mts'

export interface CreateTaskGraphServiceOptions {
  workspaceRoot: string
  operations?: OperationHost
  eventSink?: TaskGraphServiceOptions['eventSink']
  now?: TaskGraphServiceOptions['now']
  /** Task-output compile step; task nodes with an output schema compile the
   *  run's report and facts through it. Optional so contexts without the
   *  daemon-wired step keep their existing behavior. */
  taskOutputCompile?: TaskGraphServiceOptions['taskOutputCompile']
}

export function createTaskGraphService(options: CreateTaskGraphServiceOptions): TaskGraphService {
  return new TaskGraphService({
    db: getDb(),
    workspaceRoot: options.workspaceRoot,
    operations: options.operations,
    eventSink: options.eventSink,
    now: options.now,
    ...(options.taskOutputCompile === undefined ? {} : { taskOutputCompile: options.taskOutputCompile }),
  })
}
