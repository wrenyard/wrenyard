import type { RpcMethod } from '../common/methods.ts'
import type {
  ClientActionParams,
  ClientActionResult,
  ClientListParams,
  ClientListResult,
} from './types.ts'

export interface ClientMethods {
  'client.list': RpcMethod<ClientListParams, ClientListResult>
  'client.action': RpcMethod<ClientActionParams, ClientActionResult>
}
