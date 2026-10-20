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
  /** Median measured first-token latency, when local samples provide it. */
  firstTokenMs?: number;
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

/**
 * The identity of one Gateway request: the bare registered model id plus an
 * optional, separate provider selector. The two dimensions are never collapsed
 * into a qualified string — `model` is always a registered id, and the provider
 * is chosen independently (explicitly, or by unambiguous inference).
 */
export interface GatewayModelSelector {
  /** Exact registered model id (`models.require(id).id`). Never `provider/model`. */
  model: string;
  /** Exact provider id. Absent means "the single provider that offers this
   * registered id on the requested protocol"; an ambiguous set is rejected. */
  provider?: string;
}

export interface ModelDefinition {
  /** The public offering identity. Always an exact registered model id
   * (`models.require(id).id`); a provider never publishes a wire spelling or a
   * locally synthesized identity here. */
  id: string;
  displayName: string;
  /** Exact upstream wire model name for the outbound request. This is private
   * transport data: consumers branch on `id`, and only the provider transport
   * translates `id` into this value. Absent means the upstream accepts the
   * registered id verbatim. */
  upstreamId?: string;
  /** The registered identity this offering names. It always equals `id`; it is
   * retained as a read-only echo for consumers that still read the canonical
   * reference directly. */
  canonicalModel?: CanonicalModelDefinition;
  /**
   * Opt-in, per-declaration ownership of the source-provided upstream metadata.
   * When true, `contextWindow`, `maxTokens`/`maxOutputTokens`, `pricing`,
   * `capabilities` and `free` describe only what this declaration's source
   * actually reported: a field the source omits stays absent instead of being
   * refilled from the registered defaults. Absent (or false) keeps the normal
   * field-by-field registry fallback. Speed and intelligence are always
   * registry-owned and cannot be overridden either way; there is no
   * provider-wide metadata suppression.
   */
  ownsMetadata?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  taskOnly?: boolean;
  family?: 'claude';
  claudeTier?: 'haiku' | 'sonnet' | 'opus';
  supports1MContext?: boolean;
  /** A verified, distinct upstream Fast mode exists for this model, through a
   * standard gateway mapping or native client passthrough. Absent means no
   * Fast mode is known, and capability is never inferred from an alias or id. */
  supportsFast?: boolean;
  /** Catalog intelligence tier. Required for every registered offering: a
   * route with no legal tier is not a usable offering and registration rejects
   * it. There is no unknown-tier fallback and a provider cannot override the
   * identity-owned tier. */
  intelligence: IntelligenceTier;
  /** Route-owned reasoning efforts this model can materialize. Required array:
   * every offering declares its own ladder. An EMPTY array means the route
   * materializes no selectable level; an absent ladder is never inferred from
   * the registry or a model id. */
  reasoningEfforts: readonly ReasoningEffort[];
  maxOutputTokens?: number;
  /** Supported input types, including image content returned by tools; not output generation. */
  capabilities?: readonly ModelCapability[];
  /** Model-level client restriction. The three cases:
   * - absent means unrestricted: every client may resolve a run for this model.
   * - an EMPTY array means the model supports direct gateway/session access but
   *   NO external client: it is never a task candidate, and `resolveRun` rejects
   *   every client for it. It stays published through the gateway directory and
   *   resolvable for direct, client-agnostic session turns.
   * - a NON-EMPTY array is usable only by those exact client ids (native or
   *   gateway), and the model is never published through the public gateway
   *   model directory. Used for entitlements usable solely through a client's
   *   genuine transport (e.g. free OpenCode Zen tiers).
   * Consumers must branch on `(supportedClients?.length ?? 0)`, never on mere
   * definedness. */
  supportedClients?: readonly string[];
  /** Catalog default TPS. Required for every registered offering and always a
   * positive integer. It is the mandatory fallback when no measured evidence
   * exists for the provider/model pair; it is never reported as a measurement.
   * A provider cannot override it here — measured provider speed stays in the
   * separate override/provenance evidence path. */
  speed: number;
  /** Catalog list price. Required for a registered canonical model. A route
   * whose model names no registered canonical model leaves this absent: the
   * price is genuinely unknown and is never defaulted to zero. */
  pricing?: ModelPricing;
  /** Explicit free/entitlement classification: the route is genuinely free to
   * use. It is never inferred from list pricing — a `pricing` of zero does not
   * make a model free, and a free model keeps its declared `pricing` unchanged.
   * Every consumer that treats a model as free must branch on this flag. */
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
  /** Median measured first-token latency, when enough samples provide it. */
  firstTokenMs?: number;
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
  status?: number;
  headers: Headers;
  body: unknown;
  nowMs: number;
}

export type PublicGatewayModel = Omit<ModelDefinition, 'canonicalModel'> & {
  provider: string;
  /** Internal, provider-qualified route key (`provider/id`). It is the key for
   * route health, quota and statistics and is never the model's public
   * identity: the entry's `id` is the registered model id. */
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
  /** The fault kind behind the route's block, when known. */
  faultKind?: string;
};

export interface ResolvedGatewayModel {
  provider: ProviderDefinition;
  model: ModelDefinition;
  capability: ProtocolCapability;
  /** Internal provider-qualified route key (`provider/model.id`). */
  publicId: string;
  /** The exact private upstream wire model for the outbound request. */
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
  // Fast mode requested for this plan. `true` and an explicit `false` are both
  // preserved; absence means no Fast preference at all.
  fast?: boolean;
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
  pi: 'pi',
});

export type ProviderAuthScheme = 'bearer' | 'x-api-key';
export type CredentialResolver =
  | 'managed'
  | 'codebuddy'
  | 'codex'
  | 'claude'
  | 'grok-oauth'
  | 'cursor'
  | 'devin'
  | 'workbuddy';

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

/**
 * Provider-owned materialization of Fast mode. Declared only when the provider
 * has a verified Fast capability for at least one exact route. Fast is always a
 * dimension separate from reasoning effort: a native mapping transforms the
 * model this runtime already resolved (including any effort substitution)
 * without changing the effort, and a gateway mapping adds only the official
 * entry-protocol fields for the requested state.
 */
export interface ProviderFastMapping {
  /**
   * Native transport: the exact upstream model for the requested Fast state,
   * derived from the already-resolved model. Both `true` and `false` are
   * materialized explicitly because a native product may default Fast on.
   */
  readonly model?: (resolvedModel: string, modelId: string, fast: boolean) => string;
  /**
   * Gateway transport: the official entry-protocol request fields for the
   * requested Fast state (for example OpenAI `service_tier` or Messages
   * `speed`). Protocols this provider does not serve materialize nothing.
   */
  readonly request?: (modelId: string, fast: boolean, protocol: GatewayProtocol) => Record<string, unknown>;
}

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

export interface ProviderExecuteContext {
  /** Report upstream errors before protocol conversion; omit for local validation failures. */
  reportUpstreamError?(fact: { status: number; code?: string; type?: string }): void;
  protocol: GatewayProtocol;
  modelId: string;
  publicModel: string;
  credential: import('./provider.ts').ProviderCredential;
  body: Record<string, unknown>;
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
}

export type ProviderExecuteRequest = (context: ProviderExecuteContext) => Promise<Response>;

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
  // Provenance of real measured speed evidence, keyed by exact declared model
  // id: the initial measured TPS plus when and how it was measured. This records
  // the evidence behind the integer `modelSpeedOverrides` value and never
  // replaces it — the override stays the single routing fact.
  modelSpeedMeasurements?: Readonly<
    Record<string, { readonly initialTps: number; readonly measuredAt: string; readonly method: string }>
  >;
  // Exact declared model ids whose upstream generates the whole response before
  // streaming it, then replays it in a burst: their streamed timing measures the
  // replay, not generation, so their speed samples are dropped and routing uses
  // the declared speed.
  replayedStreamModels?: readonly string[];
  // Per-runtime reasoning-effort materializations, keyed model id then client id
  // then effort level. The presence of an entry is the only claim that a runtime
  // explicitly supports realizing that level; absent means capability unknown,
  // and no transport is ever invented. Keys and values are validated at
  // registration against the exact declared model ids and legal levels.
  reasoningEffortMappings?: ProviderReasoningEffortMappings;
  /**
   * Provider-owned Fast materialization, declared only when a verified Fast
   * mode exists. Absent means Fast is unsupported for every route of this
   * provider, so an explicit Fast request must fail instead of passing through.
   */
  fastMapping?: ProviderFastMapping;
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
  executeRequest?: ProviderExecuteRequest;
  classifyUpstreamError?(error: UpstreamRouteErrorInput): UpstreamRouteFailure | undefined;
  credentialResolver: CredentialResolver;
  defaultModel?: string;
  quotaProvider?: string;
  useClientBinary?: boolean;
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
  /**
   * Definition-level capability gate for forced tool choice. `false` means the
   * provider cannot honour a forced `tool_choice` (`'required'` or a named tool
   * object), so it must never be selected for a request that forces one.
   * `undefined` or `true` means the capability is supported.
   */
  supportsForcedToolChoice?: boolean;
  /**
   * Signals that the provider may ignore a forced `tool_choice` and return a
   * successful plain-text response instead of the requested tool call.
   * `undefined` or `false` means a forced tool choice is honoured when
   * successful.
   */
  ignoresForcedToolChoice?: boolean;
}
