import type { RpcMethod } from '../common/methods.ts'
import type {
  DaemonShutdownParams,
  DaemonShutdownResult,
  DaemonStatusParams,
  DaemonStatusResult,
  HealthPingParams,
  HealthPingResult,
} from './types.ts'

export interface DaemonMethods {
  'daemon.status': RpcMethod<DaemonStatusParams, DaemonStatusResult>
  'daemon.shutdown': RpcMethod<DaemonShutdownParams, DaemonShutdownResult>
  'health.ping': RpcMethod<HealthPingParams, HealthPingResult>
}
