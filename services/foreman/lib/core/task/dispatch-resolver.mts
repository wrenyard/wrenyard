import type {
  Catalog,
  DispatchCandidate,
  LocalSpeedSample,
  ModelDefinition,
  ModelPricing,
  SpeedEvidence,
  TaskDispatchRequirements,
} from '@wrenyard/catalog'
import { resolveConstrainedDispatch } from '@wrenyard/catalog'
import { resolveBuiltinDispatchPlans, type ProviderRuntime, resolveBuiltinRuntimeDispatchPlans } from '@wrenyard/providers'
import { parseAgentRuntime } from '../agent-runtime.mts'
import type { TaskResolvedDispatch } from '../../task-run-metadata-types.mts'

/**
 * Canonical daemon-side task dispatch resolver.
 *
 * The resolver is a thin adapter over `@wrenyard/catalog`'s
 * `resolveConstrainedDispatch`: it enumerates the trusted exact runtime dispatch
 * plans (builtin catalog + provider runtime), supplies per-profile local
 * `agent_turn_v1` speed evidence through a lazy injected source, and returns
 * exactly one eligible plan with a full, truthful client/provider/model/
 * mode/protocol/speed/intelligence/reference-pricing snapshot. It never probes
 * the network or invokes a model; speed, pricing, and intelligence are read
 * from the catalog and the local samples, and a candidate with missing evidence
 * is failed (NO_ELIGIBLE_PROFILE), never admitted with fabricated values.
 *
 * A task's declared `agentRuntime` is an EXACT PIN: when it parses to a concrete
 * (non-policy) forge profile it narrows the candidate pool to that profile and
 * the single candidate is validated against every hard requirement. A policy
 * runtime (fast/general/ultra) does not pin — it only opens the compatible
 * builtin plan pool. A machine-configured `machinePreference` (soft) is mapped
 * onto `preferredRuntime` and can never relax, skip, or bypass a hard
 * requirement; every candidate (including any the preference would favor) passes
 * the same filters. `resolveConstrainedDispatch` is the sole filter/order; this
 * resolver performs no duplicate filtering of its own.
 */

export class NoEligiblePlanError extends Error {
  readonly code = 'NO_ELIGIBLE_PROFILE' as const
  constructor(
    readonly taskName: string,
    readonly candidates: ReadonlyArray<{ profileId: string; client: string; provider: string; model: string }>,
    readonly requirements: TaskDispatchRequirements,
  ) {
    super(`no eligible dispatch plan for task '${taskName}'`)
    this.name = 'NoEligiblePlanError'
  }
}

/**
 * Explicit-mode failure. Resolving an exact existing runtime is a hard pin:
 * when the requested profile is not parseable/non-policy, does not exist,
 * lacks a compiled runtime plan/credential route, is capability-incompatible,
 * or cannot produce truthful resolved dispatch metadata, the resolution fails
 * with this error and a concrete reason. No other candidate is evaluated and
 * no automatic selection rule can substitute a different profile.
 */
export class ExplicitRuntimeUnavailableError extends Error {
  readonly code = 'EXPLICIT_RUNTIME_UNAVAILABLE' as const
  constructor(
    readonly taskName: string,
    readonly exactAgentRuntime: string,
    readonly reason: string,
  ) {
    super(`explicit runtime '${exactAgentRuntime}' is unavailable for task '${taskName}': ${reason}`)
    this.name = 'ExplicitRuntimeUnavailableError'
  }
}

export interface TaskDispatchResolverDeps {
  catalog: Catalog
  runtime: ProviderRuntime
  /** Lazy source of per-profile trusted local `agent_turn_v1` speed samples. */
  localSpeed?: () => LocalSpeedSample[]
}

export interface ResolveTaskDispatchInput {
  taskName: string
  requirements: TaskDispatchRequirements
  /** Exact declared runtime pin (`'<runtime>/<config-id>'`). Never a preference. */
  declaredRuntime?: string
  /** Soft machine override preference; influences preferredRuntime only. */
  machinePreference?: string
}

export type TaskDispatchResolution =
  | { ok: true; exactAgentRuntime: string; resolved: TaskResolvedDispatch }
  | { ok: false; error: NoEligiblePlanError }

/**
 * Eligible projection input. Mirrors `resolve` minus the soft machine
 * preference: eligibility never depends on an operator preference, only on the
 * task's declared runtime semantics and its hard dispatch requirements.
 */
export interface TaskDispatchEligibleInput {
  taskName: string
  requirements: TaskDispatchRequirements
  /** Exact declared runtime pin or a policy runtime. Never a machine preference. */
  declaredRuntime?: string
}

/**
 * One exact runtime choice: the full resolved-dispatch snapshot (the same
 * client/provider/model/model_id/mode/protocol/speed/intelligence/
 * reference_pricing fields as `resolve`) plus its exact pinned runtime string
 * (`forge/<profile>`). Legacy policy strings (fast/general/ultra) are never
 * returned as choices.
 */
export type TaskDispatchChoice = TaskResolvedDispatch & { exactAgentRuntime: string }

export type TaskDispatchEligibleResult =
  | { ok: true; choices: TaskDispatchChoice[] }
  | { ok: false; error: NoEligiblePlanError }

/**
 * Explicit-resolution input: an EXACT existing configuration pin. Unlike
 * automatic resolution there is no machine preference, no automatic
 * speed/intelligence/reference-price/exclude requirement surface, and no
 * ranking: the caller names the exact profile, and the only further
 * eligibility constraint is the optional required model capabilities.
 */
export interface ResolveExplicitDispatchInput {
  taskName: string
  /** Exact existing configuration pin, e.g. `forge/cb-dsf`. Never a policy alias. */
  exactRuntime: string
  /** Sole eligibility constraint beyond intrinsic availability. */
  requiredCapabilities?: TaskDispatchRequirements['requiredCapabilities']
}

export type TaskDispatchExplicitResolution =
  | { ok: true; exactAgentRuntime: string; resolved: TaskResolvedDispatch }
  | { ok: false; error: ExplicitRuntimeUnavailableError }

/** Input for the synchronous `listExactRuntimes` enumeration. */
export interface TaskDispatchExactRuntimeListInput {
  taskName: string
  requiredCapabilities?: TaskDispatchRequirements['requiredCapabilities']
}

/**
 * One exact existing configuration with truthful explicit-mode availability.
 * Policy aliases are never listed and evidence is never fabricated: `resolved`
 * is present exactly when the profile can serve the task, otherwise
 * `unavailableReason` states the concrete cause.
 */
export interface TaskDispatchExactRuntimeListItem {
  exactAgentRuntime: string
  available: boolean
  /** Full truthful resolved-dispatch snapshot when available. */
  resolved?: TaskResolvedDispatch
  /** Concrete reason when unavailable; absent when available. */
  unavailableReason?: string
}

/** Synchronous enumeration result; always `ok: true`. */
export type TaskDispatchExactRuntimeListResult = { ok: true; items: TaskDispatchExactRuntimeListItem[] }

export interface TaskDispatchResolver {
  resolve(input: ResolveTaskDispatchInput): TaskDispatchResolution
  /**
   * Enumerates every exact runtime choice currently satisfying the same
   * declared-runtime semantics and hard requirements as `resolve`. An exact
   * declared runtime exposes at most the pinned candidate when eligible; a
   * policy runtime evaluates every exact candidate. Eligibility is never
   * relaxed against resolve admission.
   */
  eligible(input: TaskDispatchEligibleInput): TaskDispatchEligibleResult

  /**
   * Resolves one EXACT existing configuration, bypassing every automatic
   * selection constraint (expected/minimum speed, intelligence range,
   * reference-price ceiling, automatic exclusion lists, preferredRuntime,
   * machine preference, and ranking) and applying only intrinsic availability
   * plus optional required capabilities. Failure is terminal: an unavailable,
   * unknown, policy, capability-incompatible, or non-truthful profile returns
   * `ExplicitRuntimeUnavailableError` and never falls back to another
   * candidate.
   */
  resolveExplicit(input: ResolveExplicitDispatchInput): TaskDispatchExplicitResolution
  /**
   * Enumerates every existing exact profile (`forge/<profile>`) with its
   * explicit-mode availability, attaching resolved metadata only when it can be
   * produced truthfully. Synchronous and side-effect free: no inference and no
   * network.
   */
  listExactRuntimes(input: TaskDispatchExactRuntimeListInput): TaskDispatchExactRuntimeListResult
}

function toReferencePricing(pricing: ModelPricing): TaskResolvedDispatch['reference_pricing'] {
  const reference: TaskResolvedDispatch['reference_pricing'] = {
    input_usd_per_million: pricing.inputUsdPerMillion,
    output_usd_per_million: pricing.outputUsdPerMillion,
    source: pricing.source,
    checked_at: pricing.checkedAt,
  }
  if (pricing.cachedInputUsdPerMillion !== undefined) {
    reference.cached_input_usd_per_million = pricing.cachedInputUsdPerMillion
  }
  return reference
}

function toResolvedDispatch(
  requestedAgentRuntime: string,
  profileId: string,
  plan: { client: string; provider: string; model: string; mode: 'native' | 'gateway'; protocol?: string },
  model: ModelDefinition,
  speed: SpeedEvidence & { checkedAt: string },
  pricing: ModelPricing,
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
      checked_at: speed.checkedAt,
      expected_tps_met: expectedTpsMet,
    },
    intelligence: model.intelligence as string,
    reference_pricing: toReferencePricing(pricing),
  }
  if (plan.protocol) resolved.protocol = plan.protocol
  return resolved
}

export async function createTaskDispatchResolver(deps: TaskDispatchResolverDeps): Promise<TaskDispatchResolver> {
  const catalog = deps.catalog

  // Logical Catalog candidates: canonical model ids drive eligibility, constraint
  // filtering, and profile identity. An upstream runtime alias must never make a
  // canonical Catalog profile ineligible.
  const catalogPlans = resolveBuiltinDispatchPlans(catalog)
  const allCandidates: DispatchCandidate[] = Object.entries(catalogPlans).map(([profileId, plan]) => ({
    profileId,
    client: plan.client,
    provider: plan.provider,
    model: plan.model,
  }))

  // Runtime execution plans (which may contain private upstream aliases) are
  // compiled up front. They validate that the selected profile has a trusted
  // execution plan, but those internal route labels are never exposed through
  // the public resolved-dispatch identity.
  const runtimePlans = await resolveBuiltinRuntimeDispatchPlans(catalog, deps.runtime)

  // Shared pool selection: an exact (non-policy) declared runtime is a strict
  // single-candidate pin; a policy selector (fast/general/ultra) or an absent
  // declared runtime opens the full builtin candidate pool and lets the task
  // requirements perform the sole hard filtering and ranking. An unparseable
  // declared runtime fails closed rather than broadening admission.
  const selectCandidatePool = (
    input: ResolveTaskDispatchInput,
  ): DispatchCandidate[] | NoEligiblePlanError => {
    if (!input.declaredRuntime) return allCandidates
    try {
      const parsed = parseAgentRuntime(input.declaredRuntime)
      if (parsed.isPolicy) return allCandidates
      return allCandidates.filter((candidate) => candidate.profileId === parsed.configId)
    } catch {
      return new NoEligiblePlanError(input.taskName, allCandidates, input.requirements)
    }
  }

  // Single authoritative evaluation. `resolve` selection and the `eligible`
  // projection both run this exact code path (same candidate admission, same
  // `resolveConstrainedDispatch` hard filters, same runtime-plan and evidence
  // fail-closed checks) so eligibility cannot drift from dispatch admission.
  const evaluate = (
    input: ResolveTaskDispatchInput,
    candidatePool: DispatchCandidate[],
  ): TaskDispatchResolution => {
    const req = input.requirements

    // Soft machine preference: mapped onto preferredRuntime only — never a bypass.
    const effectiveReq: TaskDispatchRequirements = { ...req }
    if (input.machinePreference) {
      const preferred = allCandidates.find((candidate) => `forge/${candidate.profileId}` === input.machinePreference)
      if (preferred) {
        effectiveReq.preferredRuntime = {
          client: preferred.client,
          provider: preferred.provider,
          model: preferred.model,
        }
      }
    }

    const localSpeed = deps.localSpeed ? deps.localSpeed() : undefined
    const constrained = resolveConstrainedDispatch(catalog, candidatePool, effectiveReq, localSpeed)
    if (!constrained.ok) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, allCandidates, req) }
    }

    const selected = constrained.selected

    // Resolve the bare profile id. `resolveConstrainedDispatch` is the sole
    // filter/order; this lookup only attaches the catalog profile id that
    // matches the single selected plan (no re-filtering).
    const chosen = candidatePool.find(
      (candidate) =>
        candidate.client === selected.plan.client
        && candidate.provider === selected.plan.provider
        && candidate.model === selected.plan.model,
    )
    const profileId = chosen?.profileId
      ?? input.declaredRuntime?.split('/')[1]
      ?? selected.plan.provider

    // Require a compiled runtime plan for the selected profile. Catalog
    // selection and the public snapshot retain canonical logical identity;
    // Forge consumes the exact profile and keeps any upstream alias internal.
    const runtimePlan = runtimePlans[profileId]
    if (!runtimePlan) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, allCandidates, req) }
    }

    // Fail-closed. Constrained tasks always set speed, intelligence, and
    // max-price, so a selected result must carry real evidence for each.
    // Fabricating any of these is never allowed.
    const speed = selected.speed
    if (!speed.checkedAt) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, allCandidates, req) }
    }
    const verifiedSpeed = { ...speed, checkedAt: speed.checkedAt }
    const model = selected.model
    if (!model.intelligence) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, allCandidates, req) }
    }
    const pricing = model.pricing
    if (
      !pricing
      || pricing.inputUsdPerMillion === undefined
      || pricing.outputUsdPerMillion === undefined
      || !pricing.checkedAt
    ) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, allCandidates, req) }
    }

    const resolved = toResolvedDispatch(
      input.declaredRuntime ?? '',
      profileId,
      selected.plan,
      model,
      verifiedSpeed,
      pricing,
      req,
    )
    return { ok: true, exactAgentRuntime: `forge/${profileId}`, resolved }
  }

  // Explicit (existing exact configuration) resolution is a separate, narrower
  // admission path from automatic `resolve`/`eligible`. The exact profile is
  // validated only for intrinsic availability (it exists, has a compiled
  // runtime plan/credential route, and can yield truthful resolved dispatch
  // metadata) plus the caller's required capabilities. None of the automatic
  // selection machinery runs here: no expected/minimum speed, no intelligence
  // range, no reference-price ceiling, no exclusion lists, no preferredRuntime,
  // no machine preference, and no ranking. A failure is terminal — the explicit
  // error is returned and no other candidate is ever evaluated as a fallback.
  const evaluateExplicitProfile = (
    taskName: string,
    exactAgentRuntime: string,
    profileId: string,
    requiredCapabilities?: TaskDispatchRequirements['requiredCapabilities'],
  ): TaskDispatchExplicitResolution => {
    const catalogPlan = catalogPlans[profileId]
    if (!catalogPlan) {
      return {
        ok: false,
        error: new ExplicitRuntimeUnavailableError(
          taskName,
          exactAgentRuntime,
          `no catalog profile '${profileId}'`,
        ),
      }
    }
    const runtimePlan = runtimePlans[profileId]
    if (!runtimePlan) {
      return {
        ok: false,
        error: new ExplicitRuntimeUnavailableError(
          taskName,
          exactAgentRuntime,
          `profile '${profileId}' has no compiled runtime plan or credential route`,
        ),
      }
    }

    const probe = (requirements: TaskDispatchRequirements): TaskDispatchResolution => evaluate(
      { taskName, requirements, declaredRuntime: exactAgentRuntime },
      [
        {
          profileId,
          client: catalogPlan.client,
          provider: catalogPlan.provider,
          model: catalogPlan.model,
        },
      ],
    )

    // Availability-only probe. The pool is exactly this candidate and the
    // requirements carry no automatic constraint, so admission here means the
    // profile can produce a truthful resolved snapshot — never a fabricated one.
    const availability = probe({})
    if (!availability.ok) {
      return {
        ok: false,
        error: new ExplicitRuntimeUnavailableError(
          taskName,
          exactAgentRuntime,
          `profile '${profileId}' cannot produce truthful resolved dispatch metadata (speed/intelligence/reference-pricing evidence)`,
        ),
      }
    }

    if (!requiredCapabilities || requiredCapabilities.length === 0) return availability

    // Capability compatibility is the only remaining eligibility constraint.
    const capable = probe({ requiredCapabilities })
    if (!capable.ok) {
      return {
        ok: false,
        error: new ExplicitRuntimeUnavailableError(
          taskName,
          exactAgentRuntime,
          `profile '${profileId}' is incompatible with required capabilities: ${requiredCapabilities.join(', ')}`,
        ),
      }
    }
    return capable
  }

  return {
    resolve(input): TaskDispatchResolution {
      const pool = selectCandidatePool(input)
      if (pool instanceof NoEligiblePlanError) return { ok: false, error: pool }
      return evaluate(input, pool)
    },

    eligible(input): TaskDispatchEligibleResult {
      const pool = selectCandidatePool(input)
      if (pool instanceof NoEligiblePlanError) return { ok: false, error: pool }

      // An exact declared pin narrowed the pool to a single candidate, so at
      // most one choice is produced. A policy declaration evaluates every exact
      // candidate through the same evaluate() admission as resolve; only exact
      // (`forge/<profile>`) pins are ever returned — never policy aliases.
      const choices: TaskDispatchChoice[] = []
      for (const candidate of pool) {
        const outcome = evaluate(
          { taskName: input.taskName, requirements: input.requirements, declaredRuntime: input.declaredRuntime },
          [candidate],
        )
        if (outcome.ok) {
          choices.push({ ...outcome.resolved, exactAgentRuntime: outcome.exactAgentRuntime })
        }
      }
      return { ok: true, choices }
    },

    resolveExplicit(input: ResolveExplicitDispatchInput): TaskDispatchExplicitResolution {
      const { taskName, exactRuntime, requiredCapabilities } = input
      const unavailable = (reason: string): TaskDispatchExplicitResolution => ({
        ok: false,
        error: new ExplicitRuntimeUnavailableError(taskName, exactRuntime, reason),
      })

      // Require a parseable non-policy `forge/<profile>` exact runtime. Anything
      // else is a concrete failure, not an implicit request for another profile.
      if (!/^forge\/[^/]+$/u.test(exactRuntime)) {
        return unavailable(`'${exactRuntime}' is not a parseable non-policy forge/<profile> exact runtime`)
      }
      let parsed: ReturnType<typeof parseAgentRuntime>
      try {
        parsed = parseAgentRuntime(exactRuntime)
      } catch {
        return unavailable(`'${exactRuntime}' does not parse as an agent runtime`)
      }
      if (parsed.isPolicy) {
        return unavailable(`policy alias '${exactRuntime}' is not an exact configuration; resolveExplicit requires forge/<profile>`)
      }
      return evaluateExplicitProfile(taskName, exactRuntime, parsed.configId, requiredCapabilities)
    },

    listExactRuntimes(input: TaskDispatchExactRuntimeListInput): TaskDispatchExactRuntimeListResult {
      const items: TaskDispatchExactRuntimeListItem[] = []
      for (const profileId of Object.keys(catalogPlans)) {
        const exactAgentRuntime = `forge/${profileId}`
        const outcome = evaluateExplicitProfile(input.taskName, exactAgentRuntime, profileId, input.requiredCapabilities)
        if (outcome.ok) {
          items.push({ exactAgentRuntime, available: true, resolved: outcome.resolved })
        } else {
          items.push({ exactAgentRuntime, available: false, unavailableReason: outcome.error.reason })
        }
      }
      return { ok: true, items }
    },
  }
}
