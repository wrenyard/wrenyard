import { GATEWAY_PROTOCOLS, type GatewayProtocol, type IntelligenceTier, THINKING_LEVELS, type ThinkingLevel, THINKING_ORDER, INTELLIGENCE_ORDER, type ModelCapability, type ModelPricing, type SpeedSource, type SpeedEvidence, type CanonicalModelDefinition, type ModelDefinition, type DispatchCandidate, type LocalSpeedSample, type ClientDefinition, type PublicGatewayModel, type ResolvedGatewayModel, type DispatchPlan, type RunSyntaxRef, PUBLIC_CLIENT_KEYS, type ProtocolCapability, type ProviderDefinition, type ProviderThinkingMappings } from './contracts.ts';
export * from './contracts.ts';

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

// Normalizer: the single accepted input alias is the misspelling 'midium', which
// emits the canonical 'medium'. Every other unknown value normalizes to
// undefined and is never emitted.
export function normalizeThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
  if (level === undefined) return undefined;
  if (level === 'midium') return 'medium';
  return THINKING_LEVEL_SET.has(level) ? (level as ThinkingLevel) : undefined;
}

function validateThinkingLevels(providerID: string, model: ModelDefinition): void {
  const levels = model.thinkingLevels;
  if (levels === undefined) return;
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error(`provider ${providerID} model ${model.id} thinkingLevels must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const level of levels) {
    if (!THINKING_LEVEL_SET.has(level)) {
      throw new Error(
        `provider ${providerID} model ${model.id} has invalid thinking level: ${JSON.stringify(level)}`,
      );
    }
    if (seen.has(level)) {
      throw new Error(`provider ${providerID} model ${model.id} has duplicate thinking level ${level}`);
    }
    seen.add(level);
  }
}

function validateThinkingMappings(
  providerID: string,
  mappings: ProviderThinkingMappings | undefined,
  modelIDs: ReadonlySet<string>,
): void {
  if (mappings === undefined) return;
  for (const [modelID, byClient] of Object.entries(mappings)) {
    if (!modelIDs.has(modelID)) {
      throw new Error(
        `provider ${providerID} thinking mappings model ${JSON.stringify(modelID)} must reference an exact declared model id`,
      );
    }
    if (byClient === null || typeof byClient !== 'object') {
      throw new Error(`provider ${providerID} thinking mappings model ${modelID} must be keyed by client id`);
    }
    for (const [clientID, byLevel] of Object.entries(byClient)) {
      if (clientID.trim() === '') {
        throw new Error(`provider ${providerID} thinking mappings model ${modelID} has an empty client id`);
      }
      if (byLevel === null || typeof byLevel !== 'object') {
        throw new Error(
          `provider ${providerID} thinking mappings model ${modelID} client ${clientID} must be keyed by thinking level`,
        );
      }
      for (const [level, mapping] of Object.entries(byLevel)) {
        if (!THINKING_LEVEL_SET.has(level)) {
          throw new Error(
            `provider ${providerID} thinking mappings model ${modelID} client ${clientID} has invalid thinking level: ${JSON.stringify(level)}`,
          );
        }
        if (mapping === null || typeof mapping !== 'object') {
          throw new Error(
            `provider ${providerID} thinking mappings model ${modelID} client ${clientID} level ${level} must be an object`,
          );
        }
        if (mapping.model !== undefined && (typeof mapping.model !== 'string' || mapping.model.trim() === '')) {
          throw new Error(
            `provider ${providerID} thinking mappings model ${modelID} client ${clientID} level ${level} model must be a non-empty string`,
          );
        }
        if (mapping.effort !== undefined && (typeof mapping.effort !== 'string' || mapping.effort.trim() === '')) {
          throw new Error(
            `provider ${providerID} thinking mappings model ${modelID} client ${clientID} level ${level} effort must be a non-empty string`,
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
      validateThinkingLevels(provider.id, model);
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
    // Thinking mappings may only reference exact declared model ids and legal
    // levels, and every mapping entry must be an object. References/values are
    // validated here so a registration never stages an unusable mapping.
    validateThinkingMappings(provider.id, provider.thinkingMappings, modelIDs);
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
          ...(model.thinkingLevels === undefined ? {} : { thinkingLevels: model.thinkingLevels }),
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

  resolveRun(clientID: string, providerID: string, modelID: string, thinking?: ThinkingLevel): DispatchPlan {
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
    // plan's runtime parameters by resolveThinking.
    if (thinking !== undefined && !THINKING_LEVEL_SET.has(thinking)) {
      throw new Error(`invalid thinking level: ${JSON.stringify(thinking)}`);
    }
    const thinkingFields = this.resolveThinking(provider, modelDef, clientID, thinking);
    if (provider.nativeClients?.includes(clientID)) {
      // Native web search is admitted ONLY for an explicitly supported native
      // client/provider pair: the client must declare supportsNativeWebSearch and
      // the resolved provider must be that client's exact nativeProvider. This is
      // native-provider capability alone — never third-party gateway support.
      const plan: DispatchPlan = { client: clientID, provider: providerID, model: modelID, mode: 'native', ...thinkingFields };
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
    return { client: clientID, provider: providerID, model: modelID, mode: 'gateway', protocol, ...thinkingFields };
  }

  // Resolves the thinking portion of a plan by parameter adaptation. Only a
  // *public* invalid enum value is a hard error; an unsupported-but-legal level
  // is never a rejection. A level is usable only when the model declares it AND
  // this exact client has an explicit mapping for it — the intersection is the
  // sole candidate set:
  // - No usable level at all (no declared levels, no exact-client mappings, or
  //   an empty intersection): the plan carries no thinking and no transport is
  //   invented.
  // - Omitted request: the highest usable level.
  // - Requested level: the smallest usable level >= the request, else the
  //   highest usable level.
  // Only an explicit mapping may set upstreamModel / mapped wire reasoningEffort.
  private resolveThinking(
    provider: ProviderDefinition,
    modelDef: ModelDefinition,
    clientID: string,
    requested?: ThinkingLevel,
  ): Pick<DispatchPlan, 'thinking' | 'reasoningEffort' | 'upstreamModel'> {
    const byLevel = provider.thinkingMappings?.[modelDef.id]?.[clientID];
    // Usable = declared by the model AND explicitly mapped for this exact client.
    const usable = (modelDef.thinkingLevels ?? []).filter((level) => byLevel?.[level] !== undefined);
    if (usable.length === 0) return {};
    const ordered = [...usable].sort((a, b) => THINKING_ORDER[a] - THINKING_ORDER[b]);
    let selected: ThinkingLevel;
    if (requested === undefined) {
      // Omitted request selects the highest usable level.
      selected = ordered[ordered.length - 1]!;
    } else {
      // Requested level adapts to the smallest usable level at or above it,
      // otherwise to the highest usable level.
      const atOrAbove = ordered.find((level) => THINKING_ORDER[level] >= THINKING_ORDER[requested]);
      selected = atOrAbove ?? ordered[ordered.length - 1]!;
    }
    const mapping = byLevel![selected]!;
    return {
      thinking: selected,
      ...(mapping.effort === undefined ? {} : { reasoningEffort: mapping.effort }),
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
