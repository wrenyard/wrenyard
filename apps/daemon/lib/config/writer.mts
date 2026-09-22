import type { ForemanConfigData } from './data.mts'
import { ForemanConfigManager } from './manager.mts'

export type ForemanConfigDataUpdater = (data: ForemanConfigData) => void

export function updateForemanConfigData(
  configPath: string | undefined,
  update: ForemanConfigDataUpdater,
  options?: { env?: NodeJS.ProcessEnv },
): void {
  const manager = new ForemanConfigManager(options?.env ? { env: options.env } : undefined)
  manager.updateUserData(configPath, update)
}
