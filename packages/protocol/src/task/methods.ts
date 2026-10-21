import type { RpcMethod } from '../common/methods.ts'
import type {
  TaskDefinitionDescribeParams,
  TaskDefinitionDescribeResult,
  TaskDefinitionListParams,
  TaskDefinitionListResult,
} from './definitions.ts'
import type {
  TaskRunCancelParams,
  TaskRunCancelResult,
  TaskRunCompileParams,
  TaskRunCompileResult,
  TaskRunCreateParams,
  TaskRunCreateResult,
  TaskRunEventsParams,
  TaskRunEventsResult,
  TaskRunListParams,
  TaskRunListResult,
  TaskRunOutputParams,
  TaskRunOutputResult,
  TaskRunStatusParams,
  TaskRunStatusResult,
  TaskRunWaitParams,
  TaskRunWaitResult,
} from './runs.ts'
import type {
  TaskRoutingTestParams,
  TaskRoutingTestResult,
  TaskRoutingTestTasksParams,
  TaskRoutingTestTasksResult,
  TaskSettingsSaveParams,
  TaskSettingsSaveResult,
  TaskSettingsSnapshotParams,
  TaskSettingsSnapshotResult,
} from './settings.ts'

export interface TaskMethods {
  'task.definition.list': RpcMethod<TaskDefinitionListParams, TaskDefinitionListResult>
  'task.definition.describe': RpcMethod<TaskDefinitionDescribeParams, TaskDefinitionDescribeResult>
  'task.settings.snapshot': RpcMethod<TaskSettingsSnapshotParams, TaskSettingsSnapshotResult>
  'task.settings.save': RpcMethod<TaskSettingsSaveParams, TaskSettingsSaveResult>
  'task.settings.routingTest': RpcMethod<TaskRoutingTestParams, TaskRoutingTestResult>
  'task.settings.routingTestTasks': RpcMethod<TaskRoutingTestTasksParams, TaskRoutingTestTasksResult>
  'task.run.create': RpcMethod<TaskRunCreateParams, TaskRunCreateResult>
  'task.run.list': RpcMethod<TaskRunListParams, TaskRunListResult>
  'task.run.status': RpcMethod<TaskRunStatusParams, TaskRunStatusResult>
  'task.run.output': RpcMethod<TaskRunOutputParams, TaskRunOutputResult>
  'task.run.compile': RpcMethod<TaskRunCompileParams, TaskRunCompileResult>
  'task.run.wait': RpcMethod<TaskRunWaitParams, TaskRunWaitResult>
  'task.run.cancel': RpcMethod<TaskRunCancelParams, TaskRunCancelResult>
  'task.run.events': RpcMethod<TaskRunEventsParams, TaskRunEventsResult>
}
