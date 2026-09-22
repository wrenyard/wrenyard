import type { RpcMethod } from '../common/methods.ts'
import type {
  ProviderListParams, ProviderListResult,
  ProviderConfigureParams, ProviderConfigureResult,
  ProviderQuotaParams, ProviderQuotaResult,
} from './types.ts'

export interface ProviderMethods {
  'provider.list': RpcMethod<ProviderListParams, ProviderListResult>
  'provider.configure': RpcMethod<ProviderConfigureParams, ProviderConfigureResult>
  'provider.quota': RpcMethod<ProviderQuotaParams, ProviderQuotaResult>
}