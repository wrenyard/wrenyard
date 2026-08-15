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
}

export function createTaskGraphService(options: CreateTaskGraphServiceOptions): TaskGraphService {
  return new TaskGraphService({
    db: getDb(),
    workspaceRoot: options.workspaceRoot,
    operations: options.operations,
    eventSink: options.eventSink,
    now: options.now,
  })
}
