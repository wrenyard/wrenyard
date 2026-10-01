import type { ProviderQuotaBinding, ProviderQuotaPool } from './quota.ts';
import type { QuotaSnapshot } from './quota-snapshot.ts';
/** Feature-injected raw sources. Providers decide interpretation and fallback. */
export interface QuotaSource {
  read(source?: 'primary' | 'fallback'): Promise<unknown>;
}
export interface ProviderQuota {
  readonly bindings: readonly ProviderQuotaBinding[];
  readonly defaultPools: readonly ProviderQuotaPool[];
  /**
   * Minimum interval between successful upstream reads. While it has not
   * elapsed, a cached observation is returned even for an explicit refresh, so
   * an aggressively rate-limited endpoint is never polled faster than this.
   */
  readonly minRefreshMs?: number;
  read?(source: QuotaSource): Promise<QuotaSnapshot | undefined>;
}
