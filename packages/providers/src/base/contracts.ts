import type { IntelligenceTier, ModelCapability, ModelPricing, ReasoningEffort } from '@wrenyard/models';
import type { GatewayRoutePhase, GatewayRouteState } from './gateway-wire.ts';
export type { IntelligenceTier, ModelCapability, ModelPricing, ReasoningEffort } from '@wrenyard/models';
export { PROVIDER_DEFAULT_REASONING, REASONING_EFFORTS, resolveReasoningEffort } from '@wrenyard/models';

export const GATEWAY_PROTOCOLS = [
  'openai_chat',
  'openai_responses',
  'anthropic_messages',
] as const;

export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number];

// Public reasoning effort levels exposed as a product-owned capability. A level
// is a legal *public* request token; whether a concrete runtime can materialize
// it is decided only by that runtime's ProviderDefinition.reasoningEffortMappings
// and convertReasoningEffort. Levels are never inferred lexically from a model
// id, and an unmapped runtime must not have transport invented for it.

export const INTELLIGENCE_ORDER: Readonly<Record<IntelligenceTier, number>> = {
  low: 0,
  mid: 1,
  high: 2,
  premium: 3,
};

export type SpeedSource = 'local_31d' | 'provider_override' | 'catalog_default';

export interface SpeedEvidence {
  source: SpeedSource;
  /** TPS of the authoritative evidence tier. Required whenever evidence exists:
   * a genuinely unknown speed omits the whole evidence object instead of
   * reporting a fabricated 0. */
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
  /** Catalog intelligence tier. Required and complete for a registered canonical
   * model. A route whose model names no registered canonical model leaves this
   * absent: the tier is genuinely unknown and is never defaulted or invented. */
  intelligence?: IntelligenceTier;
  /** Route-owned reasoning efforts this model can materialize. Required array:
   * every registered route declares its own ladder, and a route whose model
   * names no registered canonical model declares an EMPTY array, meaning
   * "unknown / no selectable ladder" — an absent ladder is never inferred from
   * the registry or a model id. */
  reasoningEfforts: readonly ReasoningEffort[];
  maxOutputTokens?: number;
  /** Supported input types, including image content returned by tools; not output generation. */
  capabilities?: readonly ModelCapability[];
  /** Model-level client restriction: when present, ONLY these client ids may
   * resolve a run for this model (native or gateway). Used for entitlements
   * that are usable solely through a client's genuine transport (e.g. free
   * OpenCode Zen tiers); restricted models are never published through the
   * public gateway model directory. */
  supportedClients?: readonly string[];
  /** Catalog default TPS. Required for a registered canonical model. A route
   * whose model names no registered canonical model leaves this absent: the
   * speed is genuinely unknown and is never reported as 0. */
  speed?: number;
  /** Catalog list price. Required for a registered canonical model. A route
   * whose model names no registered canonical model leaves this absent: the
   * price is genuinely unknown and is never defaulted to zero. */
  pricing?: ModelPricing;
  /** Provider/account-scoped free entitlement; list pricing remains unchanged. */
  free?: boolean;
  /** CodeBuddy per-model credit multiplier string carried verbatim from the live
   * `/v3/config` offering (e.g. `x1.33 credits`). A display-only cost
   * multiplier, never a balance, USD price or percentage. */
  readonly credits?: string;
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
  forwardsGatewayReasoningEffort?: boolean;
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

/** A supplier interprets only its own explicit error codes and reset information. */
export interface UpstreamRouteFailure {
  state: GatewayRouteState;
  scope?: 'provider' | 'pool' | 'route';
  quotaPoolId?: string;
  until?: string;
}
export interface UpstreamRouteErrorInput {
  modelId: string;
  status: number;
  headers: Headers;
  body: unknown;
  nowMs: number;
}

export type PublicGatewayModel = Omit<ModelDefinition, 'canonicalModel'> & {
  provider: string;
  publicId: string;
  /** Entry protocols this exact model is served on. Required and non-empty:
   * the public directory is protocol-independent and every entry declares where
   * it is reachable, so a consumer never re-derives protocol ownership from a
   * provider definition. */
  protocols: readonly GatewayProtocol[];
  routeState?: GatewayRouteState;
  routeUntil?: string;
  /** Circuit phase of the route; absent when the route is healthy. */
  routePhase?: GatewayRoutePhase;
  /** When a half-open recovery probe may next be admitted for the route. */
  routeNextProbeAt?: string;
  /** The fault kind behind the route's block, when known. */
  faultKind?: string;
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
  // Public reasoning effort this plan was resolved at. Absent only for catalog
  // enumeration; an explicit request always resolves to a level.
  reasoningEffort?: ReasoningEffort;
  // Upstream wire effort alias produced ONLY by an explicit effort mapping for
  // this runtime. This is a mapped transport value, not policy.
  clientReasoningEffort?: string;
  clientReasoningEnvironment?: Readonly<Record<string, string>>;
  // Upstream model substitution produced ONLY by an explicit effort mapping.
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

// A concrete runtime materialization for one reasoning effort: an optional
// upstream-model substitution and/or an optional wire effort alias. This is the
// only place a runtime may express how a level is realized.
export interface ReasoningEffortMapping {
  environment?: Readonly<Record<string, string>>;
  model?: string;
  effort?: string;
}

export type ProviderReasoningEffortMappings = Readonly<
  Record<string, Readonly<Record<string, Partial<Record<ReasoningEffort, ReasoningEffortMapping>>>>>
>;

export interface ProtocolCapability {
  protocol: GatewayProtocol;
  endpoint: string;
  authScheme: ProviderAuthScheme;
  upstreamModels?: Readonly<Record<string, string>>;
}

/** Client request headers supplied to a request hook, unmodified. */
export type ProviderRequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Everything a supplier request hook may need to reproduce its own wire
 * contract. The Gateway supplies it generically; the hook owns every supplier
 * decision and the Gateway never branches on a provider id.
 */
export interface ProviderRequestHookContext {
  protocol: GatewayProtocol;
  modelId: string;
  publicModel: string;
  /** Scoped execution id attributed by the request path, when present. */
  executionId?: string;
  /** Incoming client headers, for supplier-required forwarding only. */
  requestHeaders: ProviderRequestHeaders;
  /** Mutable upstream request headers. */
  headers: Headers;
  /** Mutable upstream JSON request body. */
  body: Record<string, unknown>;
  nowMs: number;
}

/**
 * Context for an upstream response. Successful responses arrive as a live
 * `Response`; error responses arrive as buffered bytes so the hook can correct
 * a private error envelope without consuming a stream.
 */
export interface ProviderResponseHookContext {
  protocol: GatewayProtocol;
  modelId: string;
  publicModel: string;
  status: number;
  headers: Headers;
  /** Buffered body bytes of a non-2xx response. */
  errorBytes?: Uint8Array;
  /** Parsed body of a non-2xx response, when it was JSON. */
  errorBody?: unknown;
  /** Live upstream response of a 2xx response. */
  response?: Response;
}

/** A supplier response correction; absent fields keep the upstream value. */
export interface ProviderResponseHookResult {
  /** Replacement status (error mapping only). */
  status?: number;
  /** Replacement error body, serialized in place of the upstream bytes. */
  errorBody?: unknown;
  /** Replacement upstream response (successful-response repair). */
  response?: Response;
}

export type ProviderRequestHook = (context: ProviderRequestHookContext) => void | Promise<void>;
export type ProviderResponseHook = (
  context: ProviderResponseHookContext,
) => ProviderResponseHookResult | void | Promise<ProviderResponseHookResult | void>;

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
  // Per-runtime reasoning-effort materializations, keyed model id then client id
  // then effort level. The presence of an entry is the only claim that a runtime
  // explicitly supports realizing that level; absent means capability unknown,
  // and no transport is ever invented. Keys and values are validated at
  // registration against the exact declared model ids and legal levels.
  reasoningEffortMappings?: ProviderReasoningEffortMappings;
  // Protocol-aware translation of a resolved public effort into the exact
  // upstream request fields (e.g. `reasoning_effort`, `thinking`, `reasoning`).
  // Declared by each provider module; the shared layer never branches on
  // provider identity.
  convertReasoningEffort(
    modelId: string,
    effort: ReasoningEffort,
    protocol: GatewayProtocol,
  ): Record<string, unknown>;
  /**
   * Supplier request rewrite, executed by the Gateway after auth headers are
   * applied and before the request is sent. Owns every supplier request
   * special case (client identity, forwarded session headers, body fixups).
   */
  beforeRequest?: ProviderRequestHook;
  /**
   * Supplier response correction, executed on an upstream response before it is
   * relayed to a client. Owns successful-response repair and the minimal
   * remapping of a private error structure onto the entry protocol.
   */
  afterResponse?: ProviderResponseHook;
  classifyUpstreamError?(error: UpstreamRouteErrorInput): UpstreamRouteFailure | undefined;
  credentialResolver: CredentialResolver;
  defaultModel?: string;
  quotaProvider?: string;
  useClientBinary?: boolean;
  /**
   * Opt out of the registered-canonical metadata fallback. When true, every
   * model keeps exactly the metadata its declaration supplies: no registered
   * canonical speed/intelligence/pricing/context default is filled in. Used by
   * the generic models.dev-derived providers, whose canonical identities are
   * identity-only and whose missing or tiered source metadata must stay
   * genuinely undefined rather than silently regaining a registry value.
   */
  skipCanonicalMetadataFallback?: boolean;
  /**
   * Provider-level opt-in to the single provider-default reasoning ladder. When
   * true, every route of this provider that declares no explicit
   * `reasoningEfforts` ladder is materialized as the singleton `['default']`
   * sentinel ladder instead of an empty one. `default` asks the route to use
   * its own upstream-native behaviour and materializes no explicit reasoning
   * field; it is not a fabricated effort level. A route that declares its own
   * ladder keeps it verbatim, and a provider that does not opt in keeps the
   * existing empty-ladder ("unknown / no selectable level") semantics.
   */
  usesProviderDefaultReasoning?: boolean;
}
