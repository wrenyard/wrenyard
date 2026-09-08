import type {
  Catalog,
  DispatchCandidate,
  LocalSpeedSample,
  ModelDefinition,
  ModelPricing,
  SpeedEvidence,
  TaskDispatchRequirements,
} from '@wrenyard/catalog'
import { formatRunSyntax, parseRunSyntax, resolveConstrainedDispatch } from '@wrenyard/catalog'
import { resolveRuntimeTaskPlans, type ProviderRuntime } from '@wrenyard/providers'
import { parseAgentRuntime } from '../agent-runtime.mts'
import type { TaskResolvedDispatch } from '../../task-run-metadata-types.mts'

/**
 * Canonical daemon-side task dispatch resolver.
 *
 * The resolver is a thin adapter over `@wrenyard/catalog`: it derives the
 * trusted dispatch plans and resolves the runtime task plans through the
 * catalog/provider runtime, supplies per-candidate local `agent_turn_v1` speed
 * evidence through a lazy injected source, and returns exactly one eligible
 * plan with a full, truthful canonical provider/model:client snapshot. It never
 * probes the network or invokes a model; speed, pricing, and intelligence are
 * read from the catalog and the local samples, and a candidate with missing
 * evidence is failed (NO_ELIGIBLE_PROFILE), never admitted with fabricated
 * values.
 *
 * Every runtime identity is a canonical dynamic target
 * (`<provider>/<model>:<client>`) resolved once through the Catalog. Automatic
 * selection is driven solely by `catalog.enumerateTaskCandidates` and the
 * resolved runtime task plans: an absent declaredRuntime or a legacy policy
 * string (fast/general/ultra) opens the full task-capable candidate pool and a
 * non-policy legacy `forge/<profile>` declaration no longer maps to any source
 * preset and fails closed. A machine/global `machinePreference` and a
 * `requirements.preferredRuntime` are ignored by automatic selection: a
 * concrete runtime/alias choice exists only in explicit mode. Every candidate
 * passes the same hard gates, then `resolveConstrainedDispatch` collapses
 * provider/model clients (native > grok > claude/others) and ranks the models.
 * `resolveConstrainedDispatch` is the sole filter/order; this
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
 * Explicit-mode failure. Resolving an exact canonical dynamic target is a hard
 * pin: when the requested target is not parseable run syntax, does not resolve
 * through the Catalog, is not in the task-capable candidate/runtime plan set,
 * is capability-incompatible, or cannot produce truthful resolved dispatch
 * metadata, the resolution fails with this error and a concrete reason. No
 * other candidate is evaluated and no automatic selection rule can substitute
 * a different target.
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
  /** Lazy source of per-candidate trusted local `agent_turn_v1` speed samples. */
  localSpeed?: () => LocalSpeedSample[]
}

export interface ResolveTaskDispatchInput {
  taskName: string
  requirements: TaskDispatchRequirements
  /** Exact declared runtime classification (`'forge/fast'`) or absent for auto. */
  declaredRuntime?: string
  /** Machine/global override preference, retained for interface compatibility.
   *  Ignored for automatic selection; a concrete runtime/alias choice exists
   *  only through resolveExplicit. */
  machinePreference?: string
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
  /** Exact declared runtime classification or a policy runtime. Never a machine preference. */
  declaredRuntime?: string
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
 * Explicit-resolution input: an EXACT canonical dynamic target pin. Unlike
 * automatic resolution there is no machine preference, no automatic
 * speed/intelligence/reference-price/exclude requirement surface, and no
 * ranking: the caller names the exact target, and the only further eligibility
 * constraint is the optional required model capabilities.
 */
export interface ResolveExplicitDispatchInput {
  taskName: string
  /** Exact canonical dynamic target, e.g. `codebuddy/deepseek-v4-flash:cb`.
   *  Never a policy alias. */
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
 * One exact canonical dynamic target with truthful explicit-mode availability.
 * Policy aliases are never listed and evidence is never fabricated: `resolved`
 * is present exactly when the target can serve the task, otherwise
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
   * declared-runtime semantics and hard requirements as `resolve`. A policy
   * or absent declared runtime evaluates every exact canonical candidate.
   * Eligibility is never relaxed against resolve admission.
   */
  eligible(input: TaskDispatchEligibleInput): TaskDispatchEligibleResult

  /**
   * Resolves one EXACT canonical dynamic target, bypassing every automatic
   * selection constraint (expected/minimum speed, intelligence range,
   * reference-price ceiling, automatic exclusion lists, preferredRuntime,
   * machine preference, and ranking) and applying only intrinsic availability
   * plus optional required capabilities. Failure is terminal: an unavailable,
   * unknown, non-task-capable, policy, capability-incompatible, or non-truthful
   * target returns `ExplicitRuntimeUnavailableError` and never falls back to
   * another candidate.
   */
  resolveExplicit(input: ResolveExplicitDispatchInput): TaskDispatchExplicitResolution
  /**
   * Enumerates every existing canonical dynamic target with its explicit-mode
   * availability, attaching resolved metadata only when it can be produced
   * truthfully. Synchronous and side-effect free: no inference and no network.
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

  // Auto candidates come only from the Catalog's task-capable enumeration. Each
  // candidate's profileId IS its canonical provider/model:client identity; no
  // source preset table, profile registry, or user alias participates here.
  const allCandidates: DispatchCandidate[] = catalog.enumerateTaskCandidates()

  // Runtime execution plans are compiled up front and keyed by the same
  // canonical targets. They validate that the selected target has a trusted
  // execution plan, but internal route labels (e.g. the CodeBuddy iOA remap)
  // are runtime-owned and never exposed through the public identity.
  const runtimePlans = await resolveRuntimeTaskPlans(catalog, deps.runtime)

  // Legacy policy detection (fast/general/ultra) remains a temporary auto
  // classification only. A policy selector or an absent declared runtime opens
  // the full canonical candidate pool and lets the task requirements perform
  // the sole hard filtering and ranking. Any other declared runtime — including
  // a legacy non-policy forge/<profile>, which no longer maps to a source
  // preset — fails closed rather than broadening admission.
  const isPolicyClassification = (raw: string): boolean => {
    try {
      return parseAgentRuntime(raw).isPolicy
    } catch {
      return false
    }
  }

  const selectCandidatePool = (
    input: ResolveTaskDispatchInput,
  ): DispatchCandidate[] | NoEligiblePlanError => {
    if (!input.declaredRuntime) return allCandidates
    if (!isPolicyClassification(input.declaredRuntime)) {
      return new NoEligiblePlanError(input.taskName, allCandidates, input.requirements)
    }
    return allCandidates
  }

  // Canonical identity of a candidate equals its catalog profileId (the public
  // provider/model:client run syntax). Every runtime plan is keyed by the same
  // canonical target, so plan lookups use this identity directly.
  const canonicalTargetOf = (candidate: DispatchCandidate): string => candidate.profileId

  // Single authoritative evaluation. `resolve` selection and the `eligible`
  // projection both run this exact code path (same candidate admission, same
  // `resolveConstrainedDispatch` hard filters, same runtime-plan and evidence
  // fail-closed checks) so eligibility cannot drift from dispatch admission.
  const evaluate = (
    input: ResolveTaskDispatchInput,
    candidatePool: DispatchCandidate[],
  ): TaskDispatchResolution => {
    const req = input.requirements

    // machinePreference and requirements.preferredRuntime are ignored for
    // automatic selection: a machine/global concrete runtime is never parsed
    // into a preferred candidate. resolveConstrainedDispatch applies every hard
    // gate, collapses provider/model clients (native > grok > claude/others),
    // then ranks models by expected-speed group and reference output price. A
    // concrete runtime/alias choice exists only in explicit mode.
    const localSpeed = deps.localSpeed ? deps.localSpeed() : undefined
    const constrained = resolveConstrainedDispatch(catalog, candidatePool, req, localSpeed)
    if (!constrained.ok) {
      return { ok: false, error: new NoEligiblePlanError(input.taskName, allCandidates, req) }
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
    // public snapshot retains canonical identity; Forge consumes the exact
    // target and any upstream alias stays runtime-internal.
    const runtimePlan = runtimePlans[canonicalTarget]
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
      canonicalTarget,
      selected.plan,
      model,
      verifiedSpeed,
      pricing,
      req,
    )
    return { ok: true, exactAgentRuntime: canonicalTarget, resolved }
  }

  // Explicit (exact canonical dynamic target) resolution is a separate,
  // narrower admission path from automatic `resolve`/`eligible`. The target is
  // validated only for intrinsic availability (it resolves through the
  // Catalog, exists as a task-capable canonical candidate with a compiled
  // runtime plan/credential route, and can yield truthful resolved dispatch
  // metadata) plus the caller's required capabilities. None of the automatic
  // selection machinery runs here: no expected/minimum speed, no intelligence
  // range, no reference-price ceiling, no exclusion lists, no preferredRuntime,
  // no machine preference, and no ranking. A failure is terminal — the explicit
  // error is returned and no other candidate is ever evaluated as a fallback.
  const evaluateExplicitTarget = (
    taskName: string,
    exactAgentRuntime: string,
    candidate: DispatchCandidate,
    requiredCapabilities?: TaskDispatchRequirements['requiredCapabilities'],
  ): TaskDispatchExplicitResolution => {
    const canonicalTarget = canonicalTargetOf(candidate)
    if (canonicalTarget !== exactAgentRuntime) {
      return {
        ok: false,
        error: new ExplicitRuntimeUnavailableError(
          taskName,
          exactAgentRuntime,
          `canonical target identity is '${canonicalTarget}', not '${exactAgentRuntime}'`,
        ),
      }
    }
    const runtimePlan = runtimePlans[canonicalTarget]
    if (!runtimePlan) {
      return {
        ok: false,
        error: new ExplicitRuntimeUnavailableError(
          taskName,
          exactAgentRuntime,
          `target '${canonicalTarget}' has no compiled runtime plan or credential route`,
        ),
      }
    }

    const probe = (requirements: TaskDispatchRequirements): TaskDispatchResolution => evaluate(
      { taskName, requirements, declaredRuntime: exactAgentRuntime },
      [candidate],
    )

    // Availability-only probe. The pool is exactly this candidate and the
    // requirements carry no automatic constraint, so admission here means the
    // target can produce a truthful resolved snapshot — never a fabricated one.
    const availability = probe({})
    if (!availability.ok) {
      return {
        ok: false,
        error: new ExplicitRuntimeUnavailableError(
          taskName,
          exactAgentRuntime,
          `target '${canonicalTarget}' cannot produce truthful resolved dispatch metadata (speed/intelligence/reference-pricing evidence)`,
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
          `target '${canonicalTarget}' is incompatible with required capabilities: ${requiredCapabilities.join(', ')}`,
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

      // Every candidate in the pool is an exact canonical target, so each
      // choice is evaluated through the same evaluate() admission as resolve;
      // only exact (`provider/model:client`) choices are ever returned — never
      // policy aliases.
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

      // Require a parseable canonical dynamic target. Anything else is a
      // concrete failure, not an implicit request for another target.
      let parsed: ReturnType<typeof parseRunSyntax>
      try {
        parsed = parseRunSyntax(exactRuntime)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return unavailable(`'${exactRuntime}' is not a parseable canonical dynamic target (${message})`)
      }

      // Resolve through the Catalog (canonicalizing model aliases) and require
      // the exact canonical target to exist in the task-capable candidate set.
      let resolvedPlan: { client: string; provider: string; model: string }
      try {
        resolvedPlan = catalog.resolveRun(parsed.client, parsed.provider, parsed.model)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return unavailable(`cannot resolve '${exactRuntime}' through the Catalog: ${message}`)
      }
      const canonicalTarget = formatRunSyntax(resolvedPlan)
      const candidate = allCandidates.find(
        (entry) => entry.client === resolvedPlan.client
          && entry.provider === resolvedPlan.provider
          && entry.model === resolvedPlan.model,
      )
      if (!candidate) {
        return unavailable(`canonical target '${canonicalTarget}' is not a task-capable candidate or runtime plan`)
      }
      return evaluateExplicitTarget(taskName, canonicalTarget, candidate, requiredCapabilities)
    },

    listExactRuntimes(input: TaskDispatchExactRuntimeListInput): TaskDispatchExactRuntimeListResult {
      const items: TaskDispatchExactRuntimeListItem[] = []
      for (const candidate of allCandidates) {
        const exactAgentRuntime = canonicalTargetOf(candidate)
        const outcome = evaluateExplicitTarget(input.taskName, exactAgentRuntime, candidate, input.requiredCapabilities)
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
