/**
 * Closed, pure task-resolution failure contract for automatic dispatch.
 *
 * Every automatic-mode failure surfaces exactly one machine code plus one
 * safe closed Chinese message. The six public codes are fixed:
 *
 * - no_available_provider     no provider/model remains available at all
 * - price_limit               nothing fits inside the allowed price
 * - intelligence_requirement  nothing satisfies the intelligence bounds
 * - speed_requirement         nothing satisfies the minimum/expected speed
 * - quota_unavailable         a real determinate quota block
 * - quota_insufficient        a real determinate quota-insufficient gate
 *
 * This module never interpolates raw errors, scores, prices, TPS, provider or
 * model ids, credentials, symbols, or canonical targets. It never fabricates
 * an elimination: selection is deterministic and derived only from structured
 * actual eliminations (never from exception text).
 *
 * Quota policy: an unknown/incomplete quota is NOT quota_unavailable and
 * strained quota is NOT an elimination (it only demotes). A real determinate
 * quota-insufficient gate may use quota_insufficient, but no caller may invent
 * a new quota gate here.
 */

export const TASK_RESOLUTION_FAILURE_CODES = [
  'no_available_provider',
  'price_limit',
  'intelligence_requirement',
  'speed_requirement',
  'quota_unavailable',
  'quota_insufficient',
] as const

export type TaskResolutionFailureCode = (typeof TASK_RESOLUTION_FAILURE_CODES)[number]

/** Fixed stable tie-break order; also the schema/union order on the wire. */
export const TASK_RESOLUTION_FAILURE_CODE_ORDER: readonly TaskResolutionFailureCode[] =
  TASK_RESOLUTION_FAILURE_CODES

export const TASK_RESOLUTION_FAILURE_MESSAGES: Readonly<Record<TaskResolutionFailureCode, string>> = {
  no_available_provider: '没有可用的服务商，请检查登录或凭据',
  price_limit: '允许价格内没有可用模型，请调整价格上限',
  intelligence_requirement: '没有模型满足智能要求，请调整智能要求',
  speed_requirement: '没有模型满足速度要求，请调整速度要求',
  quota_unavailable: '模型额度不可用，请检查额度状态',
  quota_insufficient: '模型额度不足，请等待额度恢复',
}

export interface TaskResolutionFailure {
  code: TaskResolutionFailureCode
  /** Safe closed Chinese message; never interpolates raw product copy. */
  message: string
}

/** Deterministic closed code-to-message construction. */
export function taskResolutionFailure(code: TaskResolutionFailureCode): TaskResolutionFailure {
  return { code, message: TASK_RESOLUTION_FAILURE_MESSAGES[code] }
}

/**
 * One structured actual elimination recorded at a real gate. `code` is the
 * classified machine code. `priceUsdPerMillion` is an OPTIONAL bounded
 * internal comparison input (reference output price per million output
 * tokens) used only to reproduce existing deterministic routing relevance:
 * the candidate the router would have selected first had it passed its gate is
 * the most relevant elimination to surface. Unknown/incomplete quota never
 * produces an elimination here; real determinate quota-insufficient gates may.
 */
export interface TaskResolutionElimination {
  code: TaskResolutionFailureCode
  /** Bounded internal routing comparator (reference output price per million).
   *  Lower = higher deterministic routing relevance. Never serialized. */
  priceUsdPerMillion?: number
}

/**
 * Deterministic mixed-elimination selection independent of input order.
 *
 * Selection prefers the elimination attached to the candidate that would be
 * most relevant under the existing deterministic routing order (the candidate
 * with the smallest bounded reference price), then applies the fixed stable
 * code order as a tie-break, then picks the first matching elimination by its
 * fixed position in the supplied array. Result never depends on shuffle.
 *
 * Returns `undefined` when no structured elimination is supplied.
 */
export function selectTaskResolutionFailure(
  eliminations: ReadonlyArray<TaskResolutionElimination>,
): TaskResolutionFailure | undefined {
  if (eliminations.length === 0) return undefined

  const codePriority = (code: TaskResolutionFailureCode): number =>
    TASK_RESOLUTION_FAILURE_CODE_ORDER.indexOf(code)

  let bestIndex = 0
  for (let index = 1; index < eliminations.length; index += 1) {
    const candidate = eliminations[index] as TaskResolutionElimination
    const current = eliminations[bestIndex] as TaskResolutionElimination
    if (candidate === undefined || current === undefined) continue
    const candidatePrice = candidate.priceUsdPerMillion ?? Number.POSITIVE_INFINITY
    const currentPrice = current.priceUsdPerMillion ?? Number.POSITIVE_INFINITY
    const candidateCode = codePriority(candidate.code)
    const currentCode = codePriority(current.code)
    const candidateBetter =
      candidatePrice < currentPrice
      || (candidatePrice === currentPrice && candidateCode < currentCode)
    if (candidateBetter) bestIndex = index
  }
  const chosen = eliminations[bestIndex]
  return chosen === undefined ? undefined : taskResolutionFailure(chosen.code)
}

/**
 * Mapping from real Catalog auto-routing exclusion reasons to the closed code
 * set. Only reasons that represent a real elimination gate are mapped:
 *
 * - reference_above_cap / marginal_above_reference -> price_limit
 * - speed_below_minimum                           -> speed_requirement
 * - intelligence_out_of_range                     -> intelligence_requirement
 * - quota_blocked                                 -> quota_unavailable
 *
 * Unknown/strained/incomplete quota reasons are not hard eliminations and are
 * NOT mapped (returns undefined). The obsolete reference_price_gate is gone:
 * a genuinely unknown/incomplete quota is neutral regardless of listed price,
 * so it is never classified as a price elimination.
 */
export const CATALOG_EXCLUSION_CODE_MAP: Readonly<Record<string, TaskResolutionFailureCode>> = {
  reference_above_cap: 'price_limit',
  marginal_above_reference: 'price_limit',
  speed_below_minimum: 'speed_requirement',
  intelligence_out_of_range: 'intelligence_requirement',
  quota_blocked: 'quota_unavailable',
}

export function codeFromCatalogExclusion(reason: string): TaskResolutionFailureCode | undefined {
  return CATALOG_EXCLUSION_CODE_MAP[reason]
}
