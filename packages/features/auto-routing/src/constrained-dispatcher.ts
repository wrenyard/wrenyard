import { type Catalog, resolveModelSpeed } from '@wrenyard/catalog';
import type { DispatchCandidate, LocalSpeedSample, DispatchPlan } from '@wrenyard/catalog';
import type { TaskDispatchRequirements, ConstrainedDispatch, DispatchResolution } from './types.ts';
import { INTELLIGENCE_TIERS, type IntelligenceTier } from '@wrenyard/models';
const INTELLIGENCE_ORDER = Object.fromEntries(INTELLIGENCE_TIERS.map((tier, rank) => [tier, rank])) as Record<IntelligenceTier, number>;
export function isDynamicFast(tps: number): boolean {
  return tps > 80;
}
/** Resolves provider catalog candidates against task constraints before dispatch. */
export class ConstrainedDispatcher {
  constructor(private readonly catalog: Catalog) { }
  resolve(candidates: readonly DispatchCandidate[], requirements: TaskDispatchRequirements, localSpeed?: readonly LocalSpeedSample[]): ConstrainedDispatch {
    const excludedModels = new Set(requirements.excludeModelIds ?? []);
    const excludedProfiles = new Set(requirements.excludeProfileIds ?? []);
    const excludedClients = new Set(requirements.excludeClientIds ?? []);
    const excludedProviders = new Set(requirements.excludeProviderIds ?? []);
    const requiredCaps = requirements.requiredCapabilities ?? [];
    const eligible: DispatchResolution[] = [];
    let considered = 0;
    for (const candidate of candidates) {
      considered++;
      if (excludedModels.has(candidate.model))
        continue;
      if (excludedProfiles.has(candidate.profileId))
        continue;
      if (excludedClients.has(candidate.client))
        continue;
      if (excludedProviders.has(candidate.provider))
        continue;
      let plan: DispatchPlan;
      try {
        // Eligibility/scoring resolve the candidate WITHOUT the requested thinking
        // level: thinking is a selected runtime parameter that adapts through the
        // Catalog, so it must never change which candidates are eligible or how
        // they rank. The requested level is applied only to the chosen resolution
        // below.
        plan = this.catalog.resolveRun(candidate.client, candidate.provider, candidate.model);
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
      if (excludedModels.has(plan.model))
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
      // Hard constraint: intelligence minimum. The configured intelligence tier
      // is the sole admission fact.
      if (requirements.intelligenceMin) {
        const intel = modelDef.intelligence;
        if (INTELLIGENCE_ORDER[intel] < INTELLIGENCE_ORDER[requirements.intelligenceMin])
          continue;
      }
      // List-price constraint; account-specific free routing is evaluated by the routing policy.
      if (requirements.maxOutputUsdPerMillion !== undefined) {
        if (modelDef.pricing[2] > requirements.maxOutputUsdPerMillion)
          continue;
      }
      // Speed evidence tiers in exact precedence order via the shared resolver:
      // the first usable exact-provider/model local 31-day TPS sample,
      // then the canonical provider modelSpeedOverride, then the model default
      // speed. Matching is by exact provider.id/modelDef.id — no alias or client remap.
      const speed = resolveModelSpeed(provider, modelDef, localSpeed);
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
      // concrete runtime selection and no thinking level is consulted in
      // automatic mode.
      const aMeets = expected !== undefined && expected > 0 && a.speed.tps >= expected;
      const bMeets = expected !== undefined && expected > 0 && b.speed.tps >= expected;
      if (aMeets !== bMeets)
        return aMeets ? -1 : 1;
      const pa = a.model.pricing[2];
      const pb = b.model.pricing[2];
      if (pa !== pb)
        return pa - pb;
      const idA = `${a.plan.provider}/${a.plan.model}`;
      const idB = `${b.plan.provider}/${b.plan.model}`;
      return idA.localeCompare(idB);
    });
    collapsed.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    // Thinking is applied ONLY to the chosen resolution, after eligibility and
    // ranking are already fixed: it adapts the selected target's runtime
    // parameters and can never change which candidate wins.
    const winner = collapsed[0];
    if (requirements.thinking !== undefined) {
      winner.plan = this.catalog.resolveRun(winner.plan.client, winner.plan.provider, winner.plan.model, requirements.thinking);
    }
    return { ok: true, selected: winner, considered };
  }
}
