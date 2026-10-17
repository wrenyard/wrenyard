export type ConfigRecord = Record<string, unknown>

/** How the gateway chooses the loopback port it binds. */
export type GatewayPortMode = 'random' | 'fixed'

/**
 * Persisted top-level gateway access settings. `portMode` defaults to `random`;
 * a `fixed` mode carries the validated TCP port the next bind must use. `token`
 * is the persisted gateway credential, generated once with a CSPRNG and reused
 * across restarts. The token is a secret and must never be logged.
 */
export type ForemanGatewayConfig = {
  portMode: GatewayPortMode
  /** Configured fixed port; present only when `portMode` is `fixed`. */
  port?: number
  /** Persisted gateway token; absent until the daemon first generates one. */
  token?: string
}

export interface ForemanServiceConfig {
  service: {
    enabled: boolean
    ipc?: {
      path?: string
    }
  }
  gateway: ForemanGatewayConfig
  workspaceRoot: string
}
