import { REASONING_EFFORTS, resolveReasoningEffort, type ReasoningEffort } from '@wrenyard/models';
import { GATEWAY_PROTOCOLS, type GatewayProtocol, type IntelligenceTier, INTELLIGENCE_ORDER, type ModelCapability, type ModelPricing, type SpeedSource, type SpeedEvidence, type CanonicalModelDefinition, type ModelDefinition, type DispatchCandidate, type LocalSpeedSample, type ClientDefinition, type PublicGatewayModel, type ResolvedGatewayModel, type DispatchPlan, type RunSyntaxRef, PUBLIC_CLIENT_KEYS, type ProtocolCapability, type ProviderDefinition, type ProviderReasoningEffortMappings } from './contracts.ts';
export * from './contracts.ts';

const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

// Strict normalizer: accepts only the current effort vocabulary. The legacy
// misspelling 'midium' is no longer an accepted alias, so every unknown value
// (including 'midium') normalizes to undefined and is never emitted.
export function normalizeReasoningEffort(effort: string | undefined): ReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  return REASONING_EFFORT_SET.has(effort) ? (effort as ReasoningEffort) : undefined;
}

function validateReasoningEfforts(providerID: string, model: ModelDefinition): void {
  const efforts = model.reasoningEfforts;
  if (!Array.isArray(efforts) || efforts.length === 0) {
    throw new Error(`provider ${providerID} model ${model.id} reasoningEfforts must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const effort of efforts) {
    if (!REASONING_EFFORT_SET.has(effort)) {
      throw new Error(
        `provider ${providerID} model ${model.id} has invalid reasoning effort: ${JSON.stringify(effort)}`,
      );
    }
    if (seen.has(effort)) {
      throw new Error(`provider ${providerID} model ${model.id} has duplicate reasoning effort ${effort}`);
    }
    seen.add(effort);
  }
}

function validateReasoningEffortMappings(
  providerID: string,
  mappings: ProviderReasoningEffortMappings | undefined,
  modelIDs: ReadonlySet<string>,
  models: readonly ModelDefinition[],
): void {
  if (mappings === undefined) return;
  for (const [modelID, byClient] of Object.entries(mappings)) {
    if (!modelIDs.has(modelID)) {
      throw new Error(
        `provider ${providerID} reasoning effort mappings model ${JSON.stringify(modelID)} must reference an exact declared model id`,
      );
    }
    if (byClient === null || typeof byClient !== 'object') {
      throw new Error(`provider ${providerID} reasoning effort mappings model ${modelID} must be keyed by client id`);
    }
    for (const [clientID, byLevel] of Object.entries(byClient)) {
      if (clientID.trim() === '') {
        throw new Error(`provider ${providerID} reasoning effort mappings model ${modelID} has an empty client id`);
      }
      if (byLevel === null || typeof byLevel !== 'object') {
        throw new Error(
          `provider ${providerID} reasoning effort mappings model ${modelID} client ${clientID} must be keyed by reasoning effort`,
        );
      }
      for (const [effort, mapping] of Object.entries(byLevel)) {
        if (!REASONING_EFFORT_SET.has(effort)) {
          throw new Error(
            `provider ${providerID} reasoning effort mappings model ${modelID} client ${clientID} has invalid reasoning effort: ${JSON.stringify(effort)}`,
          );
        }
        if (!models.find(model => model.id === modelID)!.reasoningEfforts.includes(effort as ReasoningEffort)) throw new Error(`provider ${providerID} client ${clientID} mapping ${effort} must belong to the route ladder`);
        if (mapping === null || typeof mapping !== 'object') {
          throw new Error(
            `provider ${providerID} reasoning effort mappings model ${modelID} client ${clientID} level ${effort} must be an object`,
          );
        }
        if (mapping.environment !== undefined && (mapping.environment === null || typeof mapping.environment !== 'object' || Object.keys(mapping.environment).length === 0 || Object.entries(mapping.environment).some(([key, value]) => key.trim() === '' || typeof value !== 'string'))) throw new Error('reasoning mapping environment must be a non-empty string map');
        if (mapping.effort === undefined && mapping.model === undefined && mapping.environment === undefined) throw new Error('reasoning mapping must materialize an effort, model, or environment');
        if (mapping.model !== undefined && (typeof mapping.model !== 'string' || mapping.model.trim() === '')) {
          throw new Error(
            `provider ${providerID} reasoning effort mappings model ${modelID} client ${clientID} level ${effort} model must be a non-empty string`,
          );
        }
        if (mapping.effort !== undefined && (typeof mapping.effort !== 'string' || mapping.effort.trim() === '')) {
          throw new Error(
            `provider ${providerID} reasoning effort mappings model ${modelID} client ${clientID} level ${effort} effort must be a non-empty string`,
          );
        }
      }
    }
  }
}

const CURRENT_INTELLIGENCE_TIERS: ReadonlySet<string> = new Set(['low', 'mid', 'high', 'premium']);

// Strict normalizer: accepts only the four current tiers. Any other value,
// including unknown legacy tiers or the legacy 'frontier' alias, normalizes to
// undefined and is never emitted.
export function normalizeIntelligenceTier(tier: string | undefined): IntelligenceTier | undefined {
  if (tier === undefined) return undefined;
  return CURRENT_INTELLIGENCE_TIERS.has(tier) ? (tier as IntelligenceTier) : undefined;
}

function validateModelPricing(pricing: ModelPricing | undefined, label: string): void {
  if (!pricing) throw new Error(`${label} is missing required pricing metadata`);
  if (pricing.length !== 3) throw new Error(`${label} pricing must be [cached, input, output]`);
  for (const [index, value] of pricing.entries()) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} pricing[${index}] must be finite and non-negative`);
    }
  }
}

function requireID(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${kind} id is invalid: ${JSON.stringify(value)}`);
  }
}

// Every catalog speed must be a positive integer TPS, whether it is a
// model's required default or a canonical modelSpeedOverride.
function validateSpeed(speed: number | undefined, label: string): void {
  if (typeof speed !== 'number' || !Number.isInteger(speed) || speed <= 0) {
    throw new Error(`${label} speed must be a positive integer`);
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
  if (override !== undefined) {
    return {
      source: 'provider_override',
      tps: override,
    }
  }
  return {
    source: 'catalog_default',
    tps: modelDef.speed,
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
      validateSpeed(model.speed, `provider ${provider.id} model ${model.id}`);
      validateModelPricing(model.pricing, `provider ${provider.id} model ${model.id}`);
      if (model.free !== undefined && typeof model.free !== 'boolean') {
        throw new Error(`provider ${provider.id} model ${model.id} free must be a boolean`);
      }
      // Model-level supported-client restriction: a declared list must carry
      // unique, well-formed client ids; membership is enforced at run
      // resolution, not registration (clients may register after providers).
      if (model.supportedClients !== undefined) {
        const restrictedClients = new Set<string>();
        for (const clientID of model.supportedClients) {
          if (!clientID.trim()) throw new Error(`provider ${provider.id} model ${model.id} has an empty supported client id`);
          requireID('supported client', clientID);
          if (restrictedClients.has(clientID)) {
            throw new Error(`provider ${provider.id} model ${model.id} has duplicate supported client ${clientID}`);
          }
          restrictedClients.add(clientID);
        }
        if (restrictedClients.size === 0) {
          throw new Error(`provider ${provider.id} model ${model.id} supportedClients must not be empty`);
        }
      }
      validateReasoningEfforts(provider.id, model);
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
    // keys and unknown model keys are rejected, and every override must be a
    // finite positive TPS like a model's required default speed.
    for (const [modelID, override] of Object.entries(provider.modelSpeedOverrides ?? {})) {
      if (!modelIDs.has(modelID)) {
        throw new Error(
          `provider ${provider.id} model speed override ${JSON.stringify(modelID)} must reference an exact canonical model id`,
        );
      }
      validateSpeed(override, `provider ${provider.id} model speed override ${modelID}`);
    }
    // Reasoning-effort mappings may only reference exact declared model ids and
    // legal levels, and every mapping entry must be an object. References/values
    // are validated here so a registration never stages an unusable mapping.
    validateReasoningEffortMappings(provider.id, provider.reasoningEffortMappings, modelIDs, provider.models);
    // Every provider must declare a protocol-aware effort translator so a
    // resolved level is never silently dropped (no default/dont-send path).
    if (typeof provider.convertReasoningEffort !== 'function') {
      throw new Error(`provider ${provider.id} must declare convertReasoningEffort`);
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
        // Client-restricted models are usable only through their exact client
        // transport and are never published through the client-agnostic public
        // gateway directory.
        .filter((model) => model.supportedClients === undefined)
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
          reasoningEfforts: model.reasoningEfforts,
          ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
          ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
          pricing: model.pricing,
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
    // The public gateway is client-agnostic: a model restricted to specific
    // clients can never be resolved through a gateway protocol.
    if (model.supportedClients !== undefined) {
      throw new Error(`model ${publicID} is not available through the gateway`);
    }
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

  /**
   * The exact reasoning-effort subset a client can materialize for a route: the
   * route-owned ladder filtered to levels this exact client maps. A
   * header-forwarding Gateway client may inherit the route ladder. Every other
   * client needs an explicit mapping; missing or empty mappings are not dispatchable.
   */
  reasoningEfforts(clientID: string, providerID: string, modelID: string): readonly ReasoningEffort[] {
    const client = this.clientsByID.get(clientID);
    if (!client) throw new Error(`unknown client: ${clientID}`);
    const provider = this.providersByID.get(providerID);
    if (!provider) throw new Error(`unknown provider: ${providerID}`);
    const resolvedModelID = provider.modelAliases?.[modelID] ?? modelID;
    const modelDef = provider.models.find((model) => model.id === resolvedModelID);
    if (!modelDef) throw new Error(`unknown model: ${providerID}/${modelID}`);
    const byLevel = provider.reasoningEffortMappings?.[modelDef.id]?.[clientID];
    const forwardsGatewayEffort = client.forwardsGatewayReasoningEffort === true
      && !provider.nativeClients?.includes(clientID)
      && client.gatewayProtocols.some(protocol => provider.protocols?.some(capability => capability.protocol === protocol))
      && !client.unsupportedGatewayProviders?.includes(providerID)
      && (modelDef.supportedClients === undefined || modelDef.supportedClients.includes(clientID));
    if (byLevel === undefined && forwardsGatewayEffort) return modelDef.reasoningEfforts;
    if (byLevel === undefined) throw new Error(`client ${clientID} has no reasoning-effort mapping for ${providerID}/${modelDef.id}`);
    const subset = modelDef.reasoningEfforts.filter((effort) => byLevel[effort] !== undefined);
    if (subset.length === 0) {
      throw new Error(`client ${clientID} has no reasoning-effort mapping for ${providerID}/${modelDef.id}`);
    }
    return subset;
  }

  resolveRun(clientID: string, providerID: string, modelID: string, expected?: ReasoningEffort): DispatchPlan {
    const client = this.clientsByID.get(clientID);
    if (!client) throw new Error(`unknown client: ${clientID}`);
    const provider = this.providersByID.get(providerID);
    if (!provider) throw new Error(`unknown provider: ${providerID}`);
    modelID = provider.modelAliases?.[modelID] ?? modelID;
    const modelDef = provider.models.find((model) => model.id === modelID);
    if (!modelDef) throw new Error(`unknown model: ${providerID}/${modelID}`);
    // Model-level client restriction applies to native AND gateway runs alike:
    // a restricted model resolves only for its exact declared client ids.
    if (modelDef.supportedClients !== undefined && !modelDef.supportedClients.includes(clientID)) {
      throw new Error(`model ${providerID}/${modelID} is not available on client ${clientID}`);
    }
    // Runtime invalid *public enum* validation. A legal level is never rejected
    // here for being unsupported by a model/runtime; it is adapted into the
    // plan's runtime parameters by resolveReasoning.
    if (expected !== undefined && !REASONING_EFFORT_SET.has(expected)) {
      throw new Error(`invalid reasoning effort: ${JSON.stringify(expected)}`);
    }
    if (provider.nativeClients?.includes(clientID)) {
      const effortFields = this.resolveReasoning(provider, modelDef, clientID, expected);
      // Native web search is admitted ONLY for an explicitly supported native
      // client/provider pair: the client must declare supportsNativeWebSearch and
      // the resolved provider must be that client's exact nativeProvider. This is
      // native-provider capability alone — never third-party gateway support.
      const plan: DispatchPlan = { client: clientID, provider: providerID, model: modelID, mode: 'native', ...effortFields };
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
    const effortFields = this.resolveReasoning(provider, modelDef, clientID, expected);
    return { client: clientID, provider: providerID, model: modelID, mode: 'gateway', protocol, ...effortFields };
  }

  // Enumeration resolves compatibility only; operational callers supply an expectation.
  private resolveReasoning(
    provider: ProviderDefinition,
    modelDef: ModelDefinition,
    clientID: string,
    expected?: ReasoningEffort,
  ): Pick<DispatchPlan, 'reasoningEffort' | 'clientReasoningEffort' | 'clientReasoningEnvironment' | 'upstreamModel'> {
    const supported = this.reasoningEfforts(clientID, provider.id, modelDef.id);
    if (expected === undefined) return {};
    const selected = resolveReasoningEffort(expected, supported);
    const mapping = provider.reasoningEffortMappings?.[modelDef.id]?.[clientID]?.[selected] ?? { effort: selected };
    if (mapping.effort === undefined && mapping.model === undefined && mapping.environment === undefined) {
      throw new Error('reasoning-effort mapping must materialize an effort or model');
    }
    return { reasoningEffort: selected,
      ...(mapping.environment === undefined ? {} : { clientReasoningEnvironment: mapping.environment }),
      ...(mapping.effort === undefined ? {} : { clientReasoningEffort: mapping.effort }),
      ...(mapping.model === undefined ? {} : { upstreamModel: mapping.model }),
    };
  }

}

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
