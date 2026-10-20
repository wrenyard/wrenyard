import type { RpcMethod } from '../common/methods.ts'
import type {
  GatewayConnection,
  GatewayConnectionParams,
  GatewaySettings,
  GatewaySettingsParams,
  GatewaySettingsSaveInput,
  GatewaySettingsSaveResult,
} from './types.ts'

export interface GatewayMethods {
  'gateway.connection': RpcMethod<GatewayConnectionParams, GatewayConnection>
  'gateway.settings': RpcMethod<GatewaySettingsParams, GatewaySettings>
  'gateway.settings.save': RpcMethod<GatewaySettingsSaveInput, GatewaySettingsSaveResult>
}
