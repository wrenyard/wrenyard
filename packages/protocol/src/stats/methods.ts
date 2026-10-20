import type { RpcMethod } from '../common/methods.ts'
import type {
  StatsSummaryParams,
  StatsSummaryResult,
  StatsTodayParams,
  StatsTodayResult,
} from './types.ts'

export interface StatsMethods {
  'stats.today': RpcMethod<StatsTodayParams, StatsTodayResult>
  'stats.summary': RpcMethod<StatsSummaryParams, StatsSummaryResult>
}
