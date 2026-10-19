/**
 * Dispatch metadata helpers. Attempt pricing lives here, next to the shared
 * task-run metadata types, and delegates the tariff arithmetic to the routing
 * package so there is exactly one DeepSeek pricing implementation.
 */
import { deepSeekAutomaticPricingOf } from '@wrenyard/auto-routing'
import type { TaskResolvedDispatch } from './task-run-metadata-types.mts'

/** Request-time DeepSeek evidence has two deliberately distinct prices: the
 *  applicable official peak/list price for hard admission and the worst
 *  actual peak/off-peak price inside this attempt for ranking and costing.
 *  This helper stamps the attempt's reference pricing onto a resolved dispatch. */
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
