import { QuotaService, type CodeBuddyQueryContext } from '@wrenyard/quota';
export type { CodeBuddyQueryContext } from '@wrenyard/quota';

const quotaService = new QuotaService();

/** Compatibility entry point: the daemon delegates acquisition to the feature. */
export function queryQuotaJson(context?: CodeBuddyQueryContext): Promise<string> {
  return quotaService.queryJson(context);
}
