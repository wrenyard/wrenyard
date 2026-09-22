import { providerQuotas, type ProviderQuota, type QuotaSource } from '@wrenyard/providers';
import type { QuotaSnapshot } from '@wrenyard/providers/base';
import { createAgentClients, ClientError, type AgentClient, type ClientOptions } from '@wrenyard/clients';
import { HttpQuotaSource } from './http.ts';
import { readCodeBuddyObservation, type CodeBuddyQueryContext } from './observed.ts';
export type { CodeBuddyQueryContext } from './observed.ts';
export type QuotaQueryOptions = ClientOptions;
export interface QuotaServiceOptions {
    readonly providers?: ReadonlyMap<string, ProviderQuota>;
    readonly clients?: ReadonlyMap<string, AgentClient>;
    readonly http?: Pick<HttpQuotaSource, 'readUsage'>;
}
export const QUOTA_PROVIDER_IDS = [...providerQuotas].filter(([, quota]) => quota.read).map(([id]) => id);
/** The feature binds I/O; provider.quota owns interpretation and fallback. */
export class QuotaService {
    private readonly providers: ReadonlyMap<string, ProviderQuota>;
    private readonly clients: ReadonlyMap<string, AgentClient>;
    private readonly http: Pick<HttpQuotaSource, 'readUsage'>;
    constructor(options: QuotaServiceOptions = {}) {
        this.providers = options.providers ?? providerQuotas;
        this.clients = options.clients ?? createAgentClients();
        this.http = options.http ?? new HttpQuotaSource();
    }
    private source(provider: string, context?: CodeBuddyQueryContext, options?: QuotaQueryOptions): QuotaSource {
        const clientIds: Readonly<Record<string, string>> = {
            chatgpt: 'codex', cursor: 'cursor', 'claude-coding': 'claude', 'spacex-ai': 'grok',
        };
        return { read: async (source = 'primary') => {
                options?.signal?.throwIfAborted();
                let raw: unknown;
                if (provider === 'deepseek' || provider === 'kimi-coding' || provider === 'zhipu-coding')
                    raw = await this.http.readUsage(provider, options);
                else if (provider === 'codebuddy')
                    raw = await readCodeBuddyObservation(context, options);
                else {
                    const client = this.clients.get(clientIds[provider]);
                    if (!client?.capabilities.account || !client.readAccount)
                        throw new Error('Account capability unavailable');
                    raw = await client.readAccount({ refresh: source === 'fallback' }, options);
                }
                if (raw && typeof raw === 'object' && 'error_code' in raw)
                    throw new ClientError(String(raw.error_code));
                options?.signal?.throwIfAborted();
                return raw;
            } };
    }
    async fetch(provider: string, context?: CodeBuddyQueryContext, options?: QuotaQueryOptions): Promise<QuotaSnapshot | undefined> {
        options?.signal?.throwIfAborted();
        const id = provider === 'super-grok' ? 'spacex-ai' : provider;
        const quota = this.providers.get(id);
        if (!quota?.read)
            return { provider: id, status: 'unavailable', stale: false, code: 'quota_unsupported', message: 'Quota acquisition is not supported for this provider' };
        try {
            return await quota.read(this.source(id, context, options));
        }
        catch (error) {
            options?.signal?.throwIfAborted();
            const code = error instanceof ClientError && ['configuration_missing', 'authentication_required'].includes(error.code) ? error.code : 'quota_query_failed';
            return { provider: id === 'spacex-ai' ? 'super-grok' : id, status: 'error', stale: false, code, error: 'Provider quota unavailable' };
        }
    }
    async list(context?: CodeBuddyQueryContext, options?: QuotaQueryOptions): Promise<readonly QuotaSnapshot[]> {
        const ids = [...this.providers].filter(([, quota]) => quota.read).map(([id]) => id);
        const rows = await Promise.all(ids.map(id => this.fetch(id, context, options)));
        return rows.filter((row): row is QuotaSnapshot => row !== undefined);
    }
    async chatGPT(options?: QuotaQueryOptions): Promise<QuotaSnapshot> { return (await this.fetch('chatgpt', undefined, options))!; }
    async queryJson(context?: CodeBuddyQueryContext, options?: QuotaQueryOptions): Promise<string> { return JSON.stringify(await this.list(context, options)); }
}
export { currentCodeBuddyContext } from './observed.ts';
