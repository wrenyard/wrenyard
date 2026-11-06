import type { ReasoningEffort } from '@wrenyard/models'

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

/**
 * One standard Chat endpoint. `url` is the complete Chat Base URL; `token` is
 * the bearer credential sent to it. When configured, the daemon builds its
 * connection from this endpoint instead of the built-in gateway.
 */
export type ForemanEndpointConfig = {
  url: string
  token: string
}

/**
 * One determined auxiliary model. `model` is the endpoint's own model id, sent
 * unchanged; `reasoningEffort` is the level auxiliary calls request.
 */
export type ForemanAuxiliaryModelConfig = {
  model: string
  reasoningEffort: ReasoningEffort
}

/**
 * One determined worker model. `model` is the endpoint's own model id, sent
 * unchanged; `reasoningEffort` is the level worker runs request.
 */
export type ForemanWorkerModelConfig = {
  model: string
  reasoningEffort: ReasoningEffort
}

/** Model-purpose settings that apply beside a configured endpoint. */
export type ForemanModelsConfig = {
  auxiliary?: ForemanAuxiliaryModelConfig
  worker?: ForemanWorkerModelConfig
}

export interface ForemanServiceConfig {
  service: {
    enabled: boolean
    ipc?: {
      path?: string
    }
  }
  gateway: ForemanGatewayConfig
  endpoint?: ForemanEndpointConfig
  models?: ForemanModelsConfig
  workspaceRoot: string
}
