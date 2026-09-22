/**
 * DeepSeek environment compatibility keys, in precedence order. DeepSeek
 * inference is a managed provider whose configured key lives in auth.json, but
 * a key exported through these names by an existing setup must keep working.
 * Read-only: this resolver never writes auth.json, so a managed configure
 * always wins over a pre-existing environment key.
 */
const DEEPSEEK_ENV_API_KEYS = ['WRENYARD_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'] as const;

export function deepSeekEnvApiKey(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of DEEPSEEK_ENV_API_KEYS) {
    const value = nonEmptyString(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

