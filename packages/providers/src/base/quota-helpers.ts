import type { ProviderQuotaBinding, ProviderQuotaPool, ProviderQuotaPoolWindow, QuotaResetKind, QuotaEvidenceKind } from './quota.ts';

/** Builds one frozen usage window at module load. */
export function quotaWindow(
  windowId: string,
  resetKind: QuotaResetKind,
  evidence: QuotaEvidenceKind,
  evidenceRef: string,
  checkedAt = '2026-09-08',
): ProviderQuotaPoolWindow {
  return Object.freeze({ windowId, resetKind, evidence, evidenceRef, checkedAt });
}

/** Builds one frozen usage-quota pool with a fresh frozen windows array. */
export function quotaPool(
  quotaPoolId: string,
  windows: readonly ProviderQuotaPoolWindow[],
): ProviderQuotaPool {
  return Object.freeze({ quotaPoolId, kind: 'quota' as const, windows: Object.freeze(windows.slice()) });
}

/** Builds one frozen mandatory monetary-balance pool at module load. */
export function balancePool(
  quotaPoolId: string,
  evidenceRef: string,
  checkedAt = '2026-09-08',
): ProviderQuotaPool {
  return Object.freeze({ quotaPoolId, kind: 'balance' as const, windows: Object.freeze([]), balanceId: quotaPoolId, evidenceRef, checkedAt });
}

/** Builds one frozen binding, guaranteeing a non-empty pools array. */
export function binding(
  providerId: string,
  modelId: string,
  pools: readonly ProviderQuotaPool[],
): ProviderQuotaBinding {
  return Object.freeze({ providerId, modelId, pools: Object.freeze(pools.slice()) });
}

