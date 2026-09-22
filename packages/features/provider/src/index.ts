/**
 * Provider product feature.
 *
 * Owns provider catalog listing/configuration plus per-provider quota
 * acquisition, moved out of the daemon.
 */
export { ProviderService, PROVIDER_QUOTA_TIMEOUT_MS, toQuotaSnapshot } from './service.ts'
export type {
  ProviderLocalSpeedReader,
  ProviderModelStatus,
  ProviderModelStatusReader,
  ProviderServiceOptions,
} from './service.ts'
export type { CodeBuddyQueryContext } from '@wrenyard/quota'
