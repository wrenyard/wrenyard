import type { ProviderListModel } from '../provider/types.ts'

/** USD per million tokens: [cached, input, output]. */
export type GatewayModelPricing = readonly [number, number, number];

/** The Gateway protocol entry points a model may be served through. */
export type GatewayProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

export interface GatewayModel {
  /** The registered model identity. It is never a provider-qualified id and
   * never an upstream wire spelling. */
  id: string;
  /** Internal provider-scoped route key (`provider/id`) used for route health,
   * quota and statistics. Provider selection is a separate dimension. */
  publicId: string;
  provider: string;
  /**
   * The Gateway protocols this exact model supports, not the provider's blanket
   * capabilities. A session selects its adapter from this list, by precedence
   * Chat → Responses → Messages.
   */
  protocols: readonly GatewayProtocol[];
  displayName: string;
  contextWindow?: number;
  maxTokens?: number;
  taskOnly?: boolean;
  family?: 'claude';
  claudeTier?: 'haiku' | 'sonnet' | 'opus';
  supports1MContext?: boolean;
  /** True when a verified, distinct upstream Fast mode exists for this route. */
  supportsFast?: boolean;
  /** Catalog intelligence tier; absent when genuinely unknown (a route naming
   * no registered canonical model). */
  intelligence?: 'low' | 'mid' | 'high' | 'premium';
  maxOutputTokens?: number;
  capabilities?: readonly ('text' | 'image')[];
  /**
   * The legal reasoning efforts this model accepts, in ascending intensity.
   * Replaces the legacy fixed `reasoningEffort` field on the public gateway
   * contract; absent when the model's ladder is unknown.
   */
  reasoningEfforts?: ProviderListModel['reasoningEfforts'];
  routeState?: 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'access_denied' | 'model_unavailable';
  routeUntil?: string;
  /** Circuit phase of the route; absent while the route is healthy. */
  routePhase?: 'closed' | 'open';
  /** The fault kind behind the route's block, when the Gateway knows it. */
  faultKind?: string;
  speed?: number;
  pricing?: GatewayModelPricing;
}

export interface GatewayConnection {
  openaiChatBaseUrl: string;
  openaiResponsesBaseUrl: string;
  anthropicBaseUrl: string;
  token: string;
  models: GatewayModel[];
}

/** How the gateway chooses the loopback port it binds. */
export type GatewayPortMode = 'random' | 'fixed';

/** The gateway connection the running daemon currently serves (bind-time). */
export interface GatewayEffectiveConnection {
  host: string;
  port: number;
  openaiChatBaseUrl: string;
  openaiResponsesBaseUrl: string;
  anthropicBaseUrl: string;
  /** The token the running daemon accepts right now. */
  token: string;
}

/**
 * Persisted gateway access settings plus the effective connection. The saved
 * port choice is what the next bind will use; `effective` is what the running
 * daemon serves right now. `tokenSaved` reports whether a token is persisted
 * without returning its value, and the pending flags say whether a saved port
 * or token change has not yet taken effect.
 */
export interface GatewaySettings {
  savedPortMode: GatewayPortMode;
  savedPort?: number;
  tokenSaved: boolean;
  portChangePending: boolean;
  tokenChangePending: boolean;
  effective: GatewayEffectiveConnection;
}

/** Port choice for a save; `fixed` requires a validated 1–65535 TCP port. */
export type GatewayPortChoice =
  | { mode: 'random' }
  | { mode: 'fixed'; port: number };

/** Persisted-token replacement: a caller-supplied value or a fresh generated one. */
export type GatewayTokenReplacement =
  | { kind: 'custom'; token: string }
  | { kind: 'generate' };

export interface GatewaySettingsSaveInput {
  /** Omit to keep the saved port choice unchanged. */
  port?: GatewayPortChoice;
  /** Omit to keep the persisted token unchanged. */
  token?: GatewayTokenReplacement;
  /** Explicit acknowledgement required before any token replacement. */
  confirmTokenReplacement?: boolean;
}

export interface GatewaySettingsSaveResult extends GatewaySettings {
  ok: true;
  /**
   * Present when a token replacement was persisted: the running gateway keeps
   * the previous token until the next bind, after which existing external
   * clients must update their credentials.
   */
  warning?: string;
}

/** Params of `gateway.connection` (empty object). */
export interface GatewayConnectionParams {}

/** Params of `gateway.settings` (empty object). */
export interface GatewaySettingsParams {}

/** Per-route block state returned with gateway health snapshots. */
export type GatewayRouteState =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_failed'
  | 'access_denied'
  | 'model_unavailable'

/** Current route-state block for one route, when the gateway reports one. */
export interface GatewayRouteStatus {
  state: GatewayRouteState
  until: string
  phase?: 'closed' | 'open'
  resets?: boolean
  faultKind?: string
}

/** Aggregated request figures for one health time window. */
export interface GatewayHealthWindow {
  requests: number
  successes: number
  failures: Record<string, number>
  cancelled: number
  callerErrors: number
  admissionRefusals: number
  medianFirstResponseMs?: number
  medianTps?: number
  lastSuccessAt?: string
  lastFailure?: { at: string; class: string; reason: string }
}

export interface GatewayHealthRoute {
  provider: string
  model: string
  last1h: GatewayHealthWindow
  last24h: GatewayHealthWindow
  routeState?: GatewayRouteStatus
}

/** Params of `gateway.health` (empty object). */
export interface GatewayHealthParams {}

/** Passive per-route gateway health snapshot. */
export interface GatewayHealthResult {
  generatedAt: string
  routes: GatewayHealthRoute[]
}
