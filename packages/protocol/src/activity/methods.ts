import type { RpcMethod } from '../common/methods.ts'
import type { ActivitySnapshotParams, ActivitySnapshotV1 } from './types.ts'

export interface ActivityMethods {
  'activity.snapshot': RpcMethod<ActivitySnapshotParams, ActivitySnapshotV1>
}
