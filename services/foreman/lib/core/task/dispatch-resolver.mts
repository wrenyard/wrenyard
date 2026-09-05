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

export interface TaskDispatchResolver {
  resolve(input: ResolveTaskDispatchInput): TaskDispatchResolution
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

  return {
    resolve(input): TaskDispatchResolution {
      const req = input.requirements

      // Hard pin: an exact (non-policy) declared runtime narrows the pool to
      // that single profile, which is then validated against every requirement.
      let candidatePool = allCandidates
      if (input.declaredRuntime) {
        try {
          const parsed = parseAgentRuntime(input.declaredRuntime)
          if (!parsed.isPolicy) {
            // An exact (non-policy) declared runtime is a strict single-candidate
            // pin. A policy selector enumerates every builtin runtime-plan
            // candidate and lets the task requirements perform the sole hard
            // filtering and ranking.
            candidatePool = allCandidates.filter((candidate) => candidate.profileId === parsed.configId)
          }
        } catch {
          // An unparseable declared runtime is invalid; fail closed rather than
          // broadening admission to the full candidate pool.
          return { ok: false, error: new NoEligiblePlanError(input.taskName, allCandidates, req) }
        }
      }

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
    },
  }
}
