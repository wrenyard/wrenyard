import { spawn } from 'node:child_process';
import type { ProviderAuthMode, ProviderAuthStatus } from './shell-contract.js';
import { canonicalProviderId } from './provider-order.js';

/**
 * Providers that accept a Runtime-managed API key stored through stdin.
 * Every other canonical provider is configured by other means.
 */
export const API_KEY_PROVIDER_IDS = new Set([
  'anthropic-api',
  'kimi-coding',
  'minimax',
  'minimax-coding',
  'moonshot',
  'openai',
  'qwen',
  'qwen-coding',
  'tokenhub',
  'volcengine',
  'zhipu',
  'zhipu-coding',
]);

const ENVIRONMENT_PROVIDER_IDS = new Set(['deepseek']);
const NATIVE_PROVIDER_IDS = new Set([
  'anthropic',
  'codebuddy',
  'codex',
  'codex-spark',
  'cursor',
  'spacex-ai',
  'super-grok',
]);

const MAX_PROVIDER_ENTRIES = 64;
const MAX_PROVIDER_ID_LENGTH = 120;
const MAX_KEY_LENGTH = 4096;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_STDOUT_CHARS = 256_000;
const MAX_STDERR_CHARS = 64_000;

export const PROVIDER_LIST_ARGS = ['providers', 'list', '--json'] as const;

export interface ProviderCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
}

export interface ProviderCommandRunner {
  run(args: readonly string[], input?: string): Promise<ProviderCommandResult>;
}

export interface ProviderServiceOptions {
  runtimeCommand: string | undefined;
  runner?: ProviderCommandRunner;
}

/**
 * Discovers the runtime's canonical providers and writes supported API keys.
 * The key is only ever sent through the child's stdin; it never appears in
 * argv, snapshots, logs or error messages produced by this service.
 */
export class ProviderService {
  private readonly runner: ProviderCommandRunner;

  constructor(private readonly options: ProviderServiceOptions) {
    this.runner = options.runner ?? new SpawnProviderCommandRunner(options.runtimeCommand);
  }

  async listProviders(): Promise<ProviderAuthStatus[]> {
    const result = await this.runner.run(PROVIDER_LIST_ARGS);
    if (result.code !== 0) {
      const detail = sanitizeProviderText(result.stderr)
        || `退出码 ${result.code ?? 'unknown'}${result.timedOut ? '（超时）' : ''}`;
      throw new Error(`无法读取 Provider 目录：${detail}`);
    }
    return parseProviderList(result.stdout);
  }

  async configureApiKey(providerId: string, key: string): Promise<void> {
    if (typeof providerId !== 'string' || !providerId || providerId.length > MAX_PROVIDER_ID_LENGTH) {
      throw new Error('Provider id 无效');
    }
    if (!API_KEY_PROVIDER_IDS.has(providerId)) {
      throw new Error(`Provider ${providerId} 不支持 API Key 配置`);
    }
    const normalized = key.trim();
    if (!normalized || normalized.length > MAX_KEY_LENGTH) {
      throw new Error('API Key 格式无效');
    }
    const result = await this.runner.run(['auth', 'set', providerId, '--key-stdin'], normalized);
    if (result.code !== 0) {
      const detail = redactSecret(sanitizeProviderText(result.stderr), normalized)
        || `退出码 ${result.code ?? 'unknown'}${result.timedOut ? '（超时）' : ''}`;
      throw new Error(`保存 API Key 失败：${detail}`);
    }
  }
}

function parseProviderList(stdout: string): ProviderAuthStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Provider 目录输出不是有效的 JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('Provider 目录输出必须是数组');
  if (parsed.length > MAX_PROVIDER_ENTRIES) throw new Error('Provider 目录条目数量超限');
  const merged = new Map<string, ProviderAuthStatus>();
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Provider 目录条目格式无效');
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > MAX_PROVIDER_ID_LENGTH) {
      throw new Error('Provider 目录条目缺少有效 id');
    }
    if (record.api_kind !== undefined && typeof record.api_kind !== 'string') {
      throw new Error('Provider 目录条目 api_kind 无效');
    }
    if (typeof record.auth_ok !== 'boolean') {
      throw new Error('Provider 目录条目 auth_ok 无效');
    }
    const canonicalId = canonicalProviderId(record.id);
    const status: ProviderAuthStatus = {
      id: canonicalId,
      configured: record.auth_ok,
      authMode: classifyAuthMode(canonicalId),
    };
    const existing = merged.get(canonicalId);
    if (!existing) {
      merged.set(canonicalId, status);
    } else {
      // Legacy/runtime-specific variants collapse into one product provider;
      // configured wins so any authenticated variant marks it configured.
      merged.set(canonicalId, { ...existing, configured: existing.configured || status.configured });
    }
  }
  return [...merged.values()];
}

function classifyAuthMode(id: string): ProviderAuthMode {
  if (API_KEY_PROVIDER_IDS.has(id)) return 'api-key';
  if (ENVIRONMENT_PROVIDER_IDS.has(id)) return 'environment';
  if (NATIVE_PROVIDER_IDS.has(id)) return 'native';
  return 'none';
}

class SpawnProviderCommandRunner implements ProviderCommandRunner {
  constructor(private readonly runtimeCommand: string | undefined) {}

  async run(args: readonly string[], input?: string): Promise<ProviderCommandResult> {
    const runtimeCommand = this.runtimeCommand;
    if (!runtimeCommand) {
      return { stdout: '', stderr: '未找到 Wrenyard runtime 可执行文件', code: 1 };
    }
    return new Promise<ProviderCommandResult>((resolve) => {
      const child = spawn(runtimeCommand, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let finished = false;

      const finish = (result: ProviderCommandResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish({ stdout, stderr, code: null, timedOut: true });
      }, COMMAND_TIMEOUT_MS);

      // A destroyed stdin after early child exit must not surface as an error.
      child.stdin.on('error', () => undefined);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_STDOUT_CHARS) {
          stdout = stdout.slice(0, MAX_STDOUT_CHARS);
          child.kill();
          finish({ stdout, stderr, code: null, timedOut: true });
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(0, MAX_STDERR_CHARS);
      });
      child.on('error', (error) => {
        finish({ stdout, stderr: error.message, code: 1 });
      });
      child.on('close', (code) => {
        finish({ stdout, stderr, code });
      });
      try {
        if (input !== undefined) child.stdin.write(input, 'utf8');
      } catch {
        // child already exited; stdin is unavailable
      }
      try {
        child.stdin.end();
      } catch {
        // child already exited; stdin is unavailable
      }
    });
  }
}

function sanitizeProviderText(value: string): string {
  const normalized = value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 219)}…`;
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, '[REDACTED]') : value;
}
