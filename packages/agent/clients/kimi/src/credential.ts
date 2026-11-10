import { BUILTIN_PROVIDERS, createBuiltinProviderRuntime } from '@wrenyard/providers';

/**
 * Environment variable that carries the Wrenyard-managed Kimi Coding API key
 * into the Kimi Code process. The key travels through the environment only;
 * the generated config.toml references it by name and the value is never
 * written to any file.
 */
export const KIMI_KEY_ENV = 'WRENYARD_KIMI_CODING_KEY';

const kimiCodingProvider = BUILTIN_PROVIDERS.find((provider) => provider.id === 'kimi-coding');

/**
 * Resolve the Wrenyard-managed Kimi Coding API key through the provider's
 * canonical managed-store credential resolver (`credentialResolver:
 * 'managed'`). An absent or malformed store yields `undefined` so the caller
 * fails the launch instead of guessing.
 */
export async function readManagedKimiCodingKey(
    env: NodeJS.ProcessEnv = process.env,
    home?: string,
): Promise<string | undefined> {
    if (kimiCodingProvider === undefined)
        return undefined;
    const runtime = createBuiltinProviderRuntime(home === undefined ? { env } : { env, home });
    const credential = await runtime.credential(kimiCodingProvider);
    return credential?.value;
}
