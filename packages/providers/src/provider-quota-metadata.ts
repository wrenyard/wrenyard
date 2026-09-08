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
}

/** Builds one window object and freezes it at module load. */
function windowConstraint(
  windowId: string,
  resetKind: QuotaResetKind,
  evidence: QuotaEvidenceKind,
  evidenceRef: string,
): ProviderQuotaWindowConstraint {
  return Object.freeze({
    windowId,
    required: true,
    resetKind,
    evidence,
    evidenceRef,
    checkedAt: '2026-09-08',
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

/** Fresh frozen windows array for each zhipu-coding binding (no aliasing). */
function zhipuCodingWindows(): readonly ProviderQuotaWindowConstraint[] {
  return Object.freeze([
    windowConstraint(
      '5h',
      'unproven',
      'provider_parser',
      'runtime/forge/internal/usage/quota/bigmodel.go',
    ),
    windowConstraint(
      '7d',
      'unproven',
      'provider_parser',
      'runtime/forge/internal/usage/quota/bigmodel.go',
    ),
  ]);
}

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
      windowConstraint(
        '1mo',
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
