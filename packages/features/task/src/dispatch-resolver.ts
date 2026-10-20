import type { Catalog, DispatchCandidate, DispatchPlan, LocalSpeedSample, ModelDefinition, SpeedEvidence } from '@wrenyard/providers/catalog';
import type { TaskDispatchRequirements } from '@wrenyard/auto-routing';
import { formatRunSyntax, INTELLIGENCE_ORDER, parseRunSyntax, resolveModelSpeed, routingReferencePriceOf, explicitFreeAutoEligibility } from '@wrenyard/providers/catalog';
import { excludedModelIdsFor, resolveConstrainedDispatch } from '@wrenyard/auto-routing';
import { resolveHistoricalOfferedModelId, resolveRuntimeTaskPlans, type ProviderRuntime } from '@wrenyard/providers'
import { isMainstreamModelId } from '@wrenyard/models'
import type { TaskResolvedDispatch } from '@wrenyard/protocol'
import {
  selectTaskResolutionFailure,
  type TaskResolutionElimination,
  type TaskResolutionFailureCode,
  type TaskResolutionFailureDetail,
} from './task-resolution-failure.ts'

/**
 * Canonical daemon-side task dispatch resolver.
 *
 * The resolver is a thin adapter over `@wrenyard/providers/catalog`: it derives the
 * trusted dispatch plans and resolves the runtime task plans through the
 * catalog/provider runtime, supplies per-provider/model measured TPS
 * evidence through a lazy injected source, and returns exactly one eligible
 * plan with a full, truthful canonical provider/model:client snapshot. It never
 * probes the network or invokes a model; speed, pricing, and intelligence are
 * read from the catalog and the local samples, and a candidate with missing
 * evidence is failed (NO_ELIGIBLE_PROFILE), never admitted with fabricated
 * values.
 *
 * Every runtime identity is a canonical dynamic target
 * (`<provider>/<model>:<client>`) resolved through the live Catalog. Automatic
 * selection is driven solely by `catalog.enumerateTaskCandidates` and the
 * derived runtime plans; both are re-enumerated once per resolution so a
 * discovery refresh becomes task-usable without a daemon restart, while a
 * single resolution keeps one consistent snapshot.
 */

export class NoEligiblePlanError extends Error {
  readonly code = 'NO_ELIGIBLE_PROFILE' as const
  constructor(
    readonly taskName: string,
    readonly candidates: ReadonlyArray<{ profileId: string; client: string; provider: string; model: string }>,
    readonly requirements: TaskDispatchRequirements,
    /** Closed machine code of the real gate that eliminated the plan. Defaults
     *  to no_available_provider so legacy/test callers keep the historic error. */
    readonly resolutionFailureCode: TaskResolutionFailureCode = 'no_available_provider',
  ) {
    super(resolutionFailureCode === 'context_window'
      ? `No available model can fit task '${taskName}': estimated ${requirements.inputTokens} input tokens plus model output allowance exceeds the context window`
      : `no eligible dispatch plan for task '${taskName}'`)
    this.name = 'NoEligiblePlanError'
  }
}

export interface TaskDispatchResolverDeps {
  catalog: Catalog
  runtime: ProviderRuntime
  /** Lazy source of per-provider/model measured TPS samples. */
  localSpeed?: () => LocalSpeedSample[]
}

export interface ResolveTaskDispatchInput {
  taskName: string
  requirements: TaskDispatchRequirements
  /** Canonical provider/model:client target, or absent for automatic selection. */
  target?: string
}

export type TaskDispatchResolution =
  | { ok: true; exactAgentRuntime: string; resolved: TaskResolvedDispatch }
  | { ok: false; error: NoEligiblePlanError }

/**
 * Eligible projection input. Mirrors `resolve` minus the machine preference
 * surface: automatic eligibility never depends on an operator preference, only
 * on the task's declared runtime semantics and its hard dispatch requirements.
 */
export interface TaskDispatchEligibleInput {
  taskName: string
  requirements: TaskDispatchRequirements
  /** Canonical target constraint. Never a machine preference. */
  target?: string
}

/**
 * One exact runtime choice: the full resolved-dispatch snapshot (the same
 * client/provider/model/model_id/mode/protocol/speed/intelligence/
 * reference_pricing fields as `resolve`) plus its exact canonical dynamic
 * target (`'<provider>/<model>:<client>'`). Legacy policy strings
 * (fast/general/ultra) are never returned as choices.
 */
export type TaskDispatchChoice = TaskResolvedDispatch & { exactAgentRuntime: string }

export type TaskDispatchEligibleResult =
  | { ok: true; choices: TaskDispatchChoice[] }
  | { ok: false; error: NoEligiblePlanError }

/**
 * One diagnostic choice of the read-only routing form. `available` records
 * BASELINE availability (the candidate can produce a truthful resolved
 * snapshot with no submitted gates at all), so a pair rejected by a submitted
 * task gate still appears. `admitted` carries the resolved dispatch when every
 * submitted requirement admitted the candidate; `rejectionCode` is the closed
 * code of the first submitted gate that rejected it. Clients are never
 * projected or split through this surface — consumers collapse to
 * provider+model.
 */
export interface TaskDispatchDiagnosticChoice {
  exactAgentRuntime: string
  /** Baseline availability with NO submitted requirements. */
  available: boolean
  baseline?: TaskResolvedDispatch
  /** Truthful resolved dispatch when the submitted requirements admitted it. */
  admitted?: TaskResolvedDispatch
  /** Closed code of the first submitted gate that rejected the candidate. */
  rejectionCode?: TaskResolutionFailureCode
  /** Closed specific cause behind `rejectionCode` when the gate is a
   *  qualitative one (exclusion, unresolvable runtime, unsupported search or
   *  input capability). Absent for the numeric gates, which the code already
   *  names exactly. Never raw exception text. */
  rejectionDetail?: TaskResolutionFailureDetail
}

export type TaskDispatchDiagnosticResult =
  | { ok: true; choices: TaskDispatchDiagnosticChoice[] }
  | { ok: false; error: NoEligiblePlanError }

/** Input for the read-only Catalog display-label projection. */
export interface TaskDispatchDisplayLabelsInput {
  provider: string
  model: string
}

/** Authoritative Catalog display labels of an already-resolved canonical pair. */
export interface TaskDispatchDisplayLabels {
  /** Canonical provider id of the resolved pair. */
  provider: string
  /** Authoritative Catalog provider display label. */
  providerDisplayName: string
  /** Canonical model id of the resolved pair. */
  model: string
  /** Authoritative unified Catalog model display label. */
  modelDisplayName: string
}

export interface TaskDispatchResolver {
  resolve(input: ResolveTaskDispatchInput): Promise<TaskDispatchResolution>
  /**
   * Enumerates every exact runtime choice currently satisfying the same
   * declared-runtime semantics and hard requirements as `resolve`. A policy
   * or absent declared runtime evaluates every exact canonical candidate.
   * Eligibility is never relaxed against resolve admission.
   */
  eligible(input: TaskDispatchEligibleInput): Promise<TaskDispatchEligibleResult>

  /**
   * Read-only per-exact-candidate diagnostic over the same candidate pool and
   * admission as `eligible`. Baseline availability is evaluated with NO
   * submitted requirements (so a candidate rejected by a submitted task gate
   * still reports `available: true`), and every submitted requirement is then
   * replayed through the authoritative admission to classify the candidate as
   * `admitted` or with its first closed `rejectionCode`. This reuses the exact
   * `evaluate`/gate-replay path `resolve` and `eligible` use — no duplicate
   * filter, scorer, or probe. Pure and side-effect free.
   */
  diagnose(input: TaskDispatchEligibleInput): Promise<TaskDispatchDiagnosticResult>

  /**
   * Read-only Catalog-backed display-label projection for an already-resolved
   * canonical provider/model pair. Returns the authoritative provider display
   * label and the unified model display label; undefined when the provider is
   * not registered in the Catalog. This projection never admits, ranks,
   * probes quota/readiness, falls back, or changes dispatch semantics.
   */
  displayLabels(input: TaskDispatchDisplayLabelsInput): TaskDispatchDisplayLabels | undefined
}

/** Truthful resolved reference pricing of a model. Explicit free is decided
 *  first: an explicitly free route that publishes no price emits the empty free
 *  marker `{}`, while one that declares a price carries it verbatim like any
 *  priced route. A price-less paid route (reachable only on the explicit-target
 *  path) also emits `{}`. No branch ever synthesizes or zeroes a price. */
function toReferencePricing(model: ModelDefinition): TaskResolvedDispatch['reference_pricing'] {
  const reference = routingReferencePriceOf(model)
  // Paid route with no declared price: no reference exists (explicit-target path).
  if (reference === undefined) return {}
  // Explicitly free is decided before the priced tuple: the bare free marker
  // emits no price, while a free route that declares a list price carries it
  // verbatim through the tuple below.
  if (reference.kind === 'free' && model.pricing === undefined) return {}
  const pricing = model.pricing
  if (pricing === undefined) return {}
  return {
    cached_input_usd_per_million: pricing[0],
    input_usd_per_million: pricing[1],
    output_usd_per_million: pricing[2],
  }
}

function toResolvedDispatch(
  requestedAgentRuntime: string,
  profileId: string,
  plan: { client: string; provider: string; model: string; mode: 'native' | 'gateway'; protocol?: string; reasoningEffort?: TaskResolvedDispatch['reasoningEffort']; fast?: TaskResolvedDispatch['fast']; clientReasoningEffort?: TaskResolvedDispatch['clientReasoningEffort'] },
  model: ModelDefinition,
  speed: SpeedEvidence,
  requirements: TaskDispatchRequirements,
): TaskResolvedDispatch {
  const expectedTps = requirements.expectedTps
  const expectedTpsMet = expectedTps !== undefined && expectedTps > 0 ? speed.tps >= expectedTps : true
  const resolved: TaskResolvedDispatch = {
    requested_agent_runtime: requestedAgentRuntime,
    profile: profileId,
    client: plan.client,
    provider: plan.provider,
    model: plan.model,
    model_id: `${plan.provider}/${model.id}`,
    mode: plan.mode,
    speed: {
      effective_tps: speed.tps,
      source: speed.source,
      sample_count: speed.sampleCount ?? 0,
      expected_tps_met: expectedTpsMet,
      ...(speed.checkedAt === undefined ? {} : { checked_at: speed.checkedAt }),
    },
    intelligence: model.intelligence as string,
    reference_pricing: toReferencePricing(model),
  }
  if (plan.protocol) resolved.protocol = plan.protocol
  if (plan.reasoningEffort !== undefined) resolved.reasoningEffort = plan.reasoningEffort
  if (plan.fast !== undefined) resolved.fast = plan.fast
  if (plan.clientReasoningEffort !== undefined) resolved.clientReasoningEffort = plan.clientReasoningEffort
  return resolved
}

export async function createTaskDispatchResolver(deps: TaskDispatchResolverDeps): Promise<TaskDispatchResolver> {
  const catalog = deps.catalog

  // One consistent snapshot per public resolution. Candidates and their runtime
  // plans are re-enumerated from the live Catalog on every call, so a provider
  // discovery refresh (Devin/OpenCode Zen additions or removals) becomes
  // task-usable without a daemon restart. The runtime plans are compiled through
  // the injected ProviderRuntime, so the active credential/discovery state is
  // consulted before any resolution rather than reading a startup copy. A
  // snapshot is captured once per resolve/eligible/diagnose call and never
  // re-read mid-resolution.
  const currentSnapshot = async (): Promise<{
    candidates: DispatchCandidate[]
    runtimePlans: Readonly<Record<string, DispatchPlan>>
  }> => ({
    // Auto candidates come only from the Catalog's task-capable enumeration. Each
    // candidate's profileId IS its canonical provider/model:client identity; no
    // source preset table, profile registry, or user alias participates here.
    candidates: catalog.enumerateTaskCandidates(),
    // Runtime execution plans are derived for the same canonical targets and
    // carry the exact provider wire/effort binding. They validate that the
    // selected target has a trusted execution plan; internal route labels (e.g.
    // the CodeBuddy iOA remap) are applied by the transport and never exposed
    // through the public identity.
    runtimePlans: await resolveRuntimeTaskPlans(catalog, deps.runtime),
  })

  // Automatic selection uses all candidates; an explicit target narrows it.
  // A historical model spelling in an explicit target is migrated only through
  // a verified unique provider-scoped mapping; the client suffix is preserved
  // exactly, and an unknown or ambiguous model fails closed.
  const selectCandidatePool = (
    input: ResolveTaskDispatchInput,
    candidates: DispatchCandidate[],
  ): DispatchCandidate[] | NoEligiblePlanError => {
    if (!input.target) return candidates
    try {
      const parsed = parseRunSyntax(input.target)
      const provider = catalog.provider(parsed.provider)
      const registeredModel = provider === undefined
        ? undefined
        : resolveHistoricalOfferedModelId(provider, parsed.model)
      if (registeredModel === undefined) {
        return new NoEligiblePlanError(input.taskName, candidates, input.requirements)
      }
      const target = formatRunSyntax({ ...parsed, model: registeredModel })
      return candidates.filter(candidate => candidate.profileId === target)
    } catch {
      return new NoEligiblePlanError(input.taskName, candidates, input.requirements)
    }
  }
  // Canonical identity of a candidate equals its catalog profileId (the public
  // provider/model:client run syntax). Every runtime plan is keyed by the same
  // canonical target, so plan lookups use this identity directly.
  const canonicalTargetOf = (candidate: DispatchCandidate): string => candidate.profileId

  // Diagnostic-only first-real-gate classifier. resolveConstrainedDispatch is
  // the authoritative filter/order; after it rejects a candidate this mirror
  // replays its per-candidate hard gates in the exact same order and reports
  // which real gate eliminated the candidate as one structured closed code plus
  // (for qualitative gates) its exact closed detail. It never admits, rejects,
  // sorts, changes gates, or parses exception text — the code is attached only
  // after the authoritative rejection happened, and only closed static
  // identifiers are ever recorded (never raw exception text).
  const eliminationForCandidate = (
    candidate: DispatchCandidate,
    requirements: TaskDispatchRequirements,
    localSpeed?: readonly LocalSpeedSample[],
  ): TaskResolutionElimination | undefined => {
    const excludedModels = requirements.excludeModelIds ?? []
    const excludedProfiles = requirements.excludeProfileIds ?? []
    const excludedClients = requirements.excludeClientIds ?? []
    const excludedProviders = requirements.excludeProviderIds ?? []
    const excludedForProvider = excludedModelIdsFor(catalog.provider(candidate.provider), excludedModels)
    // First-real-gate order, matching the authoritative pre-poll gate order.
    if (excludedForProvider.has(candidate.model)) {
      return { code: 'no_available_provider', detail: 'model_excluded' }
    }
    if (excludedProfiles.includes(candidate.profileId)) {
      return { code: 'no_available_provider', detail: 'profile_excluded' }
    }
    if (excludedClients.includes(candidate.client)) {
      return { code: 'no_available_provider', detail: 'client_excluded' }
    }
    if (excludedProviders.includes(candidate.provider)) {
      return { code: 'no_available_provider', detail: 'provider_excluded' }
    }
    // Universal application admission: a candidate must be a mainstream
    // registered identity. It applies before every supply gate and has no
    // provider exception, so a non-mainstream or unregistered target can never
    // be admitted through an explicit or automatic route.
    if (!isMainstreamModelId(candidate.model)) {
      return { code: 'no_available_provider' }
    }

    let plan: { client: string; provider: string; model: string; supportsWebSearch?: boolean }
    try {
      plan = catalog.resolveRun(candidate.client, candidate.provider, candidate.model, requirements.expectedReasoningEffort, requirements.fast)
    } catch {
      // Unresolvable plan mirrors the authoritative continue: no truthful path.
      return { code: 'no_available_provider', detail: 'runtime_unresolved' }
    }
    if (requirements.requiresWebSearch === true && plan.supportsWebSearch !== true) {
      return { code: 'no_available_provider', detail: 'web_search_unsupported' }
    }
    const provider = catalog.provider(plan.provider)
    if (!provider) return { code: 'no_available_provider', detail: 'runtime_unresolved' }
    const modelDef = provider.models.find((entry) => entry.id === plan.model)
    if (!modelDef) return { code: 'no_available_provider', detail: 'runtime_unresolved' }
    const referencePrice = routingReferencePriceOf(modelDef)
    // Routing-only reference price for diagnostics, explicit free vs priced: a
    // priced route and an explicitly free route that declares a reference both
    // surface that declared price verbatim, while the bare free marker and a paid
    // route with no declared price surface no numeric price. Free is decided by
    // the kind, never inferred from an absent or zero number.
    let priceUsdPerMillion: number | undefined
    if (referencePrice === undefined) {
      priceUsdPerMillion = undefined
    }
    else if (referencePrice.kind === 'free') {
      priceUsdPerMillion = referencePrice.outputUsdPerMillion
    }
    else {
      priceUsdPerMillion = referencePrice.outputUsdPerMillion
    }
    const atGate = (
      code: TaskResolutionFailureCode,
      detail?: TaskResolutionFailureDetail,
    ): TaskResolutionElimination =>
      detail === undefined ? { code, priceUsdPerMillion } : { code, priceUsdPerMillion, detail }

    // Canonical-alias model exclusion mirrors the same post-resolution gate.
    if (excludedForProvider.has(plan.model)) {
      return atGate('no_available_provider', 'model_excluded')
    }

    // Explicit-free automatic eligibility, mirroring the authoritative
    // dispatcher gate: a statically-declared free offering that is not
    // mainstream or lacks recorded measured speed provenance is not
    // auto-eligible, while a live-confirmed-free offering is admitted from its
    // own free pool. The closed detail set has no free-eligibility member, so no
    // cause is invented here.
    if (!explicitFreeAutoEligibility(provider, modelDef, catalog.confirmedFreeSupply(provider.id, modelDef.id)).eligible) {
      return atGate('no_available_provider')
    }

    if (requirements.inputTokens !== undefined &&
      (!Number.isFinite(modelDef.contextWindow) || requirements.inputTokens + (modelDef.maxOutputTokens ?? 0) > modelDef.contextWindow!)) {
      return atGate('context_window')
    }

    const requiredCapabilities = requirements.requiredCapabilities ?? []
    if (requiredCapabilities.length > 0) {
      const capabilities = modelDef.capabilities ?? []
      const missing = requiredCapabilities.filter((capability) => !capabilities.includes(capability))
      if (missing.length > 0) {
        // Closed input-capability detail; any other missing capability keeps the
        // generic code-only elimination (no invented cause).
        if (missing.includes('image')) {
          return atGate('no_available_provider', 'image_input_unsupported')
        }
        if (missing.includes('text')) {
          return atGate('no_available_provider', 'text_input_unsupported')
        }
        return atGate('no_available_provider')
      }
    }

    if (requirements.intelligenceMin) {
      const intelligence = modelDef.intelligence
      if (intelligence === undefined) return atGate('intelligence_requirement')
      const intelligenceMin = requirements.intelligenceMin
      if (INTELLIGENCE_ORDER[intelligence] < INTELLIGENCE_ORDER[intelligenceMin]) {
        return atGate('intelligence_requirement')
      }
    }

    if (requirements.maxOutputUsdPerMillion !== undefined) {
      // Mirrors the authoritative gate: a paid route with no declared price is
      // ineligible, while an explicitly free route is admitted and, when it also
      // declares a reference price, is capped by it exactly like a priced route.
      if (referencePrice === undefined) return atGate('price_limit')
      if (referencePrice.kind === 'free') {
        if (referencePrice.outputUsdPerMillion !== undefined && referencePrice.outputUsdPerMillion > requirements.maxOutputUsdPerMillion) {
          return atGate('price_limit')
        }
      }
      else if (referencePrice.outputUsdPerMillion > requirements.maxOutputUsdPerMillion) {
        return atGate('price_limit')
      }
    }

    const speed = resolveModelSpeed(provider, modelDef, localSpeed)
    // A candidate with no speed evidence cannot satisfy a minimum TPS: unknown is
    // not zero and is never substituted.
    if (requirements.minimumTps !== undefined && (speed === undefined || speed.tps < requirements.minimumTps)) {
      return atGate('speed_requirement')
    }
    return undefined
  }

  // Reference output price of a rejected candidate, used only so
  // selectTaskResolutionFailure can surface the elimination of the candidate
  // the deterministic router would have ranked first had it passed its gate.
  // Explicit free vs priced, decided by the kind: a priced route and an
  // explicitly free route that declares a reference both compare by that
  // declared price, while the bare free marker and a paid price-less route have
  // none. Free is never inferred from an absent or zero price.
  const referenceOutputPriceOf = (candidate: DispatchCandidate): number | undefined => {
    const provider = catalog.provider(candidate.provider)
    const modelDef = provider?.models.find((entry) => entry.id === candidate.model)
    if (modelDef === undefined) return undefined
    const reference = routingReferencePriceOf(modelDef)
    if (reference === undefined) return undefined
    if (reference.kind === 'free') return reference.outputUsdPerMillion
    return reference.outputUsdPerMillion
  }

  // Single authoritative evaluation. `resolve` selection and the `eligible`
  // projection both run this exact code path (same candidate admission, same
  // `resolveConstrainedDispatch` hard filters, same runtime-plan and evidence
  // fail-closed checks) so eligibility cannot drift from dispatch admission.
  const evaluate = (
    input: ResolveTaskDispatchInput,
    candidatePool: DispatchCandidate[],
    snapshot: { candidates: DispatchCandidate[]; runtimePlans: Readonly<Record<string, DispatchPlan>> },
    // Immutable sample set preloaded by a multi-candidate caller (e.g. eligible)
    // that wants one localSpeed source read shared by every candidate. When
    // absent, each evaluation reads the lazy source once itself.
    localSpeedPreload?: LocalSpeedSample[],
  ): TaskDispatchResolution => {
    const req = input.requirements

    const localSpeed = localSpeedPreload ?? (deps.localSpeed ? deps.localSpeed() : undefined)
    const constrained = resolveConstrainedDispatch(catalog, candidatePool, req, localSpeed)
    if (!constrained.ok) {
      // The authoritative filter rejected the whole pool. Attach one structured
      // closed code: every rejected candidate replays its real first gate and
      // selectTaskResolutionFailure deterministically keeps the elimination of
      // the candidate the router would have ranked first.
      const eliminations: TaskResolutionElimination[] = []
      for (const candidate of candidatePool) {
        const elimination = eliminationForCandidate(candidate, req, localSpeed)
        if (elimination) eliminations.push(elimination)
      }
      const failure = selectTaskResolutionFailure(eliminations)
      return { ok: false, error: new NoEligiblePlanError(input.taskName, snapshot.candidates, req, failure?.code) }
    }

    const selected = constrained.selected

    // Resolve the chosen candidate. `resolveConstrainedDispatch` is the sole
    // filter/order; this lookup only attaches the canonical catalog target that
    // matches the single selected plan (no re-filtering).
    const chosen = candidatePool.find(
      (candidate) =>
        candidate.client === selected.plan.client
        && candidate.provider === selected.plan.provider
        && candidate.model === selected.plan.model,
    )
    const canonicalTarget = chosen ? canonicalTargetOf(chosen) : formatRunSyntax(selected.plan)

    // Require a compiled runtime plan for the selected canonical target. The
    // public snapshot retains canonical identity; Wrenyard consumes the exact
    // target and any upstream alias stays runtime-internal.
    const runtimePlan = snapshot.runtimePlans[canonicalTarget]
    if (!runtimePlan) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, snapshot.candidates, req, 'no_available_provider') }
    }

    // Fail-closed. Constrained tasks always set speed, intelligence, and
    // max-price, so a selected result must carry a finite positive TPS, a
    // declared intelligence tier and a routing reference (a priced route or an
    // explicitly free offering, which may declare a price or carry the free
    // marker). Fabricating any of them is never allowed: the shared helper
    // returns undefined ONLY for a paid route with no declared price, which fails
    // closed here as price_limit. Catalog defaults and provider overrides are
    // TPS-only; checkedAt is required only for local samples.
    const speed = selected.speed
    if (!Number.isFinite(speed.tps) || speed.tps <= 0) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, snapshot.candidates, req, 'speed_requirement') }
    }
    const verifiedSpeed = speed
    const model = selected.model
    const selectedProvider = catalog.provider(selected.plan.provider)
    // Mandatory registry metadata: a model without a declared intelligence tier
    // is not a usable offering. Free supply is orthogonal to identity, so a
    // confirmed-free row is held to the same registry invariant as a paid row;
    // no unknown-tier fallback is substituted here.
    if (!model.intelligence) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, snapshot.candidates, req, 'intelligence_requirement') }
    }
    // Explicit free vs priced, decided by the free marker: an explicitly free
    // route is admitted whether or not it declares a reference price, and a
    // priced route always declares one. Only a paid route with no declared price
    // has no reference and fails closed here; free is never inferred from an
    // absent or zero price.
    const referencePrice = routingReferencePriceOf(model)
    if (referencePrice?.kind !== 'free' && referencePrice?.outputUsdPerMillion === undefined) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, snapshot.candidates, req, 'price_limit') }
    }
    // Conservative re-assertion of the explicit-free automatic-eligibility gate
    // for the selected offering: the authoritative dispatcher already enforces
    // it, and selection must never admit a free route that fails it. The live
    // catalog-level free flag is passed exactly as the dispatcher received it.
    if (selectedProvider
      && !explicitFreeAutoEligibility(selectedProvider, model, catalog.confirmedFreeSupply(selectedProvider.id, model.id)).eligible) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, snapshot.candidates, req, 'no_available_provider') }
    }

    const resolved = toResolvedDispatch(
      input.target ?? '',
      canonicalTarget,
      selected.plan,
      model,
      verifiedSpeed,
      req,
    )
    return { ok: true, exactAgentRuntime: canonicalTarget, resolved }
  }

  return {
    async resolve(input): Promise<TaskDispatchResolution> {
      // One catalog snapshot for this resolution: candidates and their runtime
      // plans are read from the live Catalog, never from a startup copy.
      const snapshot = await currentSnapshot()
      const pool = selectCandidatePool(input, snapshot.candidates)
      if (pool instanceof NoEligiblePlanError) return { ok: false, error: pool }
      return evaluate(input, pool, snapshot)
    },

    async eligible(input): Promise<TaskDispatchEligibleResult> {
      const snapshot = await currentSnapshot()
      const pool = selectCandidatePool(input, snapshot.candidates)
      if (pool instanceof NoEligiblePlanError) return { ok: false, error: pool }

      // Every candidate in the pool is an exact canonical target, so each
      // choice is evaluated through the same evaluate() admission as resolve;
      // only exact (`provider/model:client`) choices are ever returned — never
      // policy aliases.
      //
      // Load the local speed sample set exactly once per public call and reuse
      // that immutable array across every candidate evaluation; otherwise each
      // evaluate() re-reads the lazy source (~one SQL read per candidate).
      const localSpeed = deps.localSpeed ? deps.localSpeed() : undefined
      const choices: TaskDispatchChoice[] = []
      const eliminations: TaskResolutionElimination[] = []
      for (const candidate of pool) {
        const outcome = evaluate(
          { taskName: input.taskName, requirements: input.requirements, target: input.target },
          [candidate],
          snapshot,
          localSpeed,
        )
        if (outcome.ok) {
          choices.push({ ...outcome.resolved, exactAgentRuntime: outcome.exactAgentRuntime })
        } else {
          // The rejected singleton already carries its closed gate code. Keep
          // its reference output price alongside so a no-choice outcome can
          // deterministically surface the most routing-relevant elimination.
          // Excluded/unresolvable candidates (no_available_provider) carry no
          // bounded routing price, mirroring the classifier's own eliminations.
          eliminations.push({
            code: outcome.error.resolutionFailureCode,
            priceUsdPerMillion:
              outcome.error.resolutionFailureCode === 'no_available_provider'
                ? undefined
                : referenceOutputPriceOf(candidate),
          })
        }
      }
      if (choices.length > 0) return { ok: true, choices }

      // No candidate survived the same evaluate() admission resolve() applies.
      // Surface exactly one structured closed code, chosen deterministically
      // across every rejected singleton.
      const failure = selectTaskResolutionFailure(eliminations)
      return {
        ok: false,
        error: new NoEligiblePlanError(input.taskName, pool, input.requirements, failure?.code),
      }
    },

    async diagnose(input: TaskDispatchEligibleInput): Promise<TaskDispatchDiagnosticResult> {
      const snapshot = await currentSnapshot()
      const pool = selectCandidatePool(input, snapshot.candidates)
      if (pool instanceof NoEligiblePlanError) return { ok: false, error: pool }

      // One immutable local speed sample read shared by every candidate's
      // baseline and submitted-gate evaluation, matching `eligible`.
      const localSpeed = deps.localSpeed ? deps.localSpeed() : undefined
      const choices: TaskDispatchDiagnosticChoice[] = []
      for (const candidate of pool) {
        // Baseline availability: no submitted requirements at all, so a
        // candidate that a submitted gate later rejects still surfaces here.
        const baseline = evaluate(
          { taskName: input.taskName, requirements: {}, target: input.target },
          [candidate],
          snapshot,
          localSpeed,
        )
        const admitted = evaluate(
          { taskName: input.taskName, requirements: input.requirements, target: input.target },
          [candidate],
          snapshot,
          localSpeed,
        )
        const rejection = admitted.ok
          ? undefined
          : eliminationForCandidate(candidate, input.requirements, localSpeed)
        choices.push({
          exactAgentRuntime: canonicalTargetOf(candidate),
          available: baseline.ok,
          ...(baseline.ok ? { baseline: baseline.resolved } : {}),
          ...(admitted.ok ? { admitted: admitted.resolved } : {}),
          ...(rejection !== undefined ? { rejectionCode: rejection.code } : {}),
          ...(rejection?.detail !== undefined ? { rejectionDetail: rejection.detail } : {}),
        })
      }
      return { ok: true, choices }
    },

    displayLabels(input: TaskDispatchDisplayLabelsInput): TaskDispatchDisplayLabels | undefined {
      const providerDefinition = catalog.provider(input.provider)
      if (!providerDefinition) return undefined
      const modelDefinition = providerDefinition.models.find((model) => model.id === input.model)
      return {
        provider: input.provider,
        providerDisplayName: providerDefinition.displayName,
        model: input.model,
        modelDisplayName: modelDefinition?.displayName ?? input.model,
      }
    },
  }
}
