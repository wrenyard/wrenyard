export type {
  ConfigRecord,
  ForemanGatewayConfig,
  ForemanServiceConfig,
  GatewayPortMode,
} from './types.mts'

export {
  normalizeForemanServiceConfig,
  normalizeForemanGatewayConfig,
  type NormalizeForemanConfigOptions,
} from './normalize.mts'

export {
  createDefaultForemanConfigData,
  mergeForemanConfigData,
  type ForemanConfigData,
  type GatewayConfigData,
  type ServiceConfigData,
  type WorkspaceConfigData,
  type TasksConfigData,
} from './data.mts'

export {
  WRENYARD_CONFIG_FILE_NAME as FOREMAN_CONFIG_FILE_NAME,
  resolveWrenyardConfigRoot as resolveForemanConfigDir,
  resolveDefaultWrenyardConfigPath as resolveDefaultForemanConfigPath,
  resolveWrenyardConfigPath as resolveForemanConfigPath,
} from '@wrenyard/paths'

export {
  ForemanConfigManager,
  JsonForemanConfigStore,
  type ForemanConfigStore,
} from './manager.mts'

export {
  loadForemanServiceConfig,
  loadForemanConfigData,
  loadForemanUserConfigData,
  loadForemanGatewayConfig,
  type LoadForemanServiceConfigOptions,
} from './reader.mts'

export {
  updateForemanConfigData,
  updateForemanGatewayConfig,
  type ForemanConfigDataUpdater,
  type ForemanGatewayConfigUpdater,
} from './writer.mts'

export {
  resolveToken,
} from './auth.mts'
