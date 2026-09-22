import { homedir } from 'node:os';
import { BUILTIN_PROVIDERS, createBuiltinProviderRuntime } from '@wrenyard/providers';
import type { ClientOptions } from '@wrenyard/clients';
export type HttpQuotaProvider = 'deepseek' | 'kimi-coding' | 'zhipu-coding';
const endpoints: Record<HttpQuotaProvider, string> = {
    deepseek: 'https://api.deepseek.com/user/balance',
    'kimi-coding': 'https://api.kimi.com/coding/v1/usages',
    'zhipu-coding': 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
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
        const token = await credential(provider, options?.env ?? process.env);
        if (!token)
            return { error_code: 'configuration_missing' };
        const timeout = AbortSignal.timeout(Math.min(options?.timeoutMs ?? 10000, 10000));
        const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await this.request(endpoints[provider], { headers: { authorization: 'Bearer ' + token, accept: 'application/json', 'user-agent': 'wrenyard' }, redirect: 'error', signal });
        if (!response.ok) {
            await response.body?.cancel();
            return { error_code: response.status === 401 || response.status === 403 ? 'authentication_required' : 'quota_query_failed' };
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
        return { source: provider === 'deepseek' ? 'deepseek-balance' : 'api', fetched_at: new Date().toISOString(), data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    }
}
