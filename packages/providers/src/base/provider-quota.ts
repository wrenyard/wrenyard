import type { ProviderQuotaBinding, ProviderQuotaPool } from './quota.ts';
import type { QuotaSnapshot } from './quota-snapshot.ts';
/** Feature-injected raw sources. Providers decide interpretation and fallback. */
export interface QuotaSource {
  read(source?: 'primary' | 'fallback'): Promise<unknown>;
}
export interface ProviderQuota {
  readonly bindings: readonly ProviderQuotaBinding[];
  readonly defaultPools: readonly ProviderQuotaPool[];
  read?(source: QuotaSource): Promise<QuotaSnapshot | undefined>;
}
