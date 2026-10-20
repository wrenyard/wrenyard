import type { RpcMethod } from '../common/methods.ts'
import type {
  RoutineCreateParams,
  RoutineCreateResult,
  RoutineDeleteParams,
  RoutineDeleteResult,
  RoutineListParams,
  RoutineListResult,
  RoutineRunParams,
  RoutineRunResult,
  RoutineUpdateParams,
  RoutineUpdateResult,
} from './types.ts'

export interface RoutineMethods {
  'routine.list': RpcMethod<RoutineListParams, RoutineListResult>
  'routine.create': RpcMethod<RoutineCreateParams, RoutineCreateResult>
  'routine.update': RpcMethod<RoutineUpdateParams, RoutineUpdateResult>
  'routine.run': RpcMethod<RoutineRunParams, RoutineRunResult>
  'routine.delete': RpcMethod<RoutineDeleteParams, RoutineDeleteResult>
}
