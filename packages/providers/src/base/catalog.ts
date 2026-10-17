import { isMainstreamModelId, models, REASONING_EFFORTS, resolveReasoningEffort, type ReasoningEffort } from '@wrenyard/models';
import { GATEWAY_PROTOCOLS, type GatewayProtocol, type IntelligenceTier, INTELLIGENCE_ORDER, type ModelCapability, type ModelPricing, type SpeedSource, type SpeedEvidence, type CanonicalModelDefinition, type ModelDefinition, type DispatchCandidate, type LocalSpeedSample, type ClientDefinition, type PublicGatewayModel, type ResolvedGatewayModel, type DispatchPlan, type RunSyntaxRef, PUBLIC_CLIENT_KEYS, type ProtocolCapability, type ProviderDefinition, type ProviderReasoningEffortMappings, type GatewayModelSelector } from './contracts.ts';
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
  // An empty array is a valid declaration: the route materializes no effort
  // level (a model whose ladder is genuinely unknown). It is never rejected.
  if (!Array.isArray(efforts)) {
    throw new Error(`provider ${providerID} model ${model.id} reasoningEfforts must be an array`);
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

/**
 * Validate one offering snapshot against the shared model registry. Every
 * active offering must carry an exact registered model id, resolve to a
 * registration with a legal intelligence tier and a positive default speed, and
 * declare its own legal tier and positive speed. A snapshot may never publish
 * one identity twice. This applies to both the initial registration and every
 * provider-published replacement snapshot, so a discovery refresh cannot
 * bypass the identity or metadata contract.
 */
export function validateOfferingSnapshot(providerID: string, offerings: readonly ModelDefinition[]): void {
  const seen = new Set<string>();
  for (const model of offerings) {
    if (!model.id.trim()) throw new Error(`provider ${providerID} has an empty model id`);
    if (seen.has(model.id)) throw new Error(`provider ${providerID} has duplicate model ${model.id}`);
    const registered = models.get(model.id);
    if (!registered) {
      throw new Error(`provider ${providerID} model ${model.id} must be a registered model id`);
    }
    // The registered identity is the metadata authority: an incomplete
    // registration can never become a usable offering.
    if (!CURRENT_INTELLIGENCE_TIERS.has(registered.defaults.intelligence)) {
      throw new Error(`provider ${providerID} model ${model.id} must resolve a valid registered intelligence tier`);
    }
    validateSpeed(registered.defaults.speed, `provider ${providerID} model ${model.id} registry default`);
    // The resolved offering carries the same required facts.
    if (!CURRENT_INTELLIGENCE_TIERS.has(model.intelligence)) {
      throw new Error(`provider ${providerID} model ${model.id} must declare a valid intelligence tier`);
    }
    validateSpeed(model.speed, `provider ${providerID} model ${model.id}`);
    if (model.canonicalModel !== undefined && model.canonicalModel.id !== model.id) {
      throw new Error(
        `provider ${providerID} model ${model.id} must name itself as its canonical model, not ${model.canonicalModel.id}`,
      );
    }
    seen.add(model.id);
  }
}

// Every catalog speed must be a positive integer TPS, whether it is a
// model's required default or a canonical modelSpeedOverride.
function validateSpeed(speed: number | undefined, label: string): void {
  if (typeof speed !== 'number' || !Number.isInteger(speed) || speed <= 0) {
    throw new Error(`${label} speed must be a positive integer`);
  }
}

// Measured-speed provenance may only reference exact declared model ids, must
// back an existing integer override for the same id, and must describe a real
// measurement: a finite positive initial TPS, a parseable timestamp, and a
// non-empty method.
function validateModelSpeedMeasurements(
  providerID: string,
  measurements: ProviderDefinition['modelSpeedMeasurements'],
  overrides: ProviderDefinition['modelSpeedOverrides'],
  modelIDs: ReadonlySet<string>,
): void {
  if (measurements === undefined) return;
  for (const [modelID, measurement] of Object.entries(measurements)) {
    if (!modelIDs.has(modelID)) {
      throw new Error(
        `provider ${providerID} model speed measurement ${JSON.stringify(modelID)} must reference an exact canonical model id`,
      );
    }
    if (measurement === null || typeof measurement !== 'object') {
      throw new Error(`provider ${providerID} model speed measurement ${modelID} must be an object`);
    }
    if (!Number.isFinite(measurement.initialTps) || measurement.initialTps <= 0) {
      throw new Error(`provider ${providerID} model speed measurement ${modelID} initialTps must be finite and positive`);
    }
    if (typeof measurement.measuredAt !== 'string' || !Number.isFinite(new Date(measurement.measuredAt).getTime())) {
      throw new Error(`provider ${providerID} model speed measurement ${modelID} measuredAt must be a valid date`);
    }
    if (typeof measurement.method !== 'string' || measurement.method.trim() === '') {
      throw new Error(`provider ${providerID} model speed measurement ${modelID} method must be a non-empty string`);
    }
    if (overrides?.[modelID] === undefined) {
      throw new Error(
        `provider ${providerID} model speed measurement ${modelID} must have a matching modelSpeedOverrides entry`,
      );
    }
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
 * registered catalog default speed. Matching is by exact provider.id/modelDef.id
 * only — no alias, client, or profile remap — and any sample missing, malformed,
 * future, or older than 31 days is skipped.
 *
 * The registry invariant guarantees a positive default speed for every
 * registered offering, so this always returns an evidence tier. A provider
 * override is pair-specific evidence for its own provider only; another
 * provider's measurement is never borrowed and the default is never reported as
 * a measurement. Used by resolveConstrainedDispatch and the Foreman failure
 * diagnostics so the precedence logic is never duplicated.
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

/**
 * Routing-only reference output price of one route (USD per M output tokens).
 *
 * Every route branches on the explicit free flag first: a route whose model is
 * an explicit free offering (`free === true`) is always `kind: 'free'`, whether
 * or not it also declares a pricing tuple. A declared tuple is retained only as
 * the optional free reference price so a known list price still caps the route;
 * a free route that publishes no price keeps the bare `free` marker rather than
 * a synthesized zero. Only a non-free route with a declared tuple is `priced`.
 * Every other price-less route returns undefined: its price is genuinely unknown
 * and is never inferred as free, and never treated as zero.
 */
export type RoutingReferencePrice =
  | { readonly kind: 'priced'; readonly outputUsdPerMillion: number }
  | { readonly kind: 'free'; readonly outputUsdPerMillion?: number }

export function routingReferencePriceOf(
  model: Pick<ModelDefinition, 'pricing' | 'free'>,
): RoutingReferencePrice | undefined {
  if (model.free === true) {
    return model.pricing === undefined
      ? { kind: 'free' }
      : { kind: 'free', outputUsdPerMillion: model.pricing[2] }
  }
  if (model.pricing !== undefined) return { kind: 'priced', outputUsdPerMillion: model.pricing[2] }
  return undefined
}

/** True when the provider records valid measured speed provenance for one
 *  exact declared model id: a usable measurement entry plus the integer
 *  override it backs. Catalog defaults and local samples are NOT provenance. */
function hasMeasuredSpeedProvenance(provider: ProviderDefinition, modelID: string): boolean {
  const measurement = provider.modelSpeedMeasurements?.[modelID]
  if (measurement === undefined) return false
  if (provider.modelSpeedOverrides?.[modelID] === undefined) return false
  return Number.isFinite(measurement.initialTps) && measurement.initialTps > 0
    && typeof measurement.measuredAt === 'string' && Number.isFinite(new Date(measurement.measuredAt).getTime())
    && typeof measurement.method === 'string' && measurement.method.trim() !== ''
}

/**
 * Explicit free automatic-eligibility of one route — the single shared decision
 * for automatic Task and auxiliary selection.
 *
 * Free status is decided by the explicit `free: true` flag alone, never by a
 * price. A non-free route passes unchanged. An explicitly free offering is
 * auto-eligible only when its registered identity is in the mainstream list AND
 * the provider records real measured speed provenance for its exact id with a
 * matching override. Every other free offering stays chat-picker-only and is
 * never auto-selected.
 *
 * The static mainstream+measured gate applies to a statically-declared free
 * offering. Live upstream confirmed-free evidence is a different fact: when the
 * provider reports the model free right now (`liveConfirmedFree`), the model is
 * admitted from its own free pool without the static gate, because that pool —
 * not the static list — is what bounds its cost.
 */
export type ExplicitFreeAutoEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: 'free_not_mainstream' | 'free_missing_measured_tps' }

export function explicitFreeAutoEligibility(
  provider: ProviderDefinition,
  model: ModelDefinition,
  liveConfirmedFree: boolean = false,
): ExplicitFreeAutoEligibility {
  // Non-free routes carry no free-offering restriction: this gate never adds a
  // new constraint to a paid route.
  if (model.free !== true) return { eligible: true }
  // Live upstream evidence admits the model from its own free pool; the static
  // mainstream id and measured TPS checks describe statically-declared offerings.
  if (liveConfirmedFree === true) return { eligible: true }
  // One identity: the offering's registered id is the only mainstream test.
  if (!isMainstreamModelId(model.id)) return { eligible: false, reason: 'free_not_mainstream' }
  if (!hasMeasuredSpeedProvenance(provider, model.id)) return { eligible: false, reason: 'free_missing_measured_tps' }
  return { eligible: true }
}

export class Catalog {
  private readonly providersByID = new Map<string, ProviderDefinition>();
  private readonly clientsByID = new Map<string, ClientDefinition>();
  private readonly canonicalModelNamesByID = new Map<string, string>();

  registerProvider(provider: ProviderDefinition): void {
    requireID('provider', provider.id);
    if (this.providersByID.has(provider.id)) throw new Error(`duplicate provider: ${provider.id}`);
    // The initial snapshot obeys the same identity contract as every later
    // replacement snapshot: registered ids only, no duplicate offering.
    validateOfferingSnapshot(provider.id, provider.models);
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
          `provider ${provider.id} model ${model.id} must declare a valid intelligence tier`,
        );
      }
      // Every offering carries the required catalog default speed and
      // intelligence resolved from its registered identity.
      validateSpeed(model.speed, `provider ${provider.id} model ${model.id}`);
      if (model.pricing !== undefined) validateModelPricing(model.pricing, `provider ${provider.id} model ${model.id}`);
      if (model.free !== undefined && typeof model.free !== 'boolean') {
        throw new Error(`provider ${provider.id} model ${model.id} free must be a boolean`);
      }
      // Model-level supported-client declaration: a declared list must carry
      // unique, well-formed client ids; membership is enforced at run
      // resolution, not registration (clients may register after providers). An
      // EMPTY list is a valid declaration — the model supports no external
      // client for any run — and is never rejected here.
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
    // Measured-speed provenance references exact declared model ids and must
    // back an existing integer override, so a free route can never claim
    // recorded evidence without the override it is evidence for.
    validateModelSpeedMeasurements(provider.id, provider.modelSpeedMeasurements, provider.modelSpeedOverrides, modelIDs);
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

  /**
   * Live catalog-level free flag of one exact provider/model row. This reads the
   * same definition object the provider republishes when its upstream catalog
   * refreshes, so it follows the live `free` value rather than any static list.
   * It is not an authoritative authenticated check: the runtime `freeSupply`
   * fact downstream remains the confirmation that a route is actually free.
   */
  confirmedFreeSupply(providerId: string, modelId: string): boolean {
    const provider = this.providersByID.get(providerId);
    if (!provider) return false;
    const model = provider.models.find((m) => m.id === modelId);
    return model?.free === true;
  }

  /**
   * The complete, protocol-independent public model directory. Every
   * credential-backed provider model is listed exactly once with the entry
   * protocols it is served on, so a consumer selects a protocol itself instead
   * of re-deriving ownership from the provider definition.
   */
  gatewayModels(
    credentialAvailable: (provider: ProviderDefinition) => boolean = () => true,
  ): PublicGatewayModel[] {
    return this.providers()
      .filter((provider) => credentialAvailable(provider))
      .flatMap((provider) => {
        const protocols = (provider.protocols ?? []).map((entry) => entry.protocol);
        if (protocols.length === 0) return [];
        return provider.models
          .filter((model) => !model.taskOnly)
          // Only a NON-EMPTY client restriction hides the model from the
          // client-agnostic public gateway directory: such models are usable
          // solely through their exact client transport. A model with an empty
          // list supports no client for a *task* run but stays valid for direct,
          // client-agnostic gateway session turns, so it is still published.
          .filter((model) => (model.supportedClients?.length ?? 0) === 0)
          .map((model) => ({
            id: model.id,
            displayName: model.displayName,
            provider: provider.id,
            publicId: `${provider.id}/${model.id}`,
            protocols: [...protocols],
            // Speed and intelligence are required registered facts, carried
            // through verbatim: the directory never substitutes a zero speed or
            // a made-up intelligence tier.
            speed: model.speed,
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
            ...(model.family === undefined ? {} : { family: model.family }),
            ...(model.claudeTier === undefined ? {} : { claudeTier: model.claudeTier }),
            ...(model.supports1MContext === undefined ? {} : { supports1MContext: model.supports1MContext }),
            ...(model.supportsFast === true ? { supportsFast: true } : {}),
            intelligence: model.intelligence,
            reasoningEfforts: model.reasoningEfforts,
            ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
            ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
            ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
          }));
      });
  }

  listGatewayModels(
    protocol: GatewayProtocol,
    credentialAvailable: (provider: ProviderDefinition) => boolean = () => true,
  ): PublicGatewayModel[] {
    return this.gatewayModels(credentialAvailable).filter((model) => model.protocols.includes(protocol));
  }

  /**
   * Resolve one Gateway request. `selector` carries the bare registered model
   * id and an optional provider; a caller may also pass the two parts directly.
   *
   * An explicit provider always wins. Without one, the provider is inferred only
   * when exactly one provider offers the registered id on this protocol —
   * ambiguity is rejected instead of guessing. Qualified ids (`provider/model`)
   * and historical wire aliases are not accepted as new request identities:
   * both describe a different namespace and must be migrated by the caller.
   *
   * The returned `publicId` stays provider-qualified because it is the internal
   * route key for health, quota and statistics; the public identity of the
   * resolved model is always `model.id`.
   */
  resolveGatewayModel(
    protocol: GatewayProtocol,
    selector: string | GatewayModelSelector,
    providerID?: string,
    credentialAvailableProviderIDs: ReadonlySet<string> = new Set(),
  ): ResolvedGatewayModel {
    const requestedModelID = (typeof selector === 'string' ? selector : selector.model).trim();
    const requestedProviderID = (typeof selector === 'string' ? providerID : selector.provider)?.trim();
    if (requestedModelID === '') throw new Error('model must be a registered model id');
    // A registered id never contains the provider separator; a qualified value
    // belongs to the old public-route namespace and is rejected explicitly.
    if (requestedModelID.includes('/')) {
      throw new Error(
        `model must be a registered model id, not a provider-qualified id: ${requestedModelID}; send X-Wrenyard-Provider to select the provider`,
      );
    }
    const provider = requestedProviderID === undefined || requestedProviderID === ''
      ? this.inferGatewayProvider(protocol, requestedModelID, credentialAvailableProviderIDs)
      : this.providersByID.get(requestedProviderID);
    if (!provider) throw new Error(`unknown provider: ${requestedProviderID}`);
    // Wire aliases stay private: a new request names the registered id only.
    if (provider.modelAliases?.[requestedModelID] !== undefined) {
      throw new Error(
        `model ${requestedModelID} is a wire alias, not a registered model id for provider ${provider.id}`,
      );
    }
    const model = provider.models.find((entry) => entry.id === requestedModelID && !entry.taskOnly);
    if (!model) throw new Error(`provider ${provider.id} does not offer registered model ${requestedModelID}`);
    // The public gateway is client-agnostic: only a NON-EMPTY client
    // restriction forbids resolution here. An empty list (no external client for
    // a task run) is still served for direct, client-agnostic session turns.
    if ((model.supportedClients?.length ?? 0) > 0) {
      throw new Error(`model ${requestedModelID} is not available through the gateway`);
    }
    const capability = provider.protocols?.find((entry) => entry.protocol === protocol);
    if (!capability) throw new Error(`model ${requestedModelID} does not support ${protocol}`);
    return {
      provider,
      model,
      capability,
      publicId: `${provider.id}/${model.id}`,
      // The exact private binding wins; a route without one sends its
      // registered id verbatim.
      upstreamModel: capability.upstreamModels?.[model.id] ?? model.upstreamId ?? model.id,
    };
  }

  /**
   * The single provider that offers one registered id on a protocol. A
   * registered id served by several providers is genuinely ambiguous: the
   * caller must name the provider instead of relying on declaration order.
   */
  private inferGatewayProvider(
    protocol: GatewayProtocol,
    modelID: string,
    credentialAvailableProviderIDs: ReadonlySet<string>,
  ): ProviderDefinition {
    const candidates = this.providers()
      .filter((provider) => credentialAvailableProviderIDs.has(provider.id))
      .filter((provider) => provider.protocols?.some((entry) => entry.protocol === protocol))
      .filter((provider) => provider.modelAliases?.[modelID] === undefined)
      .filter((provider) => provider.models.some((model) =>
        model.id === modelID && !model.taskOnly && (model.supportedClients?.length ?? 0) === 0));
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) throw new Error(`no available provider offers registered model ${modelID}`);
    throw new Error(
      `model ${modelID} is offered by several providers (${candidates.map((entry) => entry.id).join(', ')}); select one with the provider selector`,
    );
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
      && (modelDef.supportedClients === undefined || modelDef.supportedClients.length === 0 || modelDef.supportedClients.includes(clientID));
    if (byLevel === undefined && forwardsGatewayEffort) return modelDef.reasoningEfforts;
    if (byLevel === undefined) throw new Error(`client ${clientID} has no reasoning-effort mapping for ${providerID}/${modelDef.id}`);
    const subset = modelDef.reasoningEfforts.filter((effort) => byLevel[effort] !== undefined);
    if (subset.length === 0) {
      throw new Error(`client ${clientID} has no reasoning-effort mapping for ${providerID}/${modelDef.id}`);
    }
    return subset;
  }

  /**
   * True when the exact client/provider/model combination has a verified Fast
   * capability on the transport a task run would actually use. A task run can
   * only materialize Fast through a provider-owned native model mapping: the
   * gateway protocol-field mapping is an entry-protocol surface that the task's
   * native client never injects, so it is not evidence of task Fast support.
   * The model itself must declare `supportsFast`, and absence is never inferred
   * as support.
   */
  supportsFast(clientID: string, providerID: string, modelID: string): boolean {
    const client = this.clientsByID.get(clientID);
    if (!client) return false;
    const provider = this.providersByID.get(providerID);
    if (!provider) return false;
    const resolvedModelID = provider.modelAliases?.[modelID] ?? modelID;
    const modelDef = provider.models.find((model) => model.id === resolvedModelID);
    if (modelDef?.supportsFast !== true) return false;
    return provider.nativeClients?.includes(clientID) === true && provider.fastMapping?.model !== undefined;
  }

  resolveRun(clientID: string, providerID: string, modelID: string, expected?: ReasoningEffort, fast?: boolean): DispatchPlan {
    const client = this.clientsByID.get(clientID);
    if (!client) throw new Error(`unknown client: ${clientID}`);
    const provider = this.providersByID.get(providerID);
    if (!provider) throw new Error(`unknown provider: ${providerID}`);
    modelID = provider.modelAliases?.[modelID] ?? modelID;
    const modelDef = provider.models.find((model) => model.id === modelID);
    if (!modelDef) throw new Error(`unknown model: ${providerID}/${modelID}`);
    // Model-level client restriction applies to native AND gateway runs alike.
    // A NON-EMPTY list resolves only for its exact declared client ids; an EMPTY
    // list supports no client for any run, so every client is rejected before
    // launch. Direct, client-agnostic gateway session turns do not go through
    // resolveRun and stay available (see resolveGatewayModel).
    const restrictedClients = modelDef.supportedClients;
    if (restrictedClients !== undefined && restrictedClients.length > 0 && !restrictedClients.includes(clientID)) {
      throw new Error(`model ${providerID}/${modelID} is not available on client ${clientID}`);
    }
    if (restrictedClients !== undefined && restrictedClients.length === 0) {
      throw new Error(`model ${providerID}/${modelID} is not supported by this client`);
    }
    // Runtime invalid *public enum* validation. A legal level is never rejected
    // here for being unsupported by a model/runtime; it is adapted into the
    // plan's runtime parameters by resolveReasoning.
    if (expected !== undefined && !REASONING_EFFORT_SET.has(expected)) {
      throw new Error(`invalid reasoning effort: ${JSON.stringify(expected)}`);
    }
    if (provider.nativeClients?.includes(clientID)) {
      // An explicitly defined Fast preference is admitted only when this exact
      // client/provider/model pair owns a verified native Fast mapping. Both
      // true and false fail closed here instead of being silently dropped or
      // passed through; an absent preference keeps the unchanged behavior.
      if (fast !== undefined && !this.supportsFast(clientID, providerID, modelID)) {
        throw new Error(`Fast mode is unavailable for model ${providerID}/${modelID} on client ${clientID}`);
      }
      const effortFields = this.resolveReasoning(provider, modelDef, clientID, expected);
      // Fast combines with the unchanged reasoning-effort mapping: the native
      // mapping transforms the model the effort mapping already resolved, so
      // the effort itself is never altered. Both true and false are explicit.
      const fastModel = provider.fastMapping?.model;
      const mappedModel = fast === undefined || modelDef.supportsFast !== true || fastModel === undefined
        ? effortFields.upstreamModel
        : fastModel(effortFields.upstreamModel ?? modelDef.id, modelDef.id, fast);
      // Native web search is admitted ONLY for an explicitly supported native
      // client/provider pair: the client must declare supportsNativeWebSearch and
      // the resolved provider must be that client's exact nativeProvider. This is
      // native-provider capability alone — never third-party gateway support.
      const plan: DispatchPlan = {
        client: clientID,
        provider: providerID,
        model: modelID,
        mode: 'native',
        ...effortFields,
        ...(mappedModel === undefined ? {} : { upstreamModel: mappedModel }),
        ...(fast === undefined ? {} : { fast }),
      };
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
    // A gateway task run has no body injection: neither an on nor an off Fast
    // request can reach the upstream, because only a provider-owned native
    // model mapping carries it and gateway mode does not use one. Any explicit
    // preference fails closed instead of dispatching while ignoring it; an
    // absent preference keeps Fast off the plan.
    if (fast !== undefined) {
      throw new Error(`Fast mode for ${providerID}/${modelID} on client ${clientID} is not injectable by a gateway task run; only a verified native Fast mapping is supported`);
    }
    const effortFields = this.resolveReasoning(provider, modelDef, clientID, expected);
    return {
      client: clientID,
      provider: providerID,
      model: modelID,
      mode: 'gateway',
      protocol,
      ...effortFields,
    };
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

/**
 * The model part of a client-qualified model key. A native task route carries
 * the resolved client as a `:<client>` suffix (`deepseek-v4.1-flash-free:oc`),
 * while an upstream model id may itself end in a `:free` variant. Only a known
 * public client key is treated as a suffix; any other colon-bearing id is
 * returned unchanged, so a `:free` variant keeps its exact identity.
 */
export function bareModelId(model: string): string {
  const colon = model.lastIndexOf(':');
  if (colon <= 0) return model;
  return PUBLIC_CLIENT_KEYS[model.slice(colon + 1)] === undefined ? model : model.slice(0, colon);
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
