import type { RpcMethod } from '../common/methods.ts'
import type {
  AgentCreateParams,
  AgentCreateResult,
  AgentEventsParams,
  AgentEventsResult,
  AgentGetParams,
  AgentGetResult,
  AgentGroupEventsParams,
  AgentGroupEventsResult,
  AgentGroupSendParams,
  AgentGroupSendResult,
  AgentListParams,
  AgentListResult,
  AgentMemoryListParams,
  AgentMemoryListResult,
  AgentWakeParams,
  AgentWakeResult,
} from './types.ts'

export interface AgentMethods {
  'agent.list': RpcMethod<AgentListParams, AgentListResult>
  'agent.get': RpcMethod<AgentGetParams, AgentGetResult>
  'agent.create': RpcMethod<AgentCreateParams, AgentCreateResult>
  'agent.memory.list': RpcMethod<AgentMemoryListParams, AgentMemoryListResult>
  'agent.events': RpcMethod<AgentEventsParams, AgentEventsResult>
  'agent.wake': RpcMethod<AgentWakeParams, AgentWakeResult>
  'agent.group.events': RpcMethod<AgentGroupEventsParams, AgentGroupEventsResult>
  'agent.group.send': RpcMethod<AgentGroupSendParams, AgentGroupSendResult>
}
