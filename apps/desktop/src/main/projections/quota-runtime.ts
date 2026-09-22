/**
 * Desktop-owned quota/model wire→UI projection. The daemon owns quota
 * acquisition and interpretation; Desktop only parses the returned provider
 * rows and projects them for the shell window, tray and Pet tips. This module
 * is the projection entry point for the rest of Desktop — consumers never
 * reach into the Pet module for quota types.
 */
export { parseQuotaJson } from './quota-service';
export type { QuotaProviderState, QuotaProviderStatus, QuotaWindowRow } from '../../pet/shared/entities';
