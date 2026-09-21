export type QuotaResetKind = 'full_cycle' | 'rolling_partial' | 'unproven';

export type QuotaEvidenceKind = 'official_docs' | 'provider_parser';

/** A pool is either a raw usage-quota resource or a monetary balance. */
export type QuotaPoolKind = 'quota' | 'balance';

/** One raw usage window required to cover a model's reset cycles. */
export interface ProviderQuotaPoolWindow {
  readonly windowId: string;
  readonly resetKind: QuotaResetKind;
  readonly evidence: QuotaEvidenceKind;
  readonly evidenceRef: string;
  readonly checkedAt: string;
}

/** One quota resource (usage window set or monetary balance) a model draws from. */
export interface ProviderQuotaPool {
  readonly quotaPoolId: string;
  readonly kind: QuotaPoolKind;
  /** Raw usage windows for a `quota` pool; empty when no evidence exists yet. */
  readonly windows: readonly ProviderQuotaPoolWindow[];
  /** Raw Forge balance row id for a `balance` pool. */
  readonly balanceId?: string;
  readonly evidenceRef?: string;
  readonly checkedAt?: string;
}

export interface ProviderQuotaBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly pools: readonly ProviderQuotaPool[];
}

