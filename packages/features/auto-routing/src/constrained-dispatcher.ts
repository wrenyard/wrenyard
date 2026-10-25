import { type Catalog, type ModelDefinition, explicitFreeAutoEligibility, resolveModelSpeed, routingReferencePriceOf } from '@wrenyard/providers/catalog';
import { mcpTransportsForClient } from '@wrenyard/providers';
import type { DispatchCandidate, LocalSpeedSample, DispatchPlan } from '@wrenyard/providers/base';
import type { TaskDispatchRequirements, ConstrainedDispatch, DispatchResolution } from './types.ts';
import { excludedModelIdsFor } from './exclusions.ts';
import { INTELLIGENCE_TIERS, isMainstreamModelId, type IntelligenceTier } from '@wrenyard/models';
const INTELLIGENCE_ORDER = Object.fromEntries(INTELLIGENCE_TIERS.map((tier, rank) => [tier, rank])) as Record<IntelligenceTier, number>;
export function isDynamicFast(tps: number): boolean {
  return tps > 80;
}
/** Comparable reference output price used only to ORDER routed candidates.
 *  Explicit free vs priced, decided by the kind: a priced route and an
 *  explicitly free route that declares a reference price both compare by that
 *  declared price, while the bare free marker and a paid route with no declared
 *  price have no comparable price. Free status is decided by the kind and is
 *  never inferred from a zero price. */
function comparableReferencePrice(model: ModelDefinition): number | undefined {
  const reference = routingReferencePriceOf(model);
  if (reference === undefined)
    return undefined;
  if (reference.kind === 'free')
    return reference.outputUsdPerMillion;
  return reference.outputUsdPerMillion;
}
/** Resolves provider catalog candidates against task constraints before dispatch. */
export class ConstrainedDispatcher {
  constructor(private readonly catalog: Catalog) { }
  resolve(candidates: readonly DispatchCandidate[], requirements: TaskDispatchRequirements, localSpeed?: readonly LocalSpeedSample[]): ConstrainedDispatch {
    const excludedModels = requirements.excludeModelIds ?? [];
    const excludedProfiles = new Set(requirements.excludeProfileIds ?? []);
    const excludedClients = new Set(requirements.excludeClientIds ?? []);
    const excludedProviders = new Set(requirements.excludeProviderIds ?? []);
    const requiredCaps = requirements.requiredCapabilities ?? [];
    const requiredMcpTransports = requirements.requiredMcpTransports ?? [];
    const eligible: DispatchResolution[] = [];
    let considered = 0;
    for (const candidate of candidates) {
      considered++;
      const excludedForProvider = excludedModelIdsFor(this.catalog.provider(candidate.provider), excludedModels);
      if (excludedForProvider.has(candidate.model))
        continue;
      if (excludedProfiles.has(candidate.profileId))
        continue;
      if (excludedClients.has(candidate.client))
        continue;
      if (excludedProviders.has(candidate.provider))
        continue;
      let plan: DispatchPlan;
      try {
        // Eligibility/scoring resolve the candidate WITHOUT the expected
        // reasoning effort: reasoning effort is a selected runtime parameter
        // that adapts through the Catalog, so it must never change which
        // candidates are eligible or how they rank. The expected level is
        // applied only to the chosen resolution below. Fast is different: the
        // candidate's real transport must materialize it, so the requested
        // state is resolved here and disqualifies routes that cannot inject it
        // before ranking.
        plan = this.catalog.resolveRun(candidate.client, candidate.provider, candidate.model, undefined, requirements.fast);
      }
      catch {
        continue;
      }
      const provider = this.catalog.provider(plan.provider);
      if (!provider)
        continue;
      const modelDef = provider.models.find((entry) => entry.id === plan.model);
      if (!modelDef)
        continue;
      // Live catalog-level free evidence for this exact route: the provider
      // republishes `free` from its own upstream catalog, so this follows the
      // live promotion rather than a static list.
      const liveConfirmedFree = this.catalog.confirmedFreeSupply(provider.id, modelDef.id);
      if (requirements.fast === true && modelDef.supportsFast !== true)
        continue;
      // Hard constraint: native web search requirement, enforced before any
      // capability/intelligence/price scoring. Admitted only when the resolved
      // plan explicitly supports native web search; gateway and unknown
      // combinations fail closed.
      if (requirements.requiresWebSearch && plan.supportsWebSearch !== true)
        continue;
      // Canonical-alias exclusion: a candidate supplied via an alias must not
      // bypass exclusion of its resolved canonical model (e.g. legacy-glm ->
      // glm-5.3). GLM-5.3-Flash remains a distinct id and is excluded only by
      // its own id, never by a glm-5.3 exclusion.
      if (excludedForProvider.has(plan.model))
        continue;
      // Universal application admission, independent of free supply: an
      // automatic candidate must be a mainstream registered identity. There is
      // no provider-specific exception and no unregistered or alias identity.
      if (!isMainstreamModelId(modelDef.id))
        continue;
      // Explicit-free automatic eligibility, decided by the shared helper and
      // applied in addition to every gate below: a statically-declared free
      // offering is admitted only with a mainstream canonical identity plus
      // code-recorded measured speed provenance; a live-confirmed-free offering
      // is admitted from its own free pool. Every other free offering stays
      // chat-picker-only. Non-free routes pass unchanged.
      if (!explicitFreeAutoEligibility(provider, modelDef, liveConfirmedFree).eligible)
        continue;
      if (requirements.inputTokens !== undefined &&
        (!Number.isFinite(modelDef.contextWindow) || requirements.inputTokens + (modelDef.maxOutputTokens ?? 0) > modelDef.contextWindow!))
        continue;
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
        if (!capOk)
          continue;
      }
      // Hard constraint: required MCP server transports. The candidate's client
      // must host every required transport; a client declaring no transports
      // (or an unknown client) satisfies only an empty requirement.
      if (requiredMcpTransports.length > 0) {
        const supported = mcpTransportsForClient(candidate.client);
        let transportsOk = true;
        for (const transport of requiredMcpTransports) {
          if (!supported.includes(transport)) {
            transportsOk = false;
            break;
          }
        }
        if (!transportsOk)
          continue;
      }
      // Hard constraint: intelligence minimum. The configured intelligence tier
      // is the sole admission fact; a model declaring no tier cannot satisfy a
      // minimum, so unknown is ineligible rather than treated as zero.
      if (requirements.intelligenceMin) {
        const intel = modelDef.intelligence;
        if (intel === undefined || INTELLIGENCE_ORDER[intel] < INTELLIGENCE_ORDER[requirements.intelligenceMin])
          continue;
      }
      // List-price constraint; account-specific free routing is evaluated by the routing policy.
      if (requirements.maxOutputUsdPerMillion !== undefined) {
        // Explicit free vs priced. A paid route with no declared price cannot be
        // checked and is ineligible, never admitted as if priced at zero. An
        // explicitly free route (kind 'free') is admitted; when it also declares a
        // reference price that price is capped exactly like a priced route. Free
        // status comes only from the explicit kind, never from a zero price.
        const reference = routingReferencePriceOf(modelDef);
        if (reference === undefined)
          continue;
        if (reference.kind === 'free') {
          if (reference.outputUsdPerMillion !== undefined && reference.outputUsdPerMillion > requirements.maxOutputUsdPerMillion)
            continue;
        }
        else if (reference.outputUsdPerMillion > requirements.maxOutputUsdPerMillion) {
          continue;
        }
      }
      // Speed evidence tiers in exact precedence order via the shared resolver:
      // the first usable exact-provider/model local 31-day TPS sample,
      // then the canonical provider modelSpeedOverride, then the registered
      // catalog default. Matching is by exact provider.id/modelDef.id — no alias
      // or client remap. A live-confirmed-free model without its own evidence
      // falls back to that same registry default, never to a fabricated floor.
      const speed = resolveModelSpeed(
        provider,
        modelDef,
        localSpeed,
        undefined,
      );
      // A candidate with NO speed evidence cannot be ranked or dispatched: a
      // genuinely unknown speed is excluded rather than substituted with a zero.
      if (speed === undefined)
        continue;
      // Hard constraint: minimum TPS against the resolved evidence tier.
      if (requirements.minimumTps !== undefined && speed.tps < requirements.minimumTps)
        continue;
      // expectedTps satisfaction semantics: explicit ratio, clamped to 1.
      const expected = requirements.expectedTps;
      const satisfaction = expected !== undefined && expected > 0 ? Math.min(1, speed.tps / expected) : 1;
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
      if (group)
        group.push(entry);
      else
        byProviderModel.set(key, [entry]);
    }
    const collapsed: DispatchResolution[] = [];
    for (const group of byProviderModel.values()) {
      const native = group.filter((entry) => entry.plan.mode === 'native');
      const usable = native.length > 0 ? native : group;
      usable.sort((a, b) => {
        if (native.length === 0) {
          const aGrok = a.plan.client === 'grok' ? 0 : 1;
          const bGrok = b.plan.client === 'grok' ? 0 : 1;
          if (aGrok !== bGrok)
            return aGrok - bGrok;
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
      // concrete runtime selection and no reasoning-effort level is consulted in
      // automatic mode.
      const aMeets = expected !== undefined && expected > 0 && a.speed.tps >= expected;
      const bMeets = expected !== undefined && expected > 0 && b.speed.tps >= expected;
      if (aMeets !== bMeets)
        return aMeets ? -1 : 1;
      // Lower reference output price first. Explicit free vs priced: a priced
      // route and an explicitly free route that declares a reference price both
      // order by that declared reference price. A price-less paid route and an
      // explicitly free route with no declared reference have no comparable
      // price, so both order after every comparably priced route instead of being
      // treated as the cheapest (zero). Free status is never inferred from a zero
      // price.
      const pa = comparableReferencePrice(a.model);
      const pb = comparableReferencePrice(b.model);
      if (pa !== pb) {
        if (pa === undefined)
          return 1;
        if (pb === undefined)
          return -1;
        return pa - pb;
      }
      const idA = `${a.plan.provider}/${a.plan.model}`;
      const idB = `${b.plan.provider}/${b.plan.model}`;
      return idA.localeCompare(idB);
    });
    collapsed.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    // Reasoning effort is applied ONLY to the chosen resolution, after
    // eligibility and ranking are already fixed: it adapts the selected target's
    // runtime parameters and can never change which candidate wins.
    const winner = collapsed[0];
    if (requirements.expectedReasoningEffort !== undefined || requirements.fast !== undefined) {
      winner.plan = this.catalog.resolveRun(winner.plan.client, winner.plan.provider, winner.plan.model, requirements.expectedReasoningEffort, requirements.fast);
    }
    return { ok: true, selected: winner, considered };
  }
}
