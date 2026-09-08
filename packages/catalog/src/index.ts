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

export type IntelligenceTier = 'low' | 'mid' | 'high' | 'frontier' | 'premium';

// Genuine upstream reasoning-effort levels exposed as a product-owned field on
// model definitions and dispatch plans. max/ultra are intentionally not part of
// this product field, and levels are never inferred lexically from a model id.
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const INTELLIGENCE_ORDER: Readonly<Record<IntelligenceTier, number>> = {
  low: 0,
  mid: 1,
  high: 2,
  frontier: 3,
  premium: 4,
};

export type ModelCapability = 'text' | 'image';

export interface ModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
  checkedAt: string;
}

export type SpeedSource = 'local_31d' | 'catalog_default';

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
  profileId?: string;
  checkedAt?: string;
  sampleCount?: number;
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxTokens?: number;
  taskOnly?: boolean;
  family?: 'claude';
  claudeTier?: 'haiku' | 'sonnet' | 'opus';
  supports1MContext?: boolean;
  intelligence?: IntelligenceTier;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  capabilities?: readonly ModelCapability[];
  speed?: ModelSpeedMeta;
  pricing?: ModelPricing;
}

export interface TaskDispatchRequirements {
  expectedTps?: number;
  minimumTps?: number;
  intelligenceMin?: IntelligenceTier;
  intelligenceMax?: IntelligenceTier;
  maxOutputUsdPerMillion?: number;
  requiredCapabilities?: readonly ModelCapability[];
  excludeModelIds?: readonly string[];
  excludeProfileIds?: readonly string[];
  excludeClientIds?: readonly string[];
  excludeProviderIds?: readonly string[];
  // Retained for interface compatibility but ignored by automatic constrained
  // dispatch: a concrete runtime/alias preference exists only in explicit mode.
  preferredRuntime?: { client: string; provider: string; model: string };
}

export interface DispatchCandidate {
  profileId: string;
  client: string;
  provider: string;
  model: string;
}

export interface LocalSpeedSample {
  profileId: string;
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
  credentialResolver: CredentialResolver;
  defaultModel?: string;
  quotaProvider?: string;
  useClientBinary?: boolean;
}

export interface ClientDefinition {
  id: string;
  nativeProvider?: string;
  gatewayProtocols: readonly GatewayProtocol[];
  // Task-capable clients are enumerated as derived task dispatch candidates.
  // Parseable public run syntax alone does not make a client task-capable.
  taskCapable?: boolean;
}

export interface PublicGatewayModel extends ModelDefinition {
  provider: string;
  publicId: string;
}

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
  // The model's own product-owned upstream reasoning effort. It travels from the
  // resolved model definition into the plan; aliases never own effort policy.
  reasoningEffort?: ReasoningEffort;
}

function requireID(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${kind} id is invalid: ${JSON.stringify(value)}`);
  }
}

export class Catalog {
  private readonly providersByID = new Map<string, ProviderDefinition>();
  private readonly clientsByID = new Map<string, ClientDefinition>();

  registerProvider(provider: ProviderDefinition): void {
    requireID('provider', provider.id);
    if (this.providersByID.has(provider.id)) throw new Error(`duplicate provider: ${provider.id}`);
    const modelIDs = new Set<string>();
    for (const model of provider.models) {
      if (!model.id.trim()) throw new Error(`provider ${provider.id} has an empty model id`);
      if (modelIDs.has(model.id)) throw new Error(`provider ${provider.id} has duplicate model ${model.id}`);
      modelIDs.add(model.id);
    }
    for (const [alias, target] of Object.entries(provider.modelAliases ?? {})) {
      if (!alias.trim()) throw new Error(`provider ${provider.id} has an empty model alias`);
      if (modelIDs.has(alias)) throw new Error(`provider ${provider.id} model alias collides with model ${alias}`);
      if (!modelIDs.has(target)) throw new Error(`provider ${provider.id} model alias ${alias} targets unknown model ${target}`);
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
    this.providersByID.set(provider.id, provider);
  }

  registerClient(client: ClientDefinition): void {
    requireID('client', client.id);
    if (this.clientsByID.has(client.id)) throw new Error(`duplicate client: ${client.id}`);
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
        .map((model) => ({ ...model, provider: provider.id, publicId: `${provider.id}/${model.id}` })));
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
      return { client: clientID, provider: providerID, model: modelID, mode: 'native', ...effort };
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
    const modelDef = provider?.models.find((entry) => entry.id === plan.model);
    if (!modelDef) continue;

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

    // Hard constraint: intelligence band. Fail closed when intelligence is unknown.
    if (requirements.intelligenceMin || requirements.intelligenceMax) {
      const intel = modelDef.intelligence;
      if (intel === undefined) continue;
      if (requirements.intelligenceMin && INTELLIGENCE_ORDER[intel] < INTELLIGENCE_ORDER[requirements.intelligenceMin]) continue;
      if (requirements.intelligenceMax && INTELLIGENCE_ORDER[intel] > INTELLIGENCE_ORDER[requirements.intelligenceMax]) continue;
    }

    // Hard constraint: max output price. Fail closed when pricing is unknown.
    if (requirements.maxOutputUsdPerMillion !== undefined) {
      if (!modelDef.pricing) continue;
      if (modelDef.pricing.outputUsdPerMillion > requirements.maxOutputUsdPerMillion) continue;
    }

    // Speed evidence: prefer a per-profile local 31-day agent_turn_v1 sample, else catalog default.
    const local = localSpeed?.find((s) => s.profileId === candidate.profileId);
    let speed: SpeedEvidence;
    if (local) {
      speed = {
        source: 'local_31d',
        tps: local.tps,
        profileId: local.profileId,
        checkedAt: local.checkedAt,
        sampleCount: local.sampleCount,
      };
    } else if (modelDef.speed) {
      speed = {
        source: 'catalog_default',
        tps: modelDef.speed.tps,
        checkedAt: modelDef.speed.checkedAt,
      };
    } else {
      speed = { source: 'catalog_default', tps: 0, checkedAt: undefined };
    }

    // Hard constraint: minimum TPS. Fail closed when required speed evidence is missing.
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
  // stable client id. preferredRuntime never participates in automatic selection.
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
    // concrete declared preference is consulted, so a preferredRuntime cannot
    // alter the automatic client or provider/model outcome.
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
  const colon = input.indexOf(':');
  if (colon === -1) {
    throw new Error(`run syntax must separate model and client with ":": ${JSON.stringify(input)}`);
  }
  if (input.indexOf(':', colon + 1) !== -1) {
    throw new Error(`run syntax must contain exactly one ":" separator: ${JSON.stringify(input)}`);
  }
  if (colon < slash) {
    throw new Error(`run syntax must be provider/model:client with "/" before ":": ${JSON.stringify(input)}`);
  }
  // Split provider at the first slash so model ids may contain additional slashes,
  // and take the client from the single (and therefore final) colon.
  const provider = input.slice(0, slash);
  const model = input.slice(slash + 1, colon);
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
  if (target.provider.includes(':') || target.model.includes(':')) {
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
  HEADROOM_CHALLENGE_MIN_GAP,
  HEALTHY_ROLLING_REMAINING,
  NEUTRAL_HEADROOM,
  REFERENCE_PRICE_GATE_USD_PER_M,
  SCORE_WEIGHTS,
  STRAINED_ROLLING_REMAINING,
  assessRequiredQuota,
  evaluateCandidate,
  rankAutoRoutingCandidates,
} from './auto-routing-policy.js';
export type {
  AutoRoutingResult,
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
