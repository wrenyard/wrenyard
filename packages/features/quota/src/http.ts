import { homedir } from 'node:os';
import { BUILTIN_PROVIDERS, createBuiltinProviderRuntime, readDevinCredentials } from '@wrenyard/providers';
import type { ClientOptions } from '@wrenyard/clients';
export type HttpQuotaProvider = 'deepseek' | 'kimi-coding' | 'zhipu-coding' | 'devin' | 'openrouter';
const endpoints: Record<Exclude<HttpQuotaProvider, 'devin'>, string> = {
    deepseek: 'https://api.deepseek.com/user/balance',
    'kimi-coding': 'https://api.kimi.com/coding/v1/usages',
    'zhipu-coding': 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    openrouter: 'https://openrouter.ai/api/v1/key',
};
async function credential(provider: HttpQuotaProvider, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const home = env.HOME || env.USERPROFILE || homedir();
    const definition = BUILTIN_PROVIDERS.find(item => item.id === provider)!;
    const managed = await createBuiltinProviderRuntime({ env, home }).credential(definition);
    if (managed?.value)
        return managed.value;
    if (provider === 'kimi-coding')
        for (const key of ['KIMI_CODE_API_KEY', 'WRENYARD_KIMI_CODING_API_KEY', 'KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY']) {
            if (env[key]?.trim())
                return env[key]!.trim();
        }
    return undefined;
}
/** Direct API acquisition: no subprocess, token logging, or credential persistence. */
export class HttpQuotaSource {
    constructor(private readonly request: typeof fetch = fetch) { }
    async readUsage(provider: HttpQuotaProvider, options?: ClientOptions): Promise<unknown> {
        const devin = provider === 'devin' ? await readDevinCredentials({ env: options?.env ?? process.env }) : undefined;
        const token = provider === 'devin' ? devin?.key : await credential(provider, options?.env ?? process.env);
        if (!token)
            return { error_code: 'configuration_missing' };
        const timeout = AbortSignal.timeout(Math.min(options?.timeoutMs ?? 10000, 10000));
        const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await this.request(provider === 'devin'
            ? devin!.server + '/exa.seat_management_pb.SeatManagementService/GetUserStatus' : endpoints[provider], provider === 'devin'
            ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
                body: JSON.stringify({ metadata: { ideName: 'devin-cli', ideVersion: '3000.11.3', extensionName: 'devin-cli', extensionVersion: '3000.11.3', apiKey: token, locale: 'en', os: process.platform === 'win32' ? 'windows' : process.platform } }), redirect: 'error', signal }
            : { headers: { authorization: 'Bearer ' + token, accept: 'application/json', 'user-agent': 'wrenyard' }, redirect: 'error', signal });
        if (!response.ok) {
            await response.body?.cancel();
            return { error_code: provider === 'devin' && response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'authentication_required' : 'quota_query_failed' };
        }
        if (!response.body)
            throw new Error('Empty quota response');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.byteLength;
                if (size > 1024 * 1024) {
                    await reader.cancel();
                    throw new Error('Quota response too large');
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (provider === 'devin' && data.code) return { error_code: data.code === 'unauthenticated' || data.code === 'permission_denied' ? 'authentication_required' : data.code === 'resource_exhausted' ? 'rate_limited' : 'quota_query_failed' };
        const sourceLabel = provider === 'devin'
            ? 'devin.GetUserStatus'
            : provider === 'deepseek'
                ? 'deepseek-balance'
                : provider === 'openrouter'
                    ? 'openrouter-balance'
                    : 'api';
        return { source: sourceLabel, fetched_at: new Date().toISOString(), data };
    }
}
