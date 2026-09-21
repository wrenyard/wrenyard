import { HttpQuotaClient, type HttpQuotaProvider } from './http.ts';
import { readCodeBuddyObservation, type CodeBuddyQueryContext } from './observed.ts';
import type { ForgeExecutionOptions } from '@wrenyard/execution';
import { CodexClient, AccountClient, type AccountUsageSource } from '@wrenyard/clients';
import { normalizeChatGPTQuota } from '@wrenyard/providers/chatgpt';
import { normalizeCursorQuota, normalizeDeepSeekQuota, normalizeKimiQuota, normalizeZhipuQuota, normalizeGrokQuota, normalizeClaudeQuota, normalizeCodeBuddyQuota } from '@wrenyard/providers/quota-normalizers';
import type { QuotaSnapshot } from '@wrenyard/providers/base';
export type { CodeBuddyQueryContext } from './observed.ts';
export interface QuotaServiceOptions {
    readonly codex?: Pick<CodexClient, 'readRateLimits'>;
    readonly http?: Pick<HttpQuotaClient, 'readUsage'>;
    readonly accounts?: Pick<AccountClient, 'readUsage' | 'readClaudeOAuth'>;
}
type Normalizer = (raw: unknown) => QuotaSnapshot | undefined;
const accountCollectors: Readonly<Record<string, Normalizer>> = {
    cursor: normalizeCursorQuota,
    deepseek: normalizeDeepSeekQuota,
    'kimi-coding': normalizeKimiQuota,
    'zhipu-coding': normalizeZhipuQuota,
    'claude-coding': normalizeClaudeQuota,
    'super-grok': normalizeGrokQuota,
    codebuddy: normalizeCodeBuddyQuota,
};
export const QUOTA_PROVIDER_IDS = ['chatgpt', ...Object.keys(accountCollectors)] as readonly string[];
/** Acquisition and failure isolation. Each provider interprets its own raw data.
 * Routing snapshot caching stays with its existing owner; no account data is
 * cached here, so fresh requests never reuse an earlier login's observation.
 */
export class QuotaService {
    private readonly codex: Pick<CodexClient, 'readRateLimits'>;
    private readonly http: Pick<HttpQuotaClient, 'readUsage'>;
    private readonly accounts: Pick<AccountClient, 'readUsage' | 'readClaudeOAuth'>;
    constructor(options: QuotaServiceOptions = {}) {
        this.http = options.http ?? new HttpQuotaClient();
        this.codex = options.codex ?? new CodexClient();
        this.accounts = options.accounts ?? new AccountClient();
    }
    async fetch(provider: string, context?: CodeBuddyQueryContext, options?: ForgeExecutionOptions): Promise<QuotaSnapshot | undefined> {
        options?.signal?.throwIfAborted();
        const id = provider === 'spacex-ai' ? 'super-grok' : provider;
        if (id !== 'chatgpt' && !Object.hasOwn(accountCollectors, id)) {
            return { provider, status: 'unavailable', stale: false, code: 'quota_unsupported', message: 'Quota acquisition is not supported for this provider' };
        }
        // Absence of current account context must not reuse an observed CodeBuddy block.
        if (id === 'codebuddy' && (!context?.expectedScope || !context.expectedEnvironment))
            return undefined;
        try {
            const raw = id === 'chatgpt' ? await this.codex.readRateLimits(options)
                : id === 'codebuddy' ? await readCodeBuddyObservation(context, options)
                    : ['deepseek', 'kimi-coding', 'zhipu-coding'].includes(id) ? await this.http.readUsage(id as HttpQuotaProvider, options)
                        : await this.accounts.readUsage(id as AccountUsageSource, options);
            options?.signal?.throwIfAborted();
            if (raw && typeof raw === 'object' && 'error_code' in raw) {
                const code = ['configuration_missing', 'authentication_required', 'quota_query_failed'].includes(String(raw.error_code)) ? String(raw.error_code) : 'quota_query_failed';
                return { provider: id, status: 'error', stale: false, code, error: 'Provider quota unavailable' };
            }
            if (id === 'claude-coding' && raw && typeof raw === 'object' && 'source' in raw && raw.source === 'claude-sources') {
                try {
                    return normalizeClaudeQuota(raw);
                }
                catch {
                    return normalizeClaudeQuota(await this.accounts.readClaudeOAuth(options));
                }
            }
            return id === 'chatgpt' ? normalizeChatGPTQuota(raw) : accountCollectors[id as AccountUsageSource](raw);
        }
        catch {
            options?.signal?.throwIfAborted();
            return { provider: id, status: 'error', stale: false, code: 'quota_query_failed', error: 'Provider quota unavailable' };
        }
    }
    async list(context?: CodeBuddyQueryContext, options?: ForgeExecutionOptions): Promise<readonly QuotaSnapshot[]> {
        // Source reads are independent; a failed login never masks other providers.
        const rows = await Promise.all(QUOTA_PROVIDER_IDS.map(id => this.fetch(id, context, options)));
        return rows.filter((row): row is QuotaSnapshot => row !== undefined);
    }
    async chatGPT(options?: ForgeExecutionOptions): Promise<QuotaSnapshot> {
        return (await this.fetch('chatgpt', undefined, options))!;
    }
    async queryJson(context?: CodeBuddyQueryContext, options?: ForgeExecutionOptions): Promise<string> {
        return JSON.stringify(await this.list(context, options));
    }
}
export { currentCodeBuddyContext } from './observed.ts';
