import type { ReasoningEffort } from '@wrenyard/models'

/** USD per million tokens: [cached, input, output]. */
export type GatewayModelPricing = readonly [number, number, number];

/** The Gateway protocol entry points a model may be served through. */
export type GatewayProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

export interface GatewayModel {
  /** The registered model identity. It is never a provider-qualified id and
   * never an upstream wire spelling. */
  id: string;
  /** Provider-qualified public identity (`provider/id`), also the key for
   * route health, quota and statistics. The protocol `/models` listing publishes
   * it as the model id and the session transport sends it verbatim. */
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
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities?: readonly ('text' | 'image')[];
  /** Full input modalities this route accepts, including values outside the
   * product's `ModelCapability` subset. Absent when no source declares them. */
  inputModalities?: readonly string[];
  /**
   * The legal reasoning efforts this model accepts, in ascending intensity.
   * Replaces the legacy fixed `reasoningEffort` field on the public gateway
   * contract; absent when the model's ladder is unknown.
   */
  reasoningEfforts?: readonly ReasoningEffort[] | undefined;
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
