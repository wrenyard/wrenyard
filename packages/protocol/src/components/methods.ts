import type { RpcMethod } from '../common/methods.ts'
import type {
  ComponentsActionParams,
  ComponentsActionResult,
  ComponentsListParams,
  ComponentsListResult,
} from './types.ts'

export interface ComponentsMethods {
  'components.list': RpcMethod<ComponentsListParams, ComponentsListResult>
  'components.action': RpcMethod<ComponentsActionParams, ComponentsActionResult>
}
