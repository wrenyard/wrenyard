export const GATEWAY_PROTOCOLS = [
  'openai_chat',
  'openai_responses',
  'anthropic_messages',
] as const;

export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number];
export type ProviderAuthScheme = 'bearer' | 'x-api-key';
export type CredentialResolver =
  | 'forge-managed'
  | 'codebuddy'
  | 'codex'
  | 'claude'
  | 'grok-oauth'
  | 'cursor';

export type IntelligenceTier = 'low' | 'mid' | 'high' | 'premium';

// Genuine upstream reasoning-effort levels exposed as a product-owned field on
// model definitions and dispatch plans. max/ultra are intentionally not part of
// this product field, and levels are never inferred lexically from a model id.
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const INTELLIGENCE_ORDER: Readonly<Record<IntelligenceTier, number>> = {
  low: 0,
  mid: 1,
  high: 2,
  premium: 3,
};

const CURRENT_INTELLIGENCE_TIERS: ReadonlySet<string> = new Set(['low', 'mid', 'high', 'premium']);

// Strict normalizer: accepts only the four current tiers. Any other value,
// including unknown legacy tiers or the legacy 'frontier' alias, normalizes to
// undefined and is never emitted.
export function normalizeIntelligenceTier(tier: string | undefined): IntelligenceTier | undefined {
  if (tier === undefined) return undefined;
  return CURRENT_INTELLIGENCE_TIERS.has(tier) ? (tier as IntelligenceTier) : undefined;
}

export type ModelCapability = 'text' | 'image';

export interface ModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
  checkedAt: string;
}

export type SpeedSource = 'local_31d' | 'provider_override' | 'catalog_default';

export interface ModelSpeedMeta {
  tps: number;
  source: string;
  checkedAt: string;
  conservative?: boolean;
  basis?: string;
}

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
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Supported input types, including image content returned by tools; not output generation. */
  capabilities?: readonly ModelCapability[];
  speed: ModelSpeedMeta;
  pricing?: ModelPricing;
}

export interface TaskDispatchRequirements {
  expectedTps?: number;
  minimumTps?: number;
  intelligenceMin?: IntelligenceTier;
  intelligenceExpected?: IntelligenceTier;
  maxOutputUsdPerMillion?: number;
  /** Required input support. Missing/unknown model support fails admission. */
  requiredCapabilities?: readonly ModelCapability[];
  excludeModelIds?: readonly string[];
  excludeProfileIds?: readonly string[];
  excludeClientIds?: readonly string[];
  excludeProviderIds?: readonly string[];
  /** Hidden requirement: the dispatched plan must admit native web search.
   * This is enforced as a hard gate and fails closed for gateway and unknown
   * combinations; it is not surfaced in any search settings UI. */
  requiresWebSearch?: boolean;
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

export interface DispatchResolution {
  plan: DispatchPlan;
  model: ModelDefinition;
  speed: SpeedEvidence;
  satisfaction: number;
  rank: number;
}

export type ConstrainedDispatch =
  | { ok: true; selected: DispatchResolution; considered: number }
  | { ok: false; reason: 'no-eligible-candidate'; considered: number };

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
  modelSpeedOverrides?: Readonly<Record<string, ModelSpeedMeta>>;
  credentialResolver: CredentialResolver;
  defaultModel?: string;
  quotaProvider?: string;
  useClientBinary?: boolean;
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
  // The model's own product-owned upstream reasoning effort. It travels from the
  // resolved model definition into the plan; aliases never own effort policy.
  reasoningEffort?: ReasoningEffort;
}

function requireID(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${kind} id is invalid: ${JSON.stringify(value)}`);
  }
}

// Every speed evidence entry that registers into the catalog must carry a finite
// positive tps and non-empty source/checkedAt strings, whether it is a model's
// required default speed or a canonical modelSpeedOverride.
function validateSpeedMeta(speed: ModelSpeedMeta | undefined, label: string): void {
  if (!speed) {
    throw new Error(`${label} is missing required speed metadata`);
  }
  if (!Number.isFinite(speed.tps) || speed.tps <= 0) {
    throw new Error(`${label} speed tps must be finite and greater than zero`);
  }
  if (typeof speed.source !== 'string' || speed.source.trim().length === 0) {
    throw new Error(`${label} speed source must be a non-empty string`);
  }
  if (typeof speed.checkedAt !== 'string' || speed.checkedAt.trim().length === 0) {
    throw new Error(`${label} speed checkedAt must be a non-empty string`);
  }
}

// A local sample is usable only when it carries a finite positive tps, a positive
// integer sample count, a non-empty checkedAt timestamp that is valid, not in
// the future, and within the trailing 31-day window.
const LOCAL_SPEED_FRESH_MS = 31 * 24 * 60 * 60 * 1000

function isFreshLocalSample(sample: LocalSpeedSample, now: Date): boolean {
  if (!Number.isFinite(sample.tps) || sample.tps <= 0) return false
  if (!Number.isInteger(sample.sampleCount) || sample.sampleCount <= 0) return false
  if (typeof sample.checkedAt !== 'string' || sample.checkedAt.trim().length === 0) return false
  const then = new Date(sample.checkedAt).getTime()
  if (!Number.isFinite(then)) return false
  const nowMs = now.getTime()
  if (then > nowMs) return false
  if (then < nowMs - LOCAL_SPEED_FRESH_MS) return false
  return true
}

/**
 * Resolves the single authoritative speed evidence for an exact model in
 * exact precedence order: the first usable exact-provider/model local 31-day
 * TPS sample, then the canonical provider modelSpeedOverride, then the
 * model's required default speed. Matching is by exact provider.id/modelDef.id
 * only — no alias, client, or profile remap — and any sample missing, malformed,
 * future, or older than 31 days is skipped. Used by resolveConstrainedDispatch
 * and the Foreman failure diagnostics so the precedence logic is never duplicated.
 */
export function resolveModelSpeed(
  provider: ProviderDefinition,
  modelDef: ModelDefinition,
  localSpeed?: readonly LocalSpeedSample[],
  now: Date = new Date(),
): SpeedEvidence {
  const local = localSpeed?.find(
    (sample) => sample.provider === provider.id && sample.model === modelDef.id && isFreshLocalSample(sample, now),
  )
  if (local) {
    return {
      source: 'local_31d',
      tps: local.tps,
      provider: local.provider,
      model: local.model,
      checkedAt: local.checkedAt,
      sampleCount: local.sampleCount,
    }
  }
  const override = provider.modelSpeedOverrides?.[modelDef.id]
  if (override) {
    return {
      source: 'provider_override',
      tps: override.tps,
      checkedAt: override.checkedAt,
    }
  }
  return {
    source: 'catalog_default',
    tps: modelDef.speed.tps,
    checkedAt: modelDef.speed.checkedAt,
  }
}

export class Catalog {
  private readonly providersByID = new Map<string, ProviderDefinition>();
  private readonly clientsByID = new Map<string, ClientDefinition>();
  private readonly canonicalModelNamesByID = new Map<string, string>();

  registerProvider(provider: ProviderDefinition): void {
    requireID('provider', provider.id);
    if (this.providersByID.has(provider.id)) throw new Error(`duplicate provider: ${provider.id}`);
    const modelIDs = new Set<string>();
    // Stage shared identity entries locally. They are committed only after the
    // whole provider (including aliases, speed overrides, and protocols) has
    // validated, so a failed registration cannot poison later registrations.
    const stagedCanonicalModels = new Map<string, string>();
    for (const model of provider.models) {
      if (!model.id.trim()) throw new Error(`provider ${provider.id} has an empty model id`);
      if (modelIDs.has(model.id)) throw new Error(`provider ${provider.id} has duplicate model ${model.id}`);
      if (!CURRENT_INTELLIGENCE_TIERS.has(model.intelligence)) {
        throw new Error(
          `provider ${provider.id} model ${model.id} has invalid intelligence tier: ${JSON.stringify(model.intelligence)}`,
        );
      }
      // A model's default speed is required: a registration without one is
      // rejected up front, before any further validation.
      validateSpeedMeta(model.speed, `provider ${provider.id} model ${model.id}`);
      if (model.canonicalModel) {
        requireID('canonical model', model.canonicalModel.id);
        const displayName = model.canonicalModel.displayName.trim();
        if (displayName === '') {
          throw new Error(`canonical model ${model.canonicalModel.id} has an empty display name`);
        }
        const registeredName = stagedCanonicalModels.get(model.canonicalModel.id)
          ?? this.canonicalModelNamesByID.get(model.canonicalModel.id);
        if (registeredName !== undefined && registeredName !== displayName) {
          throw new Error(
            `canonical model ${model.canonicalModel.id} has conflicting display names: ${JSON.stringify(registeredName)} and ${JSON.stringify(displayName)}`,
          );
        }
        stagedCanonicalModels.set(model.canonicalModel.id, displayName);
      }
      modelIDs.add(model.id);
    }
    for (const [alias, target] of Object.entries(provider.modelAliases ?? {})) {
      if (!alias.trim()) throw new Error(`provider ${provider.id} has an empty model alias`);
      if (modelIDs.has(alias)) throw new Error(`provider ${provider.id} model alias collides with model ${alias}`);
      if (!modelIDs.has(target)) throw new Error(`provider ${provider.id} model alias ${alias} targets unknown model ${target}`);
    }
    // Canonical speed overrides may only reference exact declared model ids. Alias
    // keys and unknown model keys are rejected, and every override must satisfy the
    // same evidence requirements as a model's required default speed.
    for (const [modelID, override] of Object.entries(provider.modelSpeedOverrides ?? {})) {
      if (!modelIDs.has(modelID)) {
        throw new Error(
          `provider ${provider.id} model speed override ${JSON.stringify(modelID)} must reference an exact canonical model id`,
        );
      }
      validateSpeedMeta(override, `provider ${provider.id} model speed override ${modelID}`);
    }
    const protocols = new Set<GatewayProtocol>();
    for (const capability of provider.protocols ?? []) {
      if (protocols.has(capability.protocol)) {
        throw new Error(`provider ${provider.id} has duplicate protocol ${capability.protocol}`);
      }
      protocols.add(capability.protocol);
      if (!capability.endpoint.startsWith('https://')) {
        throw new Error(`provider ${provider.id} endpoint must use https`);
      }
    }
    for (const [canonicalModelID, displayName] of stagedCanonicalModels) {
      this.canonicalModelNamesByID.set(canonicalModelID, displayName);
    }
    this.providersByID.set(provider.id, provider);
  }

  registerClient(client: ClientDefinition): void {
    requireID('client', client.id);
    if (this.clientsByID.has(client.id)) throw new Error(`duplicate client: ${client.id}`);
    const unsupportedProviders = new Set<string>();
    for (const providerID of client.unsupportedGatewayProviders ?? []) {
      requireID('unsupported gateway provider', providerID);
      if (unsupportedProviders.has(providerID)) {
        throw new Error(`client ${client.id} has duplicate unsupported gateway provider ${providerID}`);
      }
      unsupportedProviders.add(providerID);
    }
    this.clientsByID.set(client.id, client);
  }

  providers(): readonly ProviderDefinition[] {
    return [...this.providersByID.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  clients(): readonly ClientDefinition[] {
    return [...this.clientsByID.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  // Deterministically enumerate every exact compatible task-capable target from the
  // registered providers/models and registered task-capable clients. Compatibility is
  // decided only by resolveRun; parseability is not evidence that a client can run the
  // target, and model aliases are never enumerated as separate candidates. taskOnly
  // models are included: that flag hides them from public Gateway /models, it does not
  // forbid them as Task targets.
  enumerateTaskCandidates(): DispatchCandidate[] {
    const taskClients = this.clients().filter((client) => client.taskCapable === true);
    const candidates: DispatchCandidate[] = [];
    for (const provider of this.providers()) {
      for (const model of provider.models) {
        for (const client of taskClients) {
          let plan: DispatchPlan;
          try {
            plan = this.resolveRun(client.id, provider.id, model.id);
          } catch {
            continue; // Incompatible client/provider pair is not a candidate.
          }
          try {
            // formatRunSyntax(plan) is the stable canonical profileId/target identity.
            candidates.push({
              profileId: formatRunSyntax(plan),
              client: plan.client,
              provider: plan.provider,
              model: plan.model,
            });
          } catch {
            continue; // Task-capable client without a public run-syntax key.
          }
        }
      }
    }
    // Deterministic canonical target order, independent of declaration order.
    return candidates.sort((a, b) => a.profileId.localeCompare(b.profileId));
  }

  provider(id: string): ProviderDefinition | undefined {
    return this.providersByID.get(id);
  }

  listGatewayModels(
    protocol: GatewayProtocol,
    credentialAvailable: (provider: ProviderDefinition) => boolean = () => true,
  ): PublicGatewayModel[] {
    return this.providers()
      .filter((provider) => credentialAvailable(provider))
      .filter((provider) => provider.protocols?.some((entry) => entry.protocol === protocol))
      .flatMap((provider) => provider.models
        .filter((model) => !model.taskOnly)
        .map((model) => ({
          id: model.id,
          displayName: model.displayName,
          provider: provider.id,
          publicId: `${provider.id}/${model.id}`,
          speed: model.speed,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.family === undefined ? {} : { family: model.family }),
          ...(model.claudeTier === undefined ? {} : { claudeTier: model.claudeTier }),
          ...(model.supports1MContext === undefined ? {} : { supports1MContext: model.supports1MContext }),
          intelligence: model.intelligence,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
          ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
          ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
        })));
  }

  resolveGatewayModel(protocol: GatewayProtocol, publicID: string): ResolvedGatewayModel {
    const separator = publicID.indexOf('/');
    if (separator <= 0 || separator === publicID.length - 1) {
      throw new Error(`model must use provider/model form: ${publicID}`);
    }
    const providerID = publicID.slice(0, separator);
    const requestedModelID = publicID.slice(separator + 1);
    const provider = this.providersByID.get(providerID);
    if (!provider) throw new Error(`unknown provider: ${providerID}`);
    const modelID = provider.modelAliases?.[requestedModelID] ?? requestedModelID;
    const model = provider.models.find((entry) => entry.id === modelID && !entry.taskOnly);
    if (!model) throw new Error(`unknown model: ${publicID}`);
    const capability = provider.protocols?.find((entry) => entry.protocol === protocol);
    if (!capability) throw new Error(`model ${publicID} does not support ${protocol}`);
    return {
      provider,
      model,
      capability,
      publicId: `${providerID}/${modelID}`,
      upstreamModel: capability.upstreamModels?.[modelID] ?? modelID,
    };
  }

  resolveRun(clientID: string, providerID: string, modelID: string): DispatchPlan {
    const client = this.clientsByID.get(clientID);
    if (!client) throw new Error(`unknown client: ${clientID}`);
    const provider = this.providersByID.get(providerID);
    if (!provider) throw new Error(`unknown provider: ${providerID}`);
    modelID = provider.modelAliases?.[modelID] ?? modelID;
    const modelDef = provider.models.find((model) => model.id === modelID);
    if (!modelDef) throw new Error(`unknown model: ${providerID}/${modelID}`);
    // Carry the model's declared reasoning effort (when present) into the exact
    // plan. Effort is product metadata on the model, never inferred lexically.
    const effort = modelDef.reasoningEffort ? { reasoningEffort: modelDef.reasoningEffort } : {};
    if (provider.nativeClients?.includes(clientID)) {
      // Native web search is admitted ONLY for an explicitly supported native
      // client/provider pair: the client must declare supportsNativeWebSearch and
      // the resolved provider must be that client's exact nativeProvider. This is
      // native-provider capability alone — never third-party gateway support.
      const plan: DispatchPlan = { client: clientID, provider: providerID, model: modelID, mode: 'native', ...effort };
      if (client.supportsNativeWebSearch === true && client.nativeProvider === providerID) {
        plan.supportsWebSearch = true;
      }
      return plan;
    }
    if (client.unsupportedGatewayProviders?.includes(providerID)) {
      throw new Error(`provider ${providerID} cannot serve client ${clientID}`);
    }
    const protocol = client.gatewayProtocols.find((candidate) =>
      provider.protocols?.some((capability) => capability.protocol === candidate));
    if (!protocol) throw new Error(`provider ${providerID} cannot serve client ${clientID}`);
    return { client: clientID, provider: providerID, model: modelID, mode: 'gateway', protocol, ...effort };
  }

}

export function isDynamicFast(tps: number): boolean {
  return tps > 80;
}

export function resolveConstrainedDispatch(
  catalog: Catalog,
  candidates: readonly DispatchCandidate[],
  requirements: TaskDispatchRequirements,
  localSpeed?: readonly LocalSpeedSample[],
): ConstrainedDispatch {
  const excludedModels = new Set(requirements.excludeModelIds ?? []);
  const excludedProfiles = new Set(requirements.excludeProfileIds ?? []);
  const excludedClients = new Set(requirements.excludeClientIds ?? []);
  const excludedProviders = new Set(requirements.excludeProviderIds ?? []);
  const requiredCaps = requirements.requiredCapabilities ?? [];

  const eligible: DispatchResolution[] = [];
  let considered = 0;

  for (const candidate of candidates) {
    considered++;
    if (excludedModels.has(candidate.model)) continue;
    if (excludedProfiles.has(candidate.profileId)) continue;
    if (excludedClients.has(candidate.client)) continue;
    if (excludedProviders.has(candidate.provider)) continue;

    let plan: DispatchPlan;
    try {
      plan = catalog.resolveRun(candidate.client, candidate.provider, candidate.model);
    } catch {
      continue;
    }
    const provider = catalog.provider(plan.provider);
    if (!provider) continue;
    const modelDef = provider.models.find((entry) => entry.id === plan.model);
    if (!modelDef) continue;

    // Hard constraint: native web search requirement, enforced before any
    // capability/intelligence/price scoring. Admitted only when the resolved
    // plan explicitly supports native web search; gateway and unknown
    // combinations fail closed.
    if (requirements.requiresWebSearch && plan.supportsWebSearch !== true) continue;

    // Canonical-alias exclusion: a candidate supplied via an alias must not
    // bypass exclusion of its resolved canonical model (e.g. legacy-glm ->
    // glm-5.3). GLM-5.3-Flash remains a distinct id and is excluded only by
    // its own id, never by a glm-5.3 exclusion.
    if (excludedModels.has(plan.model)) continue;

    // Hard constraint: required capabilities. Fail closed when missing or insufficient.
    if (requiredCaps.length > 0) {
      const caps = modelDef.capabilities ?? [];
      let capOk = true;
      for (const req of requiredCaps) {
        if (!caps.includes(req)) {
          capOk = false;
          break;
        }
      }
      if (!capOk) continue;
    }

    // Hard constraint: intelligence minimum. The configured intelligence tier
    // is the sole admission fact.
    if (requirements.intelligenceMin) {
      const intel = modelDef.intelligence;
      if (INTELLIGENCE_ORDER[intel] < INTELLIGENCE_ORDER[requirements.intelligenceMin]) continue;
    }

    // Hard constraint: max output price. Fail closed when pricing is unknown.
    if (requirements.maxOutputUsdPerMillion !== undefined) {
      if (!modelDef.pricing) continue;
      if (modelDef.pricing.outputUsdPerMillion > requirements.maxOutputUsdPerMillion) continue;
    }

    // Speed evidence tiers in exact precedence order via the shared resolver:
    // the first usable exact-provider/model local 31-day TPS sample,
    // then the canonical provider modelSpeedOverride, then the model default
    // speed. Matching is by exact provider.id/modelDef.id — no alias or client remap.
    const speed = resolveModelSpeed(provider, modelDef, localSpeed);

    // Hard constraint: minimum TPS against the resolved evidence tier.
    if (requirements.minimumTps !== undefined && speed.tps < requirements.minimumTps) continue;

    // expectedTps satisfaction semantics: explicit ratio, clamped to 1.
    const expected = requirements.expectedTps;
    const satisfaction =
      expected !== undefined && expected > 0 ? Math.min(1, speed.tps / expected) : 1;

    eligible.push({ plan, model: modelDef, speed, satisfaction, rank: 0 });
  }

  if (eligible.length === 0) {
    return { ok: false, reason: 'no-eligible-candidate', considered };
  }

  // Collapse by canonical provider/model before comparing different models. Every
  // hard gate above has already admitted each survivor, so within one canonical
  // provider/model the single representative client is chosen deterministically:
  // a Catalog-native plan first; when no native plan is eligible, the grok
  // gateway client before claude and the remaining gateway clients; then the
  // stable client id. Concrete runtime selection belongs to explicit mode and
  // never participates in automatic selection.
  const byProviderModel = new Map<string, DispatchResolution[]>();
  for (const entry of eligible) {
    const key = `${entry.plan.provider}/${entry.plan.model}`;
    const group = byProviderModel.get(key);
    if (group) group.push(entry);
    else byProviderModel.set(key, [entry]);
  }
  const collapsed: DispatchResolution[] = [];
  for (const group of byProviderModel.values()) {
    const native = group.filter((entry) => entry.plan.mode === 'native');
    const usable = native.length > 0 ? native : group;
    usable.sort((a, b) => {
      if (native.length === 0) {
        const aGrok = a.plan.client === 'grok' ? 0 : 1;
        const bGrok = b.plan.client === 'grok' ? 0 : 1;
        if (aGrok !== bGrok) return aGrok - bGrok;
      }
      return a.plan.client.localeCompare(b.plan.client);
    });
    collapsed.push(usable[0]);
  }

  const expected = requirements.expectedTps;
  collapsed.sort((a, b) => {
    // Deterministic ordering across the collapsed model representatives:
    // expected-speed group first (meets expectedTps), then lower reference
    // output price first, then stable canonical provider/model identity. No
    // concrete runtime selection is consulted in automatic mode.
    const aMeets = expected !== undefined && expected > 0 && a.speed.tps >= expected;
    const bMeets = expected !== undefined && expected > 0 && b.speed.tps >= expected;
    if (aMeets !== bMeets) return aMeets ? -1 : 1;
    const pa = a.model.pricing?.outputUsdPerMillion ?? Number.POSITIVE_INFINITY;
    const pb = b.model.pricing?.outputUsdPerMillion ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const idA = `${a.plan.provider}/${a.plan.model}`;
    const idB = `${b.plan.provider}/${b.plan.model}`;
    return idA.localeCompare(idB);
  });

  collapsed.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return { ok: true, selected: collapsed[0], considered };
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

const CLIENT_KEY_BY_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(PUBLIC_CLIENT_KEYS).reduce<Record<string, string>>((byID, [publicKey, client]) => {
    byID[client] = publicKey;
    return byID;
  }, {}),
);

const RUN_SYNTAX_WHITESPACE = /\s/;

function rejectWhitespace(label: string, value: string): void {
  if (RUN_SYNTAX_WHITESPACE.test(value)) {
    throw new Error(`${label} must not contain whitespace: ${JSON.stringify(value)}`);
  }
}

export function parseRunSyntax(input: string): RunSyntaxRef {
  if (input.length === 0) {
    throw new Error(`run syntax must be a non-empty string: ${JSON.stringify(input)}`);
  }
  rejectWhitespace('run syntax', input);
  const slash = input.indexOf('/');
  if (slash === -1) {
    throw new Error(`run syntax must separate provider and model with "/": ${JSON.stringify(input)}`);
  }
  const colon = input.lastIndexOf(':');
  if (colon === -1) {
    throw new Error(`run syntax must separate model and client with ":": ${JSON.stringify(input)}`);
  }
  if (colon < slash) {
    throw new Error(`run syntax must be provider/model:client with "/" before ":": ${JSON.stringify(input)}`);
  }
  // Split provider at the first slash so model ids may contain additional slashes,
  // and take the client from the final colon, preserving the :free model variant.
  const provider = input.slice(0, slash);
  if (provider.includes(':')) throw new Error('provider must not contain ":"');
  const model = input.slice(slash + 1, colon);
  if (model.includes(':') && !/^[^:]+:free$/.test(model)) {
    throw new Error(`model ":" is only supported in a trailing :free variant: ${JSON.stringify(input)}`);
  }
  const rawClient = input.slice(colon + 1);
  if (provider.length === 0) {
    throw new Error(`run syntax provider must not be empty: ${JSON.stringify(input)}`);
  }
  if (model.length === 0) {
    throw new Error(`run syntax model must not be empty: ${JSON.stringify(input)}`);
  }
  const client: string | undefined = PUBLIC_CLIENT_KEYS[rawClient];
  if (client === undefined) {
    throw new Error(
      `unknown client key ${JSON.stringify(rawClient)}; expected one of ${Object.keys(PUBLIC_CLIENT_KEYS).join(', ')}`,
    );
  }
  return { client, provider, model };
}

export function formatRunSyntax(target: RunSyntaxRef): string {
  const publicKey: string | undefined = CLIENT_KEY_BY_ID[target.client];
  if (publicKey === undefined) {
    throw new Error(
      `unknown client ${JSON.stringify(target.client)}; expected one of ${Object.keys(CLIENT_KEY_BY_ID).join(', ')}`,
    );
  }
  // Guarantee the canonical syntax round-trips: the parser splits provider at "/"
  // and client at ":" and rejects whitespace, so reject those in formatted parts.
  rejectWhitespace('provider', target.provider);
  rejectWhitespace('model', target.model);
  if (target.provider.length === 0) {
    throw new Error('provider must not be empty');
  }
  if (target.model.length === 0) {
    throw new Error('model must not be empty');
  }
  if (target.provider.includes('/')) {
    throw new Error(`provider must not contain "/": ${JSON.stringify(target.provider)}`);
  }
  if (target.provider.includes(':') || (target.model.includes(':') && !/^[^:]+:free$/.test(target.model))) {
    throw new Error(
      `provider and model must not contain ":": ${JSON.stringify(target.provider)} / ${JSON.stringify(target.model)}`,
    );
  }
  return `${target.provider}/${target.model}:${publicKey}`;
}

export function resolveRunSyntax(catalog: Catalog, input: string): DispatchPlan {
  const target = parseRunSyntax(input);
  return catalog.resolveRun(target.client, target.provider, target.model);
}
export {
  EFFICIENCY_EVIDENCE_WEIGHT,
  EFFICIENCY_HEADROOM_WEIGHT,
  FULL_CYCLE_HEADROOM_WEIGHT,
  FULL_CYCLE_MIN_REMAINING,
  FULL_CYCLE_RESET_PACE,
  FULL_CYCLE_RESET_WEIGHT,
  HEALTHY_ROLLING_REMAINING,
  NEUTRAL_HEADROOM,
  SCORE_WEIGHTS,
  STRAINED_ROLLING_REMAINING,
  assessRequiredQuota,
  evaluateCandidate,
  rankAutoRoutingCandidates,
} from './auto-routing-policy.js';
export type {
  AutoRoutingResult,
  BalanceEvidence,
  CandidateAssessment,
  CandidateEvaluation,
  CandidateInput,
  ConstraintAssessment,
  ConstraintRejectCode,
  ConstraintState,
  ExcludedCandidate,
  ExcludedReason,
  MarginalPriceEvidence,
  QuotaAssessment,
  QuotaBurnEfficiencyDomain,
  QuotaBurnEfficiencyEvidence,
  QuotaEvidence,
  QuotaState,
  QuotaTier,
  RankedCandidate,
  ReferenceKind,
  ReplenishmentKind,
  RequiredQuotaConstraint,
  WorstApplicableMarker,
} from './auto-routing-policy.js';
