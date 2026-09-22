import type { ForemanConfigData } from './data.mts'
import { ForemanConfigManager } from './manager.mts'
import {
  resolveForemanConfigPath,
  resolveDefaultForemanConfigPath,
  resolveForemanConfigDir,
} from './path.mts'
import type { ForemanServiceConfig } from './types.mts'

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
