/**
 * Automatic task candidate assembly and ranking. Callers hand in the already
 * resolved entries and the DeepSeek pricing evidence keyed by canonical id; the
 * policy context, cap and ranking calls all live here.
 */
import { INTELLIGENCE_ORDER, type IntelligenceTier } from '@wrenyard/providers/catalog';
import type { AutoRoutingResult, CandidateInput } from './types.ts';
import { AutoRouter } from './auto-router.ts';
import {
  applyHealthAwareRouteOrdering,
  type GatewayHealthWindowLike,
  type RouteHealthDecision,
} from './selector.ts';
import type { AutoRoutingQuotaSnapshot } from './selector.ts';
import { effectiveRoutingCap, toAutomaticCandidateInput, type AutomaticSelectionContext, type DeepSeekAutomaticPricing, type ModelRoutingEntry } from './selector-inputs.ts';

/** Routing score weights keyed for config, mapped to scorer P/S/Q/I. */
export interface AutomaticTaskRoutingWeights {
  price: number;
  speed: number;
  quota: number;
  intelligence: number;
}

/** Raw invocation requirements plus the one evaluation sample they bind to. */
export interface AutomaticTaskRankingParams {
  snapshotId: string;
  snapshot: AutoRoutingQuotaSnapshot | null;
  nowMs: number;
  timeoutMs: number;
  requirements: {
    minimumTps?: number;
    expectedTps?: number;
    intelligenceMin?: IntelligenceTier;
    intelligenceExpected?: IntelligenceTier;
    maxOutputUsdPerMillion?: number;
  };
  healthPolicy?: {
    thresholdPercent: number;
    routeHealth: (provider: string, model: string) => GatewayHealthWindowLike | undefined;
  };
}

export interface AutomaticTaskRankingResult {
  inputs: CandidateInput[];
  ranked: AutoRoutingResult;
  /** Collapsed candidates that could not build a truthful scored input. */
  unscorableIds: string[];
  capUsdPerM: number;
  healthDecisions?: RouteHealthDecision[];
  healthAllAvoidedFallback?: boolean;
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function intelligenceRankOf(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const rank = INTELLIGENCE_ORDER[value as keyof typeof INTELLIGENCE_ORDER];
  return rank === undefined ? fallback : rank;
}

/** Builds the policy context and ranks every truthfully scorable entry once. */
export function rankAutomaticTaskCandidates(
  entries: readonly ModelRoutingEntry[],
  params: AutomaticTaskRankingParams,
  routingWeights: AutomaticTaskRoutingWeights | undefined,
  deepSeekPricing: ReadonlyMap<string, DeepSeekAutomaticPricing>,
): AutomaticTaskRankingResult {
  const caps: number[] = [];
  if (typeof params.requirements.maxOutputUsdPerMillion === 'number') {
    caps.push(params.requirements.maxOutputUsdPerMillion);
  }
  // Current choices originate from validated Catalog prices; optional metadata
  // fields only describe older persisted dispatch records. A missing reference
  // (explicit free route with no declared price) is passed through as undefined
  // so effectiveRoutingCap keeps its finite-only default semantics.
  const finiteReferences = entries
    .map((entry) => deepSeekPricing.get(entry.choice.exactAgentRuntime)?.safetyOutputUsdPerM
      ?? entry.choice.reference_pricing.output_usd_per_million);
  const capUsdPerM = effectiveRoutingCap(finiteReferences, caps);

  const context: AutomaticSelectionContext = {
    snapshotId: params.snapshotId,
    nowMs: params.nowMs,
    timeoutMs: params.timeoutMs,
    snapshot: params.snapshot,
    capUsdPerM,
    minimumTps: finiteOrDefault(params.requirements.minimumTps, 0),
    expectedTps: finiteOrDefault(params.requirements.expectedTps, 0),
    intelligenceMinRank: intelligenceRankOf(params.requirements.intelligenceMin, 0),
    intelligenceExpectedRank: (() => {
      const expectedTier = params.requirements.intelligenceExpected;
      if (expectedTier !== undefined) {
        return intelligenceRankOf(expectedTier, INTELLIGENCE_ORDER.premium);
      }
      // Missing expectation defaults to `mid`, clamped upward to the
      // effective hard minimum so it is always an admissible target
      // (consistent with the settings resolver, which also defaults to
      // `mid`). There is no configurable ceiling.
      let resolved: IntelligenceTier = 'mid';
      const minTier = params.requirements.intelligenceMin;
      if (minTier !== undefined && INTELLIGENCE_ORDER.mid < INTELLIGENCE_ORDER[minTier]) {
        resolved = minTier;
      }
      return INTELLIGENCE_ORDER[resolved];
    })(),
  };

  const inputs: CandidateInput[] = [];
  const unscorableIds: string[] = [];
  for (const entry of entries) {
    const pricing = deepSeekPricing.get(entry.choice.exactAgentRuntime);
    const candidate = toAutomaticCandidateInput(entry, context, pricing);
    if (candidate === null) {
      unscorableIds.push(entry.choice.exactAgentRuntime);
      continue;
    }
    inputs.push(candidate);
  }

  const ranked = new AutoRouter().rank(
    inputs,
    routingWeights === undefined
      ? undefined
      : {
          P: routingWeights.price,
          S: routingWeights.speed,
          Q: routingWeights.quota,
          I: routingWeights.intelligence,
        },
  );
  let healthDecisions: RouteHealthDecision[] | undefined;
  let healthAllAvoidedFallback = false;
  if (params.healthPolicy !== undefined && ranked.ranked.length > 0) {
    const entryById = new Map(entries.map((entry) => [entry.choice.exactAgentRuntime, entry]));
    const healthOrdering = applyHealthAwareRouteOrdering(ranked.ranked, {
      thresholdPercent: params.healthPolicy.thresholdPercent,
      routeKeyOf: (candidate) => candidate.canonicalId,
      healthOf: (candidate) => {
        const entry = entryById.get(candidate.canonicalId);
        if (entry === undefined) return undefined;
        return params.healthPolicy!.routeHealth(entry.choice.provider, entry.choice.model);
      },
    });
    healthDecisions = healthOrdering.decisions;
    healthAllAvoidedFallback = healthOrdering.allAvoidedFallback;
    ranked.ranked = healthOrdering.ordered.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
  }
  return {
    inputs,
    ranked,
    unscorableIds,
    capUsdPerM,
    ...(healthDecisions !== undefined ? { healthDecisions, healthAllAvoidedFallback } : {}),
  };
}
