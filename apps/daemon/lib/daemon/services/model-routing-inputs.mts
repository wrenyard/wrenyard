import type { CandidateInput, RequiredQuotaConstraint } from '@wrenyard/auto-routing';
import { INTELLIGENCE_ORDER } from '@wrenyard/providers/catalog';
import { findProviderQuotaBinding, resolveDeepSeekReferencePricing, resolveSubscriptionEconomics, type DeepSeekPricingModel, type DeepSeekReferencePricing } from '@wrenyard/providers';
import type { TaskResolvedDispatch } from '../../task-run-metadata-types.mts';
import type { AutoRoutingQuotaSnapshot } from './auto-routing-snapshot-service.mts';

/** Model evidence only: callers supply their own route identity and transport. */
export interface ModelRoutingEntry {
  choice: {
    provider: string; model: string; client: string; exactAgentRuntime: string;
    intelligence: string;
    reference_pricing: { output_usd_per_million?: number | null };
    speed: { effective_tps: number };
  };
  availability?: {
    providerCredential: string; available: boolean;
    freeSupply?: { confirmedFree: true; source: string; ruleId: string };
    quotaFloor?: { source: string; ruleId: string };
  };
}

export interface AutomaticSelectionContext {
  snapshotId: string
  nowMs: number
  timeoutMs: number
  snapshot: AutoRoutingQuotaSnapshot | null
  capUsdPerM: number
  minimumTps: number
  expectedTps: number
  intelligenceMinRank: number
  intelligenceExpectedRank: number | undefined
}

/** Task and auxiliary selection share the same cap and normalization rules. */
export function effectiveRoutingCap(references: readonly number[], caps: readonly number[]): number {
  return caps.length > 0 ? Math.min(...caps) : Math.max(...references);
}

const DEEPSEEK_SAFETY_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1_000

export interface DeepSeekAutomaticPricing {
  safetyOutputUsdPerM: number
  marginalPrice: NonNullable<CandidateInput['marginalPrice']>
  attemptReferencePricing: TaskResolvedDispatch['reference_pricing']
}

function deepSeekModelOf(dispatch: { provider: string; model: string }): DeepSeekPricingModel | undefined {
  // Only the active deepseek-flash tariff applies. Match exact CodeBuddy and
  // TokenHub model identities; retired ids must not resolve to a price.
  if (dispatch.provider === 'codebuddy' && dispatch.model === 'deepseek-v4.1-flash') return 'deepseek-flash'
  if (dispatch.provider === 'tokenhub' && dispatch.model === 'deepseek/deepseek-flash') return 'deepseek-flash'
  return undefined
}

function toTaskReferencePricing(pricing: DeepSeekReferencePricing): TaskResolvedDispatch['reference_pricing'] {
  return {
    input_usd_per_million: pricing.inputCacheMissPerMillion,
    cached_input_usd_per_million: pricing.inputCacheHitPerMillion,
    output_usd_per_million: pricing.outputPerMillion,
    source: pricing.sources.join(' | '),
    checked_at: pricing.checkedAt,
  }
}

/** Request-time DeepSeek evidence has two deliberately distinct prices: the
 *  applicable official peak/list price for hard admission and the worst
 *  actual peak/off-peak price inside this attempt for ranking and costing. */
export function deepSeekAutomaticPricingOf(
  dispatch: { provider: string; model: string },
  nowMs: number,
  timeoutMs: number,
): DeepSeekAutomaticPricing | undefined {
  const model = deepSeekModelOf(dispatch)
  if (model === undefined) return undefined
  const throughMs = nowMs + timeoutMs
  const attempt = resolveDeepSeekReferencePricing({ model, currency: 'USD', at: nowMs, through: throughMs })
  // Any seven-day interval contains every UTC weekday peak window. Extending
  // only forward preserves the applicable tariff eras: pre-cut/crossing keeps
  // the old higher peak, while a horizon beginning at/after the cut never
  // reaches back into the retired table.
  const safety = resolveDeepSeekReferencePricing({
    model,
    currency: 'USD',
    at: nowMs,
    through: Math.max(throughMs, nowMs + DEEPSEEK_SAFETY_LOOKAHEAD_MS),
  })
  return {
    safetyOutputUsdPerM: safety.outputPerMillion,
    marginalPrice: {
      usdPerM: attempt.outputPerMillion,
      appliesFromMs: nowMs,
      appliesUntilMs: throughMs,
      source: attempt.sources.join(' | '),
      ruleId: `deepseek-official-tariff:${model}:${attempt.checkedAt}`,
      worst_applicable: 'worst_applicable',
    },
    attemptReferencePricing: toTaskReferencePricing(attempt),
  }
}

export function withDeepSeekAttemptPricing(
  dispatch: TaskResolvedDispatch,
  nowMs: number,
  timeoutMs: number,
): TaskResolvedDispatch {
  const pricing = deepSeekAutomaticPricingOf(dispatch, nowMs, timeoutMs)
  return pricing === undefined
    ? dispatch
    : { ...dispatch, reference_pricing: pricing.attemptReferencePricing }
}

/** Builds explicit null quota constraints for every pool bound to a provider
 *  model that has no snapshot entry. Uses the unified exported provider
 *  metadata (`findProviderQuotaBinding`) so each bound `quota`/`balance` pool
 *  contributes one null constraint keyed by its normalized pool id — an unbound
 *  candidate is never silently admitted. An unknown provider yields no pools. */
function missingEntryRequiredQuota(
  providerId: string,
  modelId: string,
): RequiredQuotaConstraint[] {
  const binding = findProviderQuotaBinding(providerId, modelId)
  if (binding === undefined) return [{ id: `${providerId}/usage`, evidence: null }]
  return binding.pools.map((pool) =>
    pool.kind === 'balance'
      ? { id: pool.quotaPoolId, evidence: null, kind: 'balance' as const, balance: null }
      : { id: pool.quotaPoolId, evidence: null },
  )
}

/** Builds one policy CandidateInput from truthful resolved dispatch evidence,
 *  the snapshot quota entry (or an empty unknown list), and the confirmed-free
 *  supply fact covering the routing timeout horizon. Returns null when the
 *  candidate cannot supply truthful reference/speed/intelligence evidence. */
export function toAutomaticCandidateInput(
  entry: ModelRoutingEntry,
  context: AutomaticSelectionContext,
  deepSeekPricing?: DeepSeekAutomaticPricing,
): CandidateInput | null {
  const choice = entry.choice
  const referenceUsdPerM = deepSeekPricing?.safetyOutputUsdPerM
    ?? choice.reference_pricing.output_usd_per_million!
  const intelligenceRank = INTELLIGENCE_ORDER[choice.intelligence as keyof typeof INTELLIGENCE_ORDER]
  if (intelligenceRank === undefined || !Number.isFinite(intelligenceRank)) return null
  const quotaEntry = context.snapshot?.entries.find(
    (candidate) => candidate.providerId === choice.provider && candidate.modelId === choice.model,
  ) ?? context.snapshot?.entries.find(
    (candidate) => candidate.providerId === choice.provider && candidate.modelId === '*',
  )
  // When the snapshot carries an explicit entry its required constraints are
  // authoritative, including an upstream-declared empty list (no applicable
  // quota). A missing entry must never silently bypass quota: build explicit
  // null constraints for every bound pool from the unified provider metadata
  // (both usage `quota` and `balance` kinds), so policy sees incomplete/unknown
  // coverage rather than an unbound candidate.
  const requiredQuota = quotaEntry !== undefined
    ? quotaEntry.requiredQuota
    : missingEntryRequiredQuota(choice.provider, choice.model)
  const freeFact = entry.availability?.freeSupply
  // Verified quota-burn efficiency is a separate, provenance-bearing signal from
  // the pure subscription-economics resolver. It is consulted ONLY when the live
  // readiness probe reported an available provider credential for this exact
  // runtime triple — unknown or missing credentials never produce efficiency.
  // The resolver owns every provider/client/model rule and horizon check; this
  // code never rewrites the listed reference price or the DeepSeek marginal USD
  // price, and never amortizes any estimate into a monetary route price.
  const availability = entry.availability
  const economics = availability?.providerCredential === 'available' && availability?.available === true
    ? resolveSubscriptionEconomics({
        provider: choice.provider,
        model: choice.model,
        client: choice.client,
        atMs: context.nowMs,
        throughMs: context.nowMs + context.timeoutMs,
        authenticated: true,
      })
    : undefined
  const verifiedEfficiency = economics === undefined
    ? null
    : {
        efficiencyScore: economics.efficiencyScore,
        appliesFromMs: economics.atMs,
        appliesUntilMs: economics.throughMs,
        source: economics.source,
        ruleId: economics.ruleId,
        domain: 'quota_burn_efficiency' as const,
        worst_applicable: 'worst_applicable' as const,
      }
  // Fixed base-pool automatic-routing discount, resolved from the bound pools.
  // The conservative rate is the maximum across pools and is applied ONCE, never
  // multiplied/compounded across multiple 5h/7d pools. A balance pool is always
  // 1; a missing/empty binding defaults to 1.
  const boundPools = findProviderQuotaBinding(choice.provider, choice.model)?.pools ?? []
  const quotaPoolDiscountRate = boundPools.length === 0
    ? 1
    : Math.max(...boundPools.map((pool) => pool.kind === 'balance' ? 1 : (pool.routingDiscountRate ?? 1)))
  return {
    snapshotId: context.snapshotId,
    canonicalId: choice.exactAgentRuntime,
    nowMs: context.nowMs,
    referenceUsdPerM,
    quotaPoolDiscountRate,
    effectiveCapUsdPerM: context.capUsdPerM,
    timeoutMs: context.timeoutMs,
    minimumTps: context.minimumTps,
    effectiveTps: choice.speed.effective_tps,
    expectedTps: context.expectedTps,
    intelligenceRank,
    intelligenceMinRank: context.intelligenceMinRank,
    intelligenceExpectedRank: context.intelligenceExpectedRank,
    requiredQuota,
    ...(deepSeekPricing !== undefined ? { marginalPrice: deepSeekPricing.marginalPrice } : {}),
    verifiedEfficiency,
    confirmedFreeSupply: freeFact
      ? {
          kind: 'confirmed_free',
          appliesFromMs: context.nowMs,
          appliesUntilMs: context.nowMs + context.timeoutMs,
          source: freeFact.source,
          ruleId: freeFact.ruleId,
        }
      : null,
    unknownQuotaFloor: entry.availability?.quotaFloor
      ? {
          kind: 'unknown_quota_floor' as const,
          appliesFromMs: context.nowMs,
          appliesUntilMs: context.nowMs + context.timeoutMs,
          source: entry.availability.quotaFloor.source,
          ruleId: entry.availability.quotaFloor.ruleId,
          worst_applicable: 'worst_applicable' as const,
        }
      : null,
  }
}

