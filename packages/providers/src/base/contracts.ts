import type { IntelligenceTier, ModelCapability, ModelPricing, ThinkingLevel } from '@wrenyard/models';
export type { IntelligenceTier, ModelCapability, ModelPricing, ThinkingLevel } from '@wrenyard/models';
export { THINKING_LEVELS } from '@wrenyard/models';

export const GATEWAY_PROTOCOLS = [
  'openai_chat',
  'openai_responses',
  'anthropic_messages',
] as const;

export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number];

// Public thinking levels exposed as a product-owned capability. A level is a
// legal *public* request token; whether a concrete runtime can materialize it is
// decided only by that runtime's ProviderDefinition.thinkingMappings. Levels are
// never inferred lexically from a model id, and an unmapped runtime must not
// have transport invented for it.

// Ordered weak-to-strong; index is the only authority for "highest" selection.
export const THINKING_ORDER: Readonly<Record<ThinkingLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

export const INTELLIGENCE_ORDER: Readonly<Record<IntelligenceTier, number>> = {
  low: 0,
  mid: 1,
  high: 2,
  premium: 3,
};

export type SpeedSource = 'local_31d' | 'provider_override' | 'catalog_default';

export interface SpeedEvidence {
  source: SpeedSource;
  tps: number;
  provider?: string;
  model?: string;
  checkedAt?: string;
  sampleCount?: number;
}

/**
 * Provider-independent identity for an exact, evidence-backed model version.
 * Routes without this metadata remain provider-local; callers must never infer
 * equivalence from a raw provider model id or display label.
 */
export interface CanonicalModelDefinition {
  id: string;
  displayName: string;
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  canonicalModel?: CanonicalModelDefinition;
  contextWindow?: number;
  maxTokens?: number;
  taskOnly?: boolean;
  family?: 'claude';
  claudeTier?: 'haiku' | 'sonnet' | 'opus';
  supports1MContext?: boolean;
  intelligence: IntelligenceTier;
  /** Public thinking levels this model supports. Absent means configurable thinking is not declared; an empty array is rejected at registration. */
  thinkingLevels?: readonly ThinkingLevel[];
  maxOutputTokens?: number;
  /** Supported input types, including image content returned by tools; not output generation. */
  capabilities?: readonly ModelCapability[];
  /** Model-level client restriction: when present, ONLY these client ids may
   * resolve a run for this model (native or gateway). Used for entitlements
   * that are usable solely through a client's genuine transport (e.g. free
   * OpenCode Zen tiers); restricted models are never published through the
   * public gateway model directory. */
  supportedClients?: readonly string[];
  speed: number;
  pricing: ModelPricing;
  /** Provider/account-scoped free entitlement; list pricing remains unchanged. */
  free?: boolean;
}

export interface DispatchCandidate {
  profileId: string;
  client: string;
  provider: string;
  model: string;
}

export interface LocalSpeedSample {
  provider: string;
  model: string;
  tps: number;
  sampleCount: number;
  checkedAt: string;
}

export interface ClientDefinition {
  id: string;
  nativeProvider?: string;
  gatewayProtocols: readonly GatewayProtocol[];
  // Provider-level execution boundaries that cannot be expressed by protocol
  // compatibility alone. A listed provider may still be native to another
  // client, but this client must never receive it as a gateway run.
  unsupportedGatewayProviders?: readonly string[];
  // Task-capable clients are enumerated as derived task dispatch candidates.
  // Parseable public run syntax alone does not make a client task-capable.
  taskCapable?: boolean;
  /** Native provider web search capability. True ONLY when this client can run
   * native web search against its EXACT nativeProvider. It is NOT a claim of
   * third-party gateway web search support: a gateway route — even from a flagged
   * client to a non-native provider — is never marked supported. */
  supportsNativeWebSearch?: boolean;
}

export type PublicGatewayModel = Omit<ModelDefinition, 'canonicalModel'> & {
  provider: string;
  publicId: string;
};

export interface ResolvedGatewayModel {
  provider: ProviderDefinition;
  model: ModelDefinition;
  capability: ProtocolCapability;
  publicId: string;
  upstreamModel: string;
}

export interface DispatchPlan {
  client: string;
  provider: string;
  model: string;
  mode: 'native' | 'gateway';
  protocol?: GatewayProtocol;
  // Native web search is admitted only for an explicitly supported native
  // client/provider pair (client.supportsNativeWebSearch === true AND provider
  // id === client.nativeProvider AND mode native). Gateway and unknown
  // combinations are never marked supported.
  supportsWebSearch?: boolean;
  // Public thinking level this plan was resolved at. Absent means no thinking
  // was requested and/or the model declares no levels; it is never inferred.
  thinking?: ThinkingLevel;
  // Upstream wire effort produced ONLY by an explicit thinking mapping for this
  // runtime. This is a mapped transport value, not policy: no model- or
  // client-level fixed effort policy exists.
  reasoningEffort?: string;
  // Upstream model substitution produced ONLY by an explicit thinking mapping.
  // The public model id is always propagated unchanged.
  upstreamModel?: string;
}

// Public dynamic run-target syntax (provider/model:client). These helpers are the
// single source of truth for the public client-key table and the strict parse/format
// contract for the syntax. Catalog remains the only compatibility resolver: a
// parseable identity is not proof that a client can actually run the target.

export interface RunSyntaxRef {
  readonly client: string;
  readonly provider: string;
  readonly model: string;
}

export const PUBLIC_CLIENT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  cc: 'claude',
  cb: 'codebuddy',
  codex: 'codex',
  cur: 'cursor',
  gk: 'grok',
  dsh: 'dsh',
  oc: 'opencode',
});

export type ProviderAuthScheme = 'bearer' | 'x-api-key';
export type CredentialResolver =
  | 'managed'
  | 'codebuddy'
  | 'codex'
  | 'claude'
  | 'grok-oauth'
  | 'cursor';

// A concrete runtime materialization for one thinking level: an optional
// upstream-model substitution and/or an optional wire effort alias. This is the
// only place a runtime may express how a level is realized.
export interface ThinkingMapping {
  model?: string;
  effort?: string;
}

export type ProviderThinkingMappings = Readonly<
  Record<string, Readonly<Record<string, Partial<Record<ThinkingLevel, ThinkingMapping>>>>>
>;

export interface ProtocolCapability {
  protocol: GatewayProtocol;
  endpoint: string;
  authScheme: ProviderAuthScheme;
  upstreamModels?: Readonly<Record<string, string>>;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  description?: string;
  setupHint?: string;
  models: readonly ModelDefinition[];
  nativeClients?: readonly string[];
  protocols?: readonly ProtocolCapability[];
  modelAliases?: Readonly<Record<string, string>>;
  // Canonical model speed overrides keyed by exact declared model id; alias keys
  // and unknown model keys are rejected at registration.
  modelSpeedOverrides?: Readonly<Record<string, number>>;
  // Per-runtime thinking materializations, keyed model id then client id then
  // thinking level. The presence of an entry is the only claim that a runtime
  // explicitly supports realizing that level; absent means capability unknown,
  // and no transport is ever invented. Keys and values are validated at
  // registration against the exact declared model ids and legal levels.
  thinkingMappings?: ProviderThinkingMappings;
  credentialResolver: CredentialResolver;
  defaultModel?: string;
  quotaProvider?: string;
  useClientBinary?: boolean;
}

