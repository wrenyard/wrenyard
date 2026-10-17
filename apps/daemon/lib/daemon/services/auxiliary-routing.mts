import type { GatewayRouteStatus } from '@wrenyard/providers/base';
import { rankAutoRoutingCandidates, type CandidateInput } from '@wrenyard/auto-routing';
import { CONFIRMED_FREE_FLOOR_TPS, INTELLIGENCE_ORDER, resolveModelSpeed, resolveReasoningEffort, routingReferencePriceOf, explicitFreeAutoEligibility, type Catalog, type LocalSpeedSample } from '@wrenyard/providers/catalog';
import { ROLE_REQUIREMENTS, AUXILIARY_TIMEOUT_MS, supportsSession, type AuxiliaryCallRole, type AuxiliaryRoute, type RoleReasoningRequirement } from '@wrenyard/session';
import type { IntelligenceTier } from '@wrenyard/providers/catalog';
import { JsonForemanConfigStore } from '../../config/manager.mts';
import { readGlobalTaskSettings, type TasksConfigSettingsInput, type TaskSettingsLayer } from '../../config/task-settings.mts';
import type { AutoRoutingQuotaSnapshotService } from './auto-routing-snapshot-service.mts';
import type { TaskSettingsRuntimeAvailabilityCallback } from './task-settings-service.mts';
import { deepSeekAutomaticPricingOf, effectiveRoutingCap, toAutomaticCandidateInput, type ModelRoutingEntry } from './model-routing-inputs.mts';

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

export interface AuxiliaryRoutingOptions {
  catalog: Catalog;
  quotaSnapshots: Pick<AutoRoutingQuotaSnapshotService, 'routingSnapshot'>;
  runtimeAvailability: TaskSettingsRuntimeAvailabilityCallback;
  localSpeed?: () => LocalSpeedSample[];
  readSettings: () => TaskSettingsLayer | undefined;
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
  options: AuxiliaryRoutingOptions,
  requirements: RoleReasoningRequirement,
  label: string,
  suggestion: boolean,
) {
  return async (): Promise<AuxiliaryRoute[]> => {
    const bound = await options.quotaSnapshots.routingSnapshot();
    const snapshot = bound.snapshot;
    const nowMs = snapshot.nowMs;
    const localSpeed = options.localSpeed?.();
    const settings = options.readSettings();
    const reasons: Record<string, number> = {};
    const reject = (reason: string): void => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
    // Protocol eligibility is read only from the Gateway model directory, matched
    // per model by its public id / `provider/model`; a provider's own protocol
    // capabilities are never consulted.
    const gatewayByPublicId = new Map<string, GatewaySessionModel>();
    for (const row of await options.gatewayModels()) {
      gatewayByPublicId.set(row.publicId, row);
      gatewayByPublicId.set(`${row.provider}/${row.id}`, row);
    }
    const models = options.catalog.providers().flatMap(provider => provider.models
      .filter(model => !model.taskOnly && (model.supportedClients?.length ?? 0) === 0)
      .flatMap(model => {
        const gateway = gatewayByPublicId.get(`${provider.id}/${model.id}`);
        if (gateway === undefined || !supportsSession(gateway)) {
          reject('no session-supported Gateway protocol'); return [];
        }
        return [{ provider, model }];
      }));
    const entries: { entry: ModelRoutingEntry; levels: typeof requirements.expectedReasoningEffort }[] = [];
    const availability = await Promise.all(models.map(({ provider, model }) => options.runtimeAvailability(
      { provider: provider.id, model: model.id, client: 'gateway', mode: 'gateway' },
      { codeBuddySnapshot: bound.codeBuddySnapshot, nativeProviderReadiness: null },
    )));
    models.forEach(({ provider, model }, index) => {
      // An unhealthy Gateway route is retained rather than discarded: the runner
      // orders eligible candidates by the existing preference and may try the
      // (possibly preferred) half-open route so it can recover. The route is
      // never reported as healthy, and a faulted route is not excluded forever.
      // Its state is surfaced as readable diagnostic/cooldown feedback.
      const routeStatus = options.routeStatus?.(`${provider.id}/${model.id}`);
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
      // Live upstream free evidence attached to this admitted route: the model
      // is free right now from its own pool, independent of the static baseline.
      const confirmedFree = availability[index]?.freeSupply?.confirmedFree === true;
      if (snapshot.hardBlockedProviderIds.includes(provider.id)) return reject('quota blocked');
      if (!requirements.requiredCapabilities.every(capability => model.capabilities?.includes(capability))) return reject('text capability missing');
      // A model with no declared metadata cannot be ranked truthfully. Unknown
      // intelligence, price, speed or an empty effort ladder excludes it here
      // rather than being substituted with a zero, so the existing ranking is
      // kept unchanged for every metadata-complete model.
      // A live-confirmed-free model may declare no intelligence tier: the
      // lowest tier keeps it ranked last by intelligence instead of excluding
      // it from a pool the upstream already confirmed as free. A tier-less
      // paid model still fails closed.
      const effectiveIntelligence = model.intelligence ?? (confirmedFree ? 'low' : undefined);
      if (effectiveIntelligence === undefined) return reject('intelligence unknown');
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
      // A live-confirmed-free model with no speed evidence keeps the free-pool
      // floor so it is ranked last by speed instead of being rejected as unknown.
      const speed = resolveModelSpeed(
        provider,
        model,
        localSpeed,
        new Date(nowMs),
        confirmedFree ? CONFIRMED_FREE_FLOOR_TPS : undefined,
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
    const caps = [settings?.dispatch?.maxOutputUsdPerMillion, settings?.maxAutoOutputUsdPerMillion].filter((cap): cap is number => cap !== undefined);
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
    const ranked = rankAutoRoutingCandidates(inputs, scoreWeights);
    for (const excluded of ranked.excluded) reject(excluded.reason);
    const levelsOf = new Map(entries.map(({ entry, levels }) => [entry.choice.exactAgentRuntime, levels]));
    const speedsOf = new Map(entries.map(({ entry }) => [entry.choice.exactAgentRuntime, entry.choice.speed.effective_tps]));
    const admitted = ranked.ranked.map(candidate => ({ model: candidate.canonicalId, levels: levelsOf.get(candidate.canonicalId)!, speedTps: speedsOf.get(candidate.canonicalId)! }));
    const preferred = requirements.expectedReasoningEffort;
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
export function createAuxiliarySelector(options: AuxiliaryRoutingOptions) {
  return async (role: AuxiliaryCallRole): Promise<AuxiliaryRoute[]> =>
    createSelector(options, ROLE_REQUIREMENTS[role], role, role === 'suggestion')();
}

/**
 * Rank routes against explicit caller-supplied intelligence requirements. The
 * profile is an ordinary text-only role's (the `reply` role) with only
 * `intelligenceMin` / `intelligenceExpected` replaced, so gating, pricing, speed
 * and ranking behave exactly like an auxiliary role selection.
 */
export function createRequirementSelector(options: AuxiliaryRoutingOptions) {
  return async (requirements: AuxiliaryIntelligenceRequirements): Promise<AuxiliaryRoute[]> => {
    const base = ROLE_REQUIREMENTS.reply;
    const profile: RoleReasoningRequirement = {
      ...base,
      intelligenceMin: requirements.intelligenceMin,
      intelligenceExpected: requirements.intelligenceExpected,
      ...(requirements.expectedReasoningEffort === undefined
        ? {}
        : { expectedReasoningEffort: requirements.expectedReasoningEffort }),
    };
    return createSelector(options, profile, `requirements(${requirements.intelligenceMin}/${requirements.intelligenceExpected})`, false)();
  };
}

/** Read only current routing weights/cap; old auxiliary preference files are inert. */
export function readAuxiliaryRoutingSettings(configPath: string): TaskSettingsLayer | undefined {
  const config = new JsonForemanConfigStore().read(configPath);
  return readGlobalTaskSettings(config?.tasks as TasksConfigSettingsInput | undefined);
}
