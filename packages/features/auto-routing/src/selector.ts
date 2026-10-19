/**
 * The single automatic-routing selector API. Every input (catalog, quota/pace
 * snapshot, runtime availability, local speed, route status and the settings
 * layer) is injected through one port, so the package never reads IO itself.
 */
import type { GatewayRouteStatus } from '@wrenyard/providers/base';
import { INTELLIGENCE_ORDER, resolveModelSpeed, resolveReasoningEffort, routingReferencePriceOf, explicitFreeAutoEligibility, type Catalog, type LocalSpeedSample } from '@wrenyard/providers/catalog';
import type { IntelligenceTier } from '@wrenyard/providers/catalog';
import { isMainstreamModelId, type ReasoningEffort } from '@wrenyard/models';
import type { CandidateInput, RequiredQuotaConstraint } from './types.ts';
import { AutoRouter, isAbundantSupply } from './auto-router.ts';
import {
  AUXILIARY_TIMEOUT_MS,
  BOT_REQUIREMENT,
  ROLE_REQUIREMENTS,
  supportsSession,
  type AuxiliaryCallRole,
  type RoleReasoningRequirement,
} from './requirements.ts';
import { deepSeekAutomaticPricingOf, effectiveRoutingCap, toAutomaticCandidateInput, type ModelRoutingEntry } from './selector-inputs.ts';
import { excludedModelIdsFor } from './exclusions.ts';

/** Gateway route status extended with the circuit phase auxiliary ordering reads. */
export type GatewayRouteStatusWithPhase = GatewayRouteStatus & {
  phase?: 'closed' | 'open' | 'half_open';
  faultKind?: string;
  nextProbeAt?: string;
};

/** The Gateway model fields auxiliary selection needs: identity and per-model protocols. */
export interface GatewaySessionModel {
  publicId: string;
  provider: string;
  id: string;
  protocols: readonly string[];
}

/** One selected route: a Gateway public model id and the reasoning effort to use. */
export interface SelectorRoute {
  model: string;
  reasoningEffort: ReasoningEffort;
}

/**
 * Minimal structural view of the settings layer the selector reads: the
 * per-dispatch output-price cap, the global model and provider exclusions and
 * the routing score weights. The daemon's concrete task-settings layer
 * satisfies it structurally.
 */
export interface SelectorSettingsLayer {
  dispatch?: {
    maxOutputUsdPerMillion?: number;
    /** Bare model ids or unified `provider/model` ids no automatic route may use. */
    excludeModelIds?: readonly string[];
    excludeProviderIds?: readonly string[];
  };
  /** Routing score weights keyed for config, mapped to scorer P/S/Q/I. */
  routingWeights?: { price: number; speed: number; quota: number; intelligence: number };
}

/** One binding entry in a snapshot with its frozen required quota constraints. */
export interface AutoRoutingQuotaSnapshotEntry {
  readonly providerId: string;
  readonly modelId: string;
  /** Every jointly required normalized pool id for this binding. */
  readonly quotaPoolIds: readonly string[];
  readonly requiredQuota: readonly RequiredQuotaConstraint[];
}

/**
 * Immutable automatic-routing quota snapshot.
 *
 * - `nowMs`: when this snapshot was taken.
 * - `validUntilMs`: the earliest direct freshness boundary (60s from each raw
 *   fetched_at) capped at now + 60s (or by the CodeBuddy reset for a retained
 *   hard block), or the short validity of an unknown snapshot. After this time
 *   a caller must obtain a new snapshot.
 * - `hardBlockedProviderIds`: monotonic privacy-safe observed CodeBuddy
 *   exhaustion blocks only.
 */
export interface AutoRoutingQuotaSnapshot {
  readonly snapshotId: string;
  readonly nowMs: number;
  readonly validUntilMs: number;
  readonly entries: readonly AutoRoutingQuotaSnapshotEntry[];
  readonly hardBlockedProviderIds: readonly string[];
}

/**
 * Request-bound routing bundle. The snapshot is serialization-safe; the
 * optional provider-specific active view stays opaque (`unknown`) so the
 * routing package never depends on a concrete provider type.
 */
export interface AutoRoutingBoundQuotaSnapshot {
  readonly snapshot: AutoRoutingQuotaSnapshot;
  readonly codeBuddySnapshot: unknown;
}

/** The result of one non-billable runtime availability probe. */
export interface RuntimeAvailabilityResult {
  providerCredential: 'available' | 'missing' | 'unknown';
  available: boolean;
  /** Privacy-safe confirmed-free routing supply fact for this route. */
  freeSupply?: { confirmedFree: true; source: string; ruleId: string };
}

/** Request-bound context handed to one availability probe. */
export interface SelectorRuntimeAvailabilityContext {
  readonly codeBuddySnapshot: unknown;
  readonly nativeProviderReadiness: unknown;
}

/** Non-billable live provider credential/route availability probe. */
export type SelectorRuntimeAvailability = (
  runtime: { provider: string; model: string; client: string; mode: 'native' | 'gateway' },
  context?: SelectorRuntimeAvailabilityContext,
) => Promise<RuntimeAvailabilityResult> | RuntimeAvailabilityResult;

/** Every input the selector needs, supplied by the caller. */
export interface SelectorInputPort {
  catalog: Catalog;
  quotaSnapshots: { routingSnapshot: () => Promise<AutoRoutingBoundQuotaSnapshot> };
  runtimeAvailability(
    runtime: { provider: string; model: string; client: string; mode: 'native' | 'gateway' },
    context?: SelectorRuntimeAvailabilityContext,
  ): Promise<RuntimeAvailabilityResult> | RuntimeAvailabilityResult;
  localSpeed?: () => LocalSpeedSample[];
  readSettings: () => SelectorSettingsLayer | undefined;
  /**
   * In-memory Gateway route state. An unhealthy route is retained in the pool
   * (ordered by the existing preference) rather than discarded, so the runner
   * may try a half-open preferred route and let it recover.
   */
  routeStatus?: (model: string) => GatewayRouteStatusWithPhase | undefined;
  /**
   * The Gateway model directory: each model's own supported protocols, never
   * the provider's blanket capabilities. Authenticated per invocation so a
   * newly available provider is admitted without a daemon restart.
   */
  gatewayModels: () => Promise<readonly GatewaySessionModel[]>;
}

/** Caller-supplied intelligence requirements for the requirement selector. */
export interface AuxiliaryIntelligenceRequirements {
  intelligenceMin: IntelligenceTier;
  intelligenceExpected: IntelligenceTier;
  /** Ordered reasoning-level preference; when absent the base role's preference applies. */
  expectedReasoningEffort?: RoleReasoningRequirement['expectedReasoningEffort'];
}

function createSelector(
  port: SelectorInputPort,
  requirements: RoleReasoningRequirement,
  label: string,
  suggestion: boolean,
) {
  return async (): Promise<SelectorRoute[]> => {
    const bound = await port.quotaSnapshots.routingSnapshot();
    const snapshot = bound.snapshot;
    const nowMs = snapshot.nowMs;
    const localSpeed = port.localSpeed?.();
    const settings = port.readSettings();
    const reasons: Record<string, number> = {};
    const reject = (reason: string): void => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
    // Protocol eligibility is read only from the Gateway model directory, matched
    // per model by its public id / `provider/model`; a provider's own protocol
    // capabilities are never consulted.
    const gatewayByPublicId = new Map<string, GatewaySessionModel>();
    for (const row of await port.gatewayModels()) {
      gatewayByPublicId.set(row.publicId, row);
      gatewayByPublicId.set(`${row.provider}/${row.id}`, row);
    }
    // The global exclusions govern every automatic choice, the same lists task
    // dispatch honors; an explicit user choice never reaches this selector.
    const excludedProviders = new Set(settings?.dispatch?.excludeProviderIds ?? []);
    const excludedModels = settings?.dispatch?.excludeModelIds ?? [];
    const models = port.catalog.providers().flatMap(provider => {
      if (excludedProviders.has(provider.id)) { reject('provider excluded'); return []; }
      const excluded = excludedModelIdsFor(provider, excludedModels);
      return provider.models
        .filter(model => !model.taskOnly && (model.supportedClients?.length ?? 0) === 0)
        .flatMap(model => {
          if (excluded.has(model.id)) { reject('model excluded'); return []; }
          const gateway = gatewayByPublicId.get(`${provider.id}/${model.id}`);
          if (gateway === undefined || !supportsSession(gateway)) {
            reject('no session-supported Gateway protocol'); return [];
          }
          return [{ provider, model }];
        });
    });
    const entries: { entry: ModelRoutingEntry; levels: typeof requirements.expectedReasoningEffort }[] = [];
    const availability = await Promise.all(models.map(({ provider, model }) => port.runtimeAvailability(
      { provider: provider.id, model: model.id, client: 'gateway', mode: 'gateway' },
      { codeBuddySnapshot: bound.codeBuddySnapshot, nativeProviderReadiness: null },
    )));
    models.forEach(({ provider, model }, index) => {
      // An unhealthy Gateway route is retained rather than discarded: the runner
      // orders eligible candidates by the existing preference and may try the
      // (possibly preferred) half-open route so it can recover. The route is
      // never reported as healthy, and a faulted route is not excluded forever.
      // Its state is surfaced as readable diagnostic/cooldown feedback.
      const routeStatus = port.routeStatus?.(`${provider.id}/${model.id}`);
      if (routeStatus) reject(`route ${routeStatus.phase === 'half_open' ? 'half_open (probe eligible)' : routeStatus.faultKind ?? routeStatus.state}`);
      // An explicitly free offering is excluded while the shared Gateway circuit
      // blocks its route: an open route cannot serve, and a half-open route is
      // excluded until its probe is actually due. A due half-open route stays
      // admitted so the Gateway's own bounded probe lease can recover it. Paid
      // routes keep their existing retain-for-recovery behavior.
      if (model.free === true && routeStatus !== undefined) {
        if (routeStatus.phase === 'open') return reject('free route open');
        if (routeStatus.phase === 'half_open'
          && routeStatus.nextProbeAt !== undefined
          && new Date(routeStatus.nextProbeAt).getTime() > nowMs) {
          return reject('free route half-open until next probe');
        }
      }
      if (!availability[index]!.available || availability[index]!.providerCredential !== 'available') return reject('provider not configured/available');
      // Universal application admission: auxiliary selection is an application
      // surface, so every candidate must be a mainstream registered identity.
      // The gate is independent of free supply and has no provider exception.
      if (!isMainstreamModelId(model.id)) return reject('not a mainstream registered model');
      // Live upstream free evidence attached to this admitted route: the model
      // is free right now from its own pool, independent of the static baseline.
      const confirmedFree = availability[index]?.freeSupply?.confirmedFree === true;
      if (snapshot.hardBlockedProviderIds.includes(provider.id)) return reject('quota blocked');
      if (!requirements.requiredCapabilities.every(capability => model.capabilities?.includes(capability))) return reject('text capability missing');
      // A model with no declared metadata cannot be ranked truthfully. Unknown
      // intelligence, price, speed or an empty effort ladder excludes it here
      // rather than being substituted with a zero, so the existing ranking is
      // kept unchanged for every metadata-complete model.
      const effectiveIntelligence = model.intelligence;
      if (effectiveIntelligence === undefined
        || !Number.isFinite(INTELLIGENCE_ORDER[effectiveIntelligence])) return reject('intelligence unknown');
      if (INTELLIGENCE_ORDER[effectiveIntelligence] < INTELLIGENCE_ORDER[requirements.intelligenceMin]) return reject('intelligence below minimum');
      if (model.reasoningEfforts.length === 0) return reject('no reasoning-effort ladder');
      // Explicit-free automatic eligibility, decided by the shared helper before
      // ranking: a statically-declared free offering is admitted only with a
      // mainstream canonical identity plus code-recorded measured speed
      // provenance; a live-confirmed-free offering is admitted from its own free
      // pool. Every other free offering stays chat-picker-only. Non-free routes
      // pass unchanged.
      const freeEligibility = explicitFreeAutoEligibility(provider, model, confirmedFree);
      if (!freeEligibility.eligible) return reject(`free route not auto-eligible (${freeEligibility.reason})`);
      // Routing-only reference price, explicit free vs priced: an explicitly
      // free route (kind 'free') is admitted whether or not it declares a price,
      // and a priced route keeps its declared price. Only a paid route with no
      // declared price stays ineligible, so unknown paid pricing is never treated
      // as free or as zero. Free is decided by the kind, never by a number.
      const referencePrice = routingReferencePriceOf(model);
      if (referencePrice?.kind !== 'free' && referencePrice?.outputUsdPerMillion === undefined)
        return reject('pricing unknown');
      if ((model.contextWindow ?? 0) < requirements.minimumContextWindow) return reject('context below minimum');
      // Speed evidence follows the shared precedence: pair-specific local
      // sample, then provider override, then the registered catalog default.
      // A live-confirmed-free model without its own evidence uses that same
      // registry default, never a fabricated floor.
      const speed = resolveModelSpeed(
        provider,
        model,
        localSpeed,
        new Date(nowMs),
      );
      if (speed === undefined) return reject('speed unknown');
      entries.push({
        levels: model.reasoningEfforts,
        entry: {
          choice: { provider: provider.id, model: model.id, client: 'gateway', exactAgentRuntime: `${provider.id}/${model.id}`, intelligence: effectiveIntelligence,
            reference_pricing: referencePrice.kind === 'priced'
              // A priced route carries its declared reference price verbatim.
              ? { output_usd_per_million: referencePrice.outputUsdPerMillion }
              // An explicitly free route preserves a declared list price when it
              // has one, otherwise it carries the explicit free marker `{}`.
              : referencePrice.outputUsdPerMillion === undefined
                ? {}
                : { output_usd_per_million: referencePrice.outputUsdPerMillion },
            speed: { effective_tps: speed.tps } },
          availability: availability[index],
        },
      });
    });
    const pricings = entries.map(({ entry }) => deepSeekAutomaticPricingOf(entry.choice, nowMs, AUXILIARY_TIMEOUT_MS));
    const caps = [settings?.dispatch?.maxOutputUsdPerMillion].filter((cap): cap is number => cap !== undefined);
    const capUsdPerM = effectiveRoutingCap(entries.map(({ entry }, index) => pricings[index]?.safetyOutputUsdPerM ?? entry.choice.reference_pricing.output_usd_per_million), caps);
    const inputs: CandidateInput[] = [];
    entries.forEach(({ entry }, index) => {
      const candidate = toAutomaticCandidateInput(entry, {
        snapshotId: snapshot.snapshotId, nowMs, timeoutMs: AUXILIARY_TIMEOUT_MS, snapshot, capUsdPerM,
        minimumTps: 0, expectedTps: requirements.expectedTps,
        intelligenceMinRank: INTELLIGENCE_ORDER[requirements.intelligenceMin],
        intelligenceExpectedRank: INTELLIGENCE_ORDER[requirements.intelligenceExpected],
      }, pricings[index]);
      if (candidate) inputs.push(candidate); else reject('invalid model evidence');
    });
    const weights = settings?.routingWeights;
    const scoreWeights = weights ? { P: weights.price, S: weights.speed, Q: weights.quota, I: weights.intelligence } : undefined;
    // Scores are per candidate, so filtering the ranked list keeps the ranking of any layer.
    const ranked = new AutoRouter().rank(inputs, scoreWeights);
    for (const excluded of ranked.excluded) reject(excluded.reason);
    const levelsOf = new Map(entries.map(({ entry, levels }) => [entry.choice.exactAgentRuntime, levels]));
    const speedsOf = new Map(entries.map(({ entry }) => [entry.choice.exactAgentRuntime, entry.choice.speed.effective_tps]));
    const tiersOf = new Map(entries.map(({ entry }) => [entry.choice.exactAgentRuntime, entry.choice.intelligence]));
    const admitted = ranked.ranked.map(candidate => ({
      model: candidate.canonicalId,
      levels: levelsOf.get(candidate.canonicalId)!,
      speedTps: speedsOf.get(candidate.canonicalId)!,
      tier: tiersOf.get(candidate.canonicalId)!,
      quota: candidate.quota,
      abundant: isAbundantSupply(candidate),
    }));
    const preferred = requirements.expectedReasoningEffort;
    const ladder = requirements.ladder;
    if (ladder !== undefined) {
      // Ladder mode pools the admitted candidates by tier in ladder order,
      // preserving the AutoRouter ranking inside each pool. A candidate can
      // match several steps (for example a premium model with sufficient
      // quota), so each route is emitted at most once, at its first matching
      // step, keeping the pools disjoint. The global effort layer below is
      // intentionally skipped: it could drop every mid model that lacks the
      // preferred effort. Candidates matching no step are dropped defensively.
      const emitted = new Set<string>();
      const ladderPool = ladder.flatMap(step => admitted.filter(({ model, tier, quota, abundant }) => {
        if (tier !== step.intelligence) return false;
        if (step.requireQuotaSufficient && !(abundant || quota.aheadOfPace !== true)) return false;
        if (emitted.has(model)) return false;
        emitted.add(model);
        return true;
      }));
      if (!ladderPool.length) throw new Error(`Auxiliary role ${label}: no candidate qualified (${Object.entries(reasons).map(([reason, count]) => `${reason}: ${count}`).join('; ') || 'no Gateway-available normal models'})`);
      return ladderPool.map(({ model, levels }) => ({
        model,
        // Each route carries its own effort: the expected level when the
        // candidate supports it, otherwise its first declared level.
        reasoningEffort: preferred.find(effort => levels.includes(effort)) ?? levels[0]!,
      }));
    }
    const selected = preferred.map(effort => admitted.filter(({ levels }) => levels.includes(effort))).find(layer => layer.length > 0) ?? admitted;
    // The suggestion role wants a hint back quickly, so when the selected pool
    // admits routes that can actually disable reasoning it favors those, ordered
    // by the candidate's own effective TPS. Other roles, and the case where no
    // explicit-`none` route is admitted, keep the existing ranked order.
    const explicitNone = suggestion ? selected.filter(({ levels }) => levels.includes('none')) : [];
    const pool = explicitNone.length > 0
      ? explicitNone
          .map((candidate, index) => ({ candidate, index }))
          .sort((a, b) => b.candidate.speedTps - a.candidate.speedTps || a.index - b.index)
          .map(({ candidate }) => candidate)
      : selected;
    if (!pool.length) throw new Error(`Auxiliary role ${label}: no candidate qualified (${Object.entries(reasons).map(([reason, count]) => `${reason}: ${count}`).join('; ') || 'no Gateway-available normal models'})`);
    return pool.map(({ model, levels }) => ({
      model,
      reasoningEffort: preferred.find(effort => levels.includes(effort)) ?? resolveReasoningEffort(preferred[0]!, levels),
    }));
  };
}

/** Fresh ranked routes on each invocation; no session state or result cache. */
export function createAuxiliarySelector(port: SelectorInputPort) {
  return async (role: AuxiliaryCallRole): Promise<SelectorRoute[]> =>
    createSelector(port, ROLE_REQUIREMENTS[role], role, role === 'suggestion')();
}

/**
 * Rank routes against explicit caller-supplied intelligence requirements. The
 * profile is an ordinary text-only role's (the `reply` role) with only
 * `intelligenceMin` / `intelligenceExpected` replaced, so gating, pricing, speed
 * and ranking behave exactly like an auxiliary role selection.
 */
export function createRequirementSelector(port: SelectorInputPort) {
  return async (requirements: AuxiliaryIntelligenceRequirements): Promise<SelectorRoute[]> => {
    const base = ROLE_REQUIREMENTS.reply;
    const profile: RoleReasoningRequirement = {
      ...base,
      intelligenceMin: requirements.intelligenceMin,
      intelligenceExpected: requirements.intelligenceExpected,
      ...(requirements.expectedReasoningEffort === undefined
        ? {}
        : { expectedReasoningEffort: requirements.expectedReasoningEffort }),
    };
    return createSelector(port, profile, `requirements(${requirements.intelligenceMin}/${requirements.intelligenceExpected})`, false)();
  };
}

/**
 * Rank routes from one requirement key: `bot` uses the bot requirement and
 * `auxiliary:<role>` an auxiliary role's requirement. An unknown key is a
 * caller bug and throws naming the key.
 */
export async function selectRoutesByRequirementKey(
  port: SelectorInputPort,
  key: string,
): Promise<SelectorRoute[]> {
  if (key === 'bot') {
    return createSelector(
      port,
      BOT_REQUIREMENT,
      `requirements(${BOT_REQUIREMENT.intelligenceMin}/${BOT_REQUIREMENT.intelligenceExpected})`,
      false,
    )();
  }
  const prefix = 'auxiliary:';
  if (key.startsWith(prefix)) {
    const role = key.slice(prefix.length) as AuxiliaryCallRole;
    const requirements = ROLE_REQUIREMENTS[role];
    if (requirements === undefined) throw new Error(`Unknown auxiliary role in routing requirement key: ${key}`);
    return createSelector(port, requirements, role, role === 'suggestion')();
  }
  throw new Error(`Unknown routing requirement key: ${key}`);
}
