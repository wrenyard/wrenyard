import type { CandidateInput, RequiredQuotaConstraint } from '@wrenyard/auto-routing';
import { INTELLIGENCE_ORDER } from '@wrenyard/providers/catalog';
import { findProviderQuotaBindingForSupply, resolveDeepSeekReferencePricing, type DeepSeekPricingModel, type DeepSeekReferencePricing, type ProviderQuotaBinding } from '@wrenyard/providers';
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

/** Task and auxiliary selection share the same cap and normalization rules.
 *  Callers may pass a missing routing-only reference price (undefined) for an
 *  explicit free offering; those absent values must not turn the default cap
 *  into NaN/Infinity. Only finite references participate, and a pool whose
 *  every reference is absent falls back to a zero routing cap, which admits the
 *  zero-reference free candidates and rejects anything above zero. */
export function effectiveRoutingCap(references: readonly (number | null | undefined)[], caps: readonly number[]): number {
  if (caps.length > 0) return Math.min(...caps)
  const finite = references.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return finite.length > 0 ? Math.max(...finite) : 0
}

const DEEPSEEK_SAFETY_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1_000

export interface DeepSeekAutomaticPricing {
  safetyOutputUsdPerM: number
  marginalPrice: NonNullable<CandidateInput['marginalPrice']>
  attemptReferencePricing: TaskResolvedDispatch['reference_pricing']
}

function deepSeekModelOf(dispatch: { provider: string; model: string }): DeepSeekPricingModel | undefined {
  // Only the active deepseek-flash tariff applies. Match the exact registered
  // model identities; retired or wire spellings must not resolve to a price.
  if (dispatch.provider === 'codebuddy' && dispatch.model === 'deepseek-v4.1-flash') return 'deepseek-flash'
  if (dispatch.provider === 'tokenhub' && dispatch.model === 'deepseek-v4.1-flash') return 'deepseek-flash'
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

/** Builds explicit null quota constraints for one resolved binding. Uses the
 *  unified exported provider metadata so each bound `quota`/`balance` pool
 *  contributes one null constraint keyed by its normalized pool id — an unbound
 *  candidate is never silently admitted. An absent binding keeps the legacy
 *  provider-wide `usage` placeholder. */
function requiredQuotaForBinding(
  providerId: string,
  bucket: ProviderQuotaBinding | undefined,
): RequiredQuotaConstraint[] {
  if (bucket === undefined) return [{ id: `${providerId}/usage`, evidence: null }]
  return bucket.pools.map((pool) =>
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
  const freeFact = entry.availability?.freeSupply
  const confirmedFree = freeFact?.confirmedFree === true
  const intelligenceRank = INTELLIGENCE_ORDER[choice.intelligence as keyof typeof INTELLIGENCE_ORDER]
  if (intelligenceRank === undefined || !Number.isFinite(intelligenceRank)) return null
  // A confirmed-free model binds to its provider's own free pool only, so an
  // exhausted paid pool can never reject it while the live supply fact holds.
  const binding = findProviderQuotaBindingForSupply(choice.provider, choice.model, confirmedFree)
  // Authenticated confirmed-free supply (`freeFact.confirmedFree === true`) is
  // the only evidence that lets a free route with no published price reach
  // ranking: the routing-only reference becomes a numeric zero, used solely as
  // authenticated confirmed-free routing evidence, never a catalog, picker,
  // Gateway or billing price. A declared reference price is preserved verbatim.
  // A missing price without confirmed-free evidence is treated as paid/unknown
  // and stays unresolved (null) rather than asserting an undefined reference.
  const declaredReferenceUsdPerM = choice.reference_pricing.output_usd_per_million
  const referenceUsdPerM = deepSeekPricing?.safetyOutputUsdPerM
    ?? declaredReferenceUsdPerM
    ?? (freeFact?.confirmedFree === true ? 0 : undefined)
  if (referenceUsdPerM === undefined || !Number.isFinite(referenceUsdPerM)) return null
  const quotaEntry = context.snapshot?.entries.find(
    (candidate) => candidate.providerId === choice.provider && candidate.modelId === choice.model,
  ) ?? context.snapshot?.entries.find(
    (candidate) => candidate.providerId === choice.provider && candidate.modelId === '*',
  )
  // When the snapshot carries an explicit entry its required constraints are
  // authoritative, including an upstream-declared empty list (no applicable
  // quota) — except for confirmed-free supply, which must reference its own
  // free pool: a blocked paid pool can never reject a confirmed-free model
  // while SupplyEvidencePolicy zeroes its price. A missing entry must never
  // silently bypass quota: build explicit null constraints for every bound
  // pool from the unified provider metadata (both usage `quota` and `balance`
  // kinds), so policy sees incomplete/unknown coverage rather than an unbound
  // candidate.
  const snapshotRequiredQuota = quotaEntry?.requiredQuota
  const freeRequiredQuota = confirmedFree
    ? requiredQuotaForBinding(choice.provider, binding)
    : undefined
  const requiredQuota = freeRequiredQuota !== undefined
    ? (snapshotRequiredQuota?.some((constraint) => constraint.id === freeRequiredQuota[0].id) === true
        ? snapshotRequiredQuota
        : freeRequiredQuota)
    : (snapshotRequiredQuota ?? requiredQuotaForBinding(choice.provider, binding))
  // Fixed base-pool automatic-routing discount, resolved from the bound pools.
  // The conservative rate is the maximum across pools and is applied ONCE, never
  // multiplied/compounded across multiple 5h/7d pools. A balance pool is always
  // 1; a missing/empty binding defaults to 1.
  const boundPools = binding?.pools ?? []
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
    confirmedFreeSupply: freeFact?.confirmedFree === true
      ? {
          kind: 'confirmed_free',
          appliesFromMs: context.nowMs,
          appliesUntilMs: context.nowMs + context.timeoutMs,
          source: freeFact.source,
          ruleId: freeFact.ruleId,
        }
      : null,
  }
}

