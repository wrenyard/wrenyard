/**
 * Immutable provider quota-applicability metadata.
 *
 * Each binding maps a provider code model to the quota pool it draws from and
 * lists the raw windows (as surfaced by the provider or the Go quota parser)
 * that are required to cover that model's quota reset cycles.
 *
 * A model with single-pool applicability keeps the top-level quotaPoolId and
 * windows fields. A model with joint applicability lists every required pool
 * under `pools`; each pool carries its own quotaPoolId and required windows.
 * When a pool's required windows array is empty, no raw provider window
 * evidence has been reviewed yet: consumers must treat that pool's reset
 * coverage as incomplete/unknown and must not assume any invented window,
 * balance, reset timestamp, or reset kind.
 *
 * Reset semantics:
 * - full_cycle:      quota resets on a full cycle boundary.
 * - rolling_partial: quota resets only partially inside a rolling interval.
 * - unproven:        reset semantics not yet established by evidence.
 *
 * `checkedAt` is provenance only: it records when the evidence below was
 * reviewed. It is never consulted at runtime as a freshness signal.
 *
 * This module has zero runtime dependencies and performs no I/O.
 */

export type QuotaResetKind = 'full_cycle' | 'rolling_partial' | 'unproven';

export type QuotaEvidenceKind = 'official_docs' | 'provider_parser';

export interface ProviderQuotaWindowConstraint {
  readonly windowId: string;
  readonly required: true;
  readonly resetKind: QuotaResetKind;
  readonly evidence: QuotaEvidenceKind;
  readonly evidenceRef: string;
  readonly checkedAt: string;
}

export interface ProviderQuotaPoolConstraint {
  readonly quotaPoolId: string;
  readonly windows: readonly ProviderQuotaWindowConstraint[];
}

/**
 * A mandatory monetary balance constraint for a pool binding.
 *
 * Balance evidence comes from the existing Forge balances source (raw
 * `balances: [{ currency, amount }]` with a decimal amount string); no second
 * balance table is introduced. A fresh, valid amount strictly greater than
 * zero means the resource is not exhausted and carries neutral quota quality
 * (it never boosts subscription pace). Exactly zero blocks. Malformed,
 * negative, stale or missing values are unknown and are never fabricated as
 * zero — the constraint stays uncovered (null evidence) in that case.
 */
export interface ProviderQuotaBalanceConstraint {
  readonly balanceId: string;
  readonly required: true;
  readonly evidence: QuotaEvidenceKind;
  readonly evidenceRef: string;
  readonly checkedAt: string;
}

export interface ProviderQuotaBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly quotaProviderId: string;
  /** Single-pool applicability keeps the top-level pool fields. */
  readonly quotaPoolId?: string;
  /** Single-pool required raw windows. Absent for multi-pool bindings. */
  readonly windows?: readonly ProviderQuotaWindowConstraint[];
  /** Jointly applicable required pools for multi-pool bindings. */
  readonly pools?: readonly ProviderQuotaPoolConstraint[];
  /** Optional mandatory monetary balance resources; all must pass. */
  readonly requiredBalances?: readonly ProviderQuotaBalanceConstraint[];
}

/** Builds one window object and freezes it at module load. */
function windowConstraint(
  windowId: string,
  resetKind: QuotaResetKind,
  evidence: QuotaEvidenceKind,
  evidenceRef: string,
  checkedAt = '2026-09-08',
): ProviderQuotaWindowConstraint {
  return Object.freeze({
    windowId,
    required: true,
    resetKind,
    evidence,
    evidenceRef,
    checkedAt,
  });
}

/** Builds one pool object with a fresh, frozen windows array at module load. */
function poolConstraint(
  quotaPoolId: string,
  windows: readonly ProviderQuotaWindowConstraint[],
): ProviderQuotaPoolConstraint {
  return Object.freeze({
    quotaPoolId,
    windows: Object.freeze(windows.slice()),
  });
}

/** Builds one frozen mandatory balance constraint at module load. */
function balanceConstraint(
  balanceId: string,
  evidenceRef: string,
  checkedAt = '2026-09-08',
): ProviderQuotaBalanceConstraint {
  return Object.freeze({
    balanceId,
    required: true,
    evidence: 'provider_parser',
    evidenceRef,
    checkedAt,
  });
}

/** Fresh frozen windows array for each zhipu-coding binding (no aliasing). */
function zhipuCodingWindows(): readonly ProviderQuotaWindowConstraint[] {
  return Object.freeze([
    windowConstraint(
      '5h',
      'rolling_partial',
      'official_docs',
      'https://docs.bigmodel.cn/cn/coding-plan/overview',
      '2026-09-09',
    ),
    windowConstraint(
      '7d',
      'full_cycle',
      'official_docs',
      'https://docs.bigmodel.cn/cn/coding-plan/overview',
      '2026-09-09',
    ),
  ]);
}

/** Fresh frozen windows array for each codex binding (no aliasing). */
function codexWindows(): readonly ProviderQuotaWindowConstraint[] {
  return Object.freeze([
    windowConstraint(
      '7d',
      'full_cycle',
      'provider_parser',
      'runtime/forge/internal/usage/quota/codex.go',
      '2026-09-09',
    ),
  ]);
}

/** Codex Spark has its own raw pool and currently reports both reset windows. */
function codexSparkWindows(): readonly ProviderQuotaWindowConstraint[] {
  return Object.freeze([
    windowConstraint(
      '5h',
      'full_cycle',
      'provider_parser',
      'runtime/forge/internal/usage/quota/codex.go',
      '2026-09-09',
    ),
    windowConstraint(
      '7d',
      'full_cycle',
      'provider_parser',
      'runtime/forge/internal/usage/quota/codex.go',
      '2026-09-09',
    ),
  ]);
}

/**
 * Builds one frozen codex-family single-pool binding with a fresh windows
 * array. The provider id, raw Forge row, normalized pool, and required windows
 * are explicit so Codex Spark cannot be accidentally folded into Codex.
 */
function codexSubscriptionBinding(
  providerId: string,
  modelId: string,
  quotaProviderId = 'codex',
  quotaPoolId = 'codex-models',
  windows: readonly ProviderQuotaWindowConstraint[] = codexWindows(),
): ProviderQuotaBinding {
  return Object.freeze({
    providerId,
    modelId,
    quotaProviderId,
    quotaPoolId,
    windows,
  });
}

/** Current codex subscription model ids billed to the shared codex quota. */
const CODEX_SUBSCRIPTION_MODEL_IDS: readonly string[] = Object.freeze([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.3-codex-spark',
  'gpt-6-astra',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
]);

export const PROVIDER_QUOTA_BINDINGS: readonly ProviderQuotaBinding[] = Object.freeze([
  Object.freeze({
    providerId: 'cursor',
    modelId: 'cursor-grok-4.6-high',
    quotaProviderId: 'cursor',
    quotaPoolId: 'cursor-models',
    windows: Object.freeze([
      windowConstraint(
        'Cursor',
        'full_cycle',
        'official_docs',
        'https://cursor.com/docs/models-and-pricing',
      ),
    ]),
  }),
  // K3 consumes the Other allowance, independently of the Cursor model pool.
  Object.freeze({
    providerId: 'cursor',
    modelId: 'kimi-k3',
    quotaProviderId: 'cursor',
    quotaPoolId: 'cursor-other',
    windows: Object.freeze([
      windowConstraint('Other', 'full_cycle', 'provider_parser', 'runtime/forge/internal/usage/quota/cursor.go', '2026-09-10'),
    ]),
  }),
  Object.freeze({
    providerId: 'kimi-coding',
    modelId: 'k3',
    quotaProviderId: 'kimi-coding',
    quotaPoolId: 'kimi-membership-coding',
    windows: Object.freeze([
      windowConstraint(
        '5h',
        'rolling_partial',
        'official_docs',
        'https://www.kimi.com/code/docs/en/kimi-code/membership.html',
      ),
      windowConstraint(
        '7d',
        'full_cycle',
        'official_docs',
        'https://www.kimi.com/code/docs/en/kimi-code/membership.html',
      ),
    ]),
  }),
  Object.freeze({
    providerId: 'zhipu-coding',
    modelId: 'glm-5.3',
    quotaProviderId: 'zhipu-coding',
    quotaPoolId: 'zhipu-coding-tokens',
    windows: zhipuCodingWindows(),
  }),
  Object.freeze({
    providerId: 'zhipu-coding',
    modelId: 'glm-5.3-flash',
    quotaProviderId: 'zhipu-coding',
    quotaPoolId: 'zhipu-coding-tokens',
    windows: zhipuCodingWindows(),
  }),
  // CodeBuddy HY3 (canonical model id 'hy3') quota draws jointly on the
  // normalized internal pools 'codebuddy-hy-family' (HY family allowance) and
  // 'codebuddy-monthly' (account monthly allowance). Both pools apply together.
  // No raw upstream window ids, window balances, reset timestamps, or reset
  // kinds are asserted yet: each pool carries a frozen-empty required windows
  // array until a sanitized provider quota sample is reviewed.
  Object.freeze({
    providerId: 'codebuddy',
    modelId: 'hy3',
    quotaProviderId: 'codebuddy',
    pools: Object.freeze([
      poolConstraint('codebuddy-hy-family', []),
      poolConstraint('codebuddy-monthly', []),
    ]),
  }),
  // Codex subscription quota: every current codex-provider model consumes the
  // Forge `codex` row. The weekly `7d` window is always required. Some current
  // accounts legitimately expose only that window; when a primary `5h` window
  // is present the snapshot layer conditionally includes it, so exhausted or
  // strained primary quota still participates without making absent 5h data
  // incomplete (checked 2026-09-09).
  ...CODEX_SUBSCRIPTION_MODEL_IDS.map((modelId) => codexSubscriptionBinding('codex', modelId)),
  // Codex Spark is a separate provider/pool. Its current raw `codex-spark` row
  // reports both 5h and 7d, and both are required for complete coverage.
  codexSubscriptionBinding(
    'codex-spark',
    'gpt-5.3-codex-spark',
    'codex-spark',
    'codex-spark-models',
    codexSparkWindows(),
  ),
  // Official deepseek/deepseek-flash: no registered official provider exists in
  // the public catalog yet, so this explicit model binding carries ONLY a
  // mandatory monetary balance resource (`deepseek` raw row). It deliberately
  // inherits NO CodeBuddy or TokenHub balance: a missing/stale/unknown amount
  // keeps coverage incomplete rather than fabricating a balance.
  Object.freeze({
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    quotaProviderId: 'deepseek',
    quotaPoolId: 'deepseek-balance',
    requiredBalances: Object.freeze([
      balanceConstraint('deepseek-balance', 'runtime/forge/internal/usage/quota/deepseek.go'),
    ]),
  }),
]);

/** Exact providerId + modelId lookup. Returns the matching binding or undefined. */
export function findProviderQuotaBinding(
  providerId: string,
  modelId: string,
): ProviderQuotaBinding | undefined {
  return PROVIDER_QUOTA_BINDINGS.find(
    (binding) => binding.providerId === providerId && binding.modelId === modelId,
  );
}
