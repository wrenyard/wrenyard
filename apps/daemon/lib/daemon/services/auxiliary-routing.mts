import { rankAutoRoutingCandidates, type CandidateInput } from '@wrenyard/auto-routing';
import { INTELLIGENCE_ORDER, resolveModelSpeed, resolveReasoningEffort, type Catalog, type LocalSpeedSample } from '@wrenyard/providers/catalog';
import { ROLE_REQUIREMENTS, CHEAP_TIMEOUT_MS, selectInferenceMode, type AuxiliaryCallRole, type AuxiliaryRoute } from '@wrenyard/session';
import { JsonForemanConfigStore } from '../../config/manager.mts';
import { readGlobalTaskSettings, type TasksConfigSettingsInput, type TaskSettingsLayer } from '../../config/task-settings.mts';
import type { AutoRoutingQuotaSnapshotService } from './auto-routing-snapshot-service.mts';
import type { TaskSettingsRuntimeAvailabilityCallback } from './task-settings-service.mts';
import { deepSeekAutomaticPricingOf, effectiveRoutingCap, toAutomaticCandidateInput, type ModelRoutingEntry } from './model-routing-inputs.mts';

export interface AuxiliaryRoutingOptions {
  catalog: Catalog;
  quotaSnapshots: Pick<AutoRoutingQuotaSnapshotService, 'routingSnapshot'>;
  runtimeAvailability: TaskSettingsRuntimeAvailabilityCallback;
  localSpeed?: () => LocalSpeedSample[];
  readSettings: () => TaskSettingsLayer | undefined;
}

/** Fresh ranked routes on each invocation; no session state or result cache. */
export function createAuxiliarySelector(options: AuxiliaryRoutingOptions) {
  return async (role: AuxiliaryCallRole): Promise<AuxiliaryRoute[]> => {
    const requirements = ROLE_REQUIREMENTS[role];
    const bound = await options.quotaSnapshots.routingSnapshot();
    const snapshot = bound.snapshot;
    const nowMs = snapshot.nowMs;
    const localSpeed = options.localSpeed?.();
    const settings = options.readSettings();
    const reasons: Record<string, number> = {};
    const reject = (reason: string): void => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
    const models = options.catalog.providers().flatMap(provider => {
      if (!selectInferenceMode((provider.protocols ?? []).map(capability => capability.protocol))) {
        reject('no session-supported Gateway protocol'); return [];
      }
      return provider.models.filter(model => !model.taskOnly && model.supportedClients === undefined)
        .map(model => ({ provider, model }));
    });
    const entries: { entry: ModelRoutingEntry; levels: typeof requirements.expectedReasoningEffort }[] = [];
    const availability = await Promise.all(models.map(({ provider, model }) => options.runtimeAvailability(
      { provider: provider.id, model: model.id, client: 'gateway', mode: 'gateway' },
      { codeBuddySnapshot: bound.codeBuddySnapshot, nativeProviderReadiness: null },
    )));
    models.forEach(({ provider, model }, index) => {
      if (!availability[index]!.available || availability[index]!.providerCredential !== 'available') return reject('provider not configured/available');
      if (snapshot.hardBlockedProviderIds.includes(provider.id)) return reject('quota blocked');
      if (!requirements.requiredCapabilities.every(capability => model.capabilities?.includes(capability))) return reject('text capability missing');
      if (INTELLIGENCE_ORDER[model.intelligence] < INTELLIGENCE_ORDER[requirements.intelligenceMin]) return reject('intelligence below minimum');
      if ((model.contextWindow ?? 0) < requirements.minimumContextWindow) return reject('context below minimum');
      const speed = resolveModelSpeed(provider, model, localSpeed, new Date(nowMs));
      entries.push({
        levels: model.reasoningEfforts,
        entry: {
          choice: { provider: provider.id, model: model.id, client: 'gateway', exactAgentRuntime: `${provider.id}/${model.id}`, intelligence: model.intelligence,
            reference_pricing: { output_usd_per_million: model.pricing[2] }, speed: { effective_tps: speed.tps } },
          availability: availability[index],
        },
      });
    });
    const pricings = entries.map(({ entry }) => deepSeekAutomaticPricingOf(entry.choice, nowMs, CHEAP_TIMEOUT_MS));
    const caps = [settings?.dispatch?.maxOutputUsdPerMillion, settings?.maxAutoOutputUsdPerMillion].filter((cap): cap is number => cap !== undefined);
    const capUsdPerM = effectiveRoutingCap(entries.map(({ entry }, index) => pricings[index]?.safetyOutputUsdPerM ?? entry.choice.reference_pricing.output_usd_per_million!), caps);
    const inputs: CandidateInput[] = [];
    entries.forEach(({ entry }, index) => {
      const candidate = toAutomaticCandidateInput(entry, {
        snapshotId: snapshot.snapshotId, nowMs, timeoutMs: CHEAP_TIMEOUT_MS, snapshot, capUsdPerM,
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
    const admitted = ranked.ranked.map(candidate => ({ model: candidate.canonicalId, levels: levelsOf.get(candidate.canonicalId)! }));
    const preferred = requirements.expectedReasoningEffort;
    const pool = preferred.map(effort => admitted.filter(({ levels }) => levels.includes(effort))).find(layer => layer.length > 0) ?? admitted;
    if (!pool.length) throw new Error(`Auxiliary role ${role}: no candidate qualified (${Object.entries(reasons).map(([reason, count]) => `${reason}: ${count}`).join('; ') || 'no Gateway-available normal models'})`);
    return pool.map(({ model, levels }) => ({
      model,
      reasoningEffort: preferred.find(effort => levels.includes(effort)) ?? resolveReasoningEffort(preferred[0]!, levels),
    }));
  };
}

/** Read only current routing weights/cap; old auxiliary preference files are inert. */
export function readAuxiliaryRoutingSettings(configPath: string): TaskSettingsLayer | undefined {
  const config = new JsonForemanConfigStore().read(configPath);
  return readGlobalTaskSettings(config?.tasks as TasksConfigSettingsInput | undefined);
}
