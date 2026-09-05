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
    if (!provider.models.some((model) => model.id === modelID)) {
      throw new Error(`unknown model: ${providerID}/${modelID}`);
    }
    if (provider.nativeClients?.includes(clientID)) {
      return { client: clientID, provider: providerID, model: modelID, mode: 'native' };
    }
    const protocol = client.gatewayProtocols.find((candidate) =>
      provider.protocols?.some((capability) => capability.protocol === candidate));
    if (!protocol) throw new Error(`provider ${providerID} cannot serve client ${clientID}`);
    return { client: clientID, provider: providerID, model: modelID, mode: 'gateway', protocol };
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
  const preferred = requirements.preferredRuntime;
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

  const expected = requirements.expectedTps;
  eligible.sort((a, b) => {
    // Deterministic ordering: expected-speed group first (meets expectedTps), then
    // within the same group lower reference output price first, then declared
    // preference, then stable canonical identity. A preferred candidate never
    // bypasses the hard filters above.
    const aMeets = expected !== undefined && expected > 0 && a.speed.tps >= expected;
    const bMeets = expected !== undefined && expected > 0 && b.speed.tps >= expected;
    if (aMeets !== bMeets) return aMeets ? -1 : 1;
    const pa = a.model.pricing?.outputUsdPerMillion ?? Number.POSITIVE_INFINITY;
    const pb = b.model.pricing?.outputUsdPerMillion ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const aPreferred = preferred && preferred.client === a.plan.client && preferred.provider === a.plan.provider && preferred.model === a.plan.model ? 1 : 0;
    const bPreferred = preferred && preferred.client === b.plan.client && preferred.provider === b.plan.provider && preferred.model === b.plan.model ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    const idA = `${a.plan.provider}/${a.plan.model}`;
    const idB = `${b.plan.provider}/${b.plan.model}`;
    return idA.localeCompare(idB);
  });

  eligible.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return { ok: true, selected: eligible[0], considered };
}
