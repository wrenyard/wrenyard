import type { ForemanConfigData } from './data.mts'
import { ForemanConfigManager } from './manager.mts'
import {
  resolveWrenyardConfigPath as resolveForemanConfigPath,
  resolveDefaultWrenyardConfigPath as resolveDefaultForemanConfigPath,
  resolveWrenyardConfigRoot as resolveForemanConfigDir,
} from '@wrenyard/paths'
import type { ForemanGatewayConfig, ForemanServiceConfig } from './types.mts'

export { resolveForemanConfigPath, resolveDefaultForemanConfigPath, resolveForemanConfigDir }

export interface LoadForemanServiceConfigOptions {
  env?: NodeJS.ProcessEnv
  configPath?: string
}

export function loadForemanServiceConfig(
  configPath?: string,
  options: LoadForemanServiceConfigOptions = {},
): ForemanServiceConfig {
  const manager = new ForemanConfigManager(options.env ? { env: options.env } : undefined)
  return manager.loadServiceConfig(configPath ?? options.configPath).config
}

/**
 * Read the normalized top-level gateway settings (port mode/choice and the
 * persisted token). `random` is the default, so a config without any gateway
 * fields reads back as random mode; callers that need the effective connection
 * combine this with the running daemon's bind-time state.
 */
export function loadForemanGatewayConfig(
  configPath?: string,
  options: LoadForemanServiceConfigOptions = {},
): ForemanGatewayConfig {
  return loadForemanServiceConfig(configPath, options).gateway
}

export function loadForemanConfigData(
  configPath?: string,
  options?: LoadForemanServiceConfigOptions,
): ForemanConfigData {
  const manager = new ForemanConfigManager(options?.env ? { env: options.env } : undefined)
  return manager.loadData(configPath).data
}

export function loadForemanUserConfigData(
  configPath?: string,
  options?: LoadForemanServiceConfigOptions,
): ForemanConfigData {
  const manager = new ForemanConfigManager(options?.env ? { env: options.env } : undefined)
  return manager.loadUserData(configPath).data
}
