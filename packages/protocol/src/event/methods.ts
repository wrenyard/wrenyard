import type { RpcMethod } from '../common/methods.ts'
import type { EventListParams, EventListResult } from './types.ts'

export interface EventMethods {
  'event.list': RpcMethod<EventListParams, EventListResult>
}
