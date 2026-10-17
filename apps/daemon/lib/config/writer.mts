import type { ForemanConfigData } from './data.mts'
import { ForemanConfigManager } from './manager.mts'
import { normalizeForemanGatewayConfig } from './normalize.mts'
import type { ForemanGatewayConfig } from './types.mts'

export type ForemanConfigDataUpdater = (data: ForemanConfigData) => void

export function updateForemanConfigData(
  configPath: string | undefined,
  update: ForemanConfigDataUpdater,
  options?: { env?: NodeJS.ProcessEnv },
): void {
  const manager = new ForemanConfigManager(options?.env ? { env: options.env } : undefined)
  manager.updateUserData(configPath, update)
}

export type ForemanGatewayConfigUpdater = (gateway: ForemanGatewayConfig) => ForemanGatewayConfig

/**
 * Persist a gateway settings change. The current value and the updated value are
 * both re-normalized through the same normalizer the read path uses, so the
 * stored document always matches the shape `loadForemanGatewayConfig` returns
 * and unrelated configuration is preserved. The write is atomic with mode 0600
 * and the token value is never logged.
 */
export function updateForemanGatewayConfig(
  configPath: string | undefined,
  update: ForemanGatewayConfigUpdater,
  options?: { env?: NodeJS.ProcessEnv },
): void {
  const manager = new ForemanConfigManager(options?.env ? { env: options.env } : undefined)
  manager.updateGatewayData(configPath, (current) => {
    const next = normalizeForemanGatewayConfig(update(normalizeForemanGatewayConfig(current)))
    return {
      portMode: next.portMode,
      ...(next.port === undefined ? {} : { port: next.port }),
      ...(next.token === undefined ? {} : { token: next.token }),
    }
  })
}
