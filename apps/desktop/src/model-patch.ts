import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Same filename fdsh writes into DSH_HOME; Desktop reuses it as the last --patch layer. */
export const MODEL_PATCH_FILENAME = 'forge-model-patch.yaml';

/** Matches @wrenyard/dsh-shell and the control-plane default MCP HTTP/SSE endpoint. */
export const DEFAULT_WRENYARD_MCP_URL = 'http://127.0.0.1:8787/mcp';

export interface InjectedModel {
  id: string;
  label: string;
  contextWindow: number;
  maxTokens: number;
}

export interface InjectedProvider {
  /** Full llm-pi-ai provider id, e.g. llm-pi-ai.kimi-coding. */
  id: string;
  /** Overlay dict key / auth.json key, e.g. kimi-coding. */
  routeKey: string;
  displayName: string;
  apiKeyEnv: string;
  baseURL: string;
  models: readonly InjectedModel[];
}

/**
 * Public DSH llm-pi-ai catalog mirrored from runtime/forge/internal/dsh.
 * Complements (never replaces) native deepseek-official routes. Missing
 * credentials keep routes visible; values only enter the DSH child env.
 */
export const INJECTED_PROVIDERS: readonly InjectedProvider[] = [
  {
    id: 'llm-pi-ai.kimi-coding',
    routeKey: 'kimi-coding',
    displayName: 'Kimi Coding',
    apiKeyEnv: 'FORGE_DSH_KIMI_CODING_API_KEY',
    baseURL: 'https://api.kimi.com/coding/v1',
    models: [
      { id: 'k3', label: 'Kimi K3', contextWindow: 1048576, maxTokens: 32768 },
      { id: 'k3[1m]', label: 'Kimi K3 1M Context', contextWindow: 1048576, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.zhipu-coding',
    routeKey: 'zhipu-coding',
    displayName: 'Zhipu Coding',
    apiKeyEnv: 'FORGE_DSH_ZHIPU_CODING_API_KEY',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3', contextWindow: 1048576, maxTokens: 32768 },
    ],
  },
];

const YAML_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._@/\-]*$/;

function yamlStr(value: string): string {
  return YAML_PLAIN.test(value) ? value : JSON.stringify(value);
}

/** Secret-free DSH loader overlay. Identical shape to fdsh's forge-model-patch.yaml. */
export function renderModelPatch(
  providers: readonly InjectedProvider[] = INJECTED_PROVIDERS,
): string {
  const lines = [
    '# forge dsh patch (generated; secret-free)',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
  ];
  for (const provider of providers) {
    lines.push(`      ${yamlStr(provider.routeKey)}:`);
    lines.push(`        displayName: ${yamlStr(provider.displayName)}`);
    lines.push('        api: openai-completions');
    lines.push(`        apiKeyEnv: ${yamlStr(provider.apiKeyEnv)}`);
    lines.push(`        baseURL: ${yamlStr(provider.baseURL)}`);
    lines.push('        models:');
    for (const model of provider.models) {
      lines.push(`          - id: ${yamlStr(model.id)}`);
      if (model.label.trim() !== '') {
        lines.push(`            name: ${yamlStr(model.label)}`);
      }
      if (model.contextWindow > 0) {
        lines.push(`            contextWindow: ${model.contextWindow}`);
      }
      if (model.maxTokens > 0) {
        lines.push(`            maxTokens: ${model.maxTokens}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function runtimeDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const dataHome = configured && configured.length > 0 ? configured : join(home, '.local', 'share');
  return join(dataHome, 'wrenyard', 'runtime');
}

export function runtimeAuthPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(runtimeDataDir(env, home), 'auth.json');
}

interface AuthEntry {
  type?: string;
  key?: string;
}

/**
 * Resolve launch-time credential env for injected providers.
 * Missing or unreadable auth.json yields an empty map; routes stay visible.
 * Values are never logged.
 */
export async function resolveModelCredentialEnv(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  readFile: (path: string, encoding: 'utf8') => Promise<string> = (path, encoding) => fs.readFile(path, encoding),
): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  let raw: string;
  try {
    raw = await readFile(runtimeAuthPath(env, home), 'utf8');
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const entries = parsed as Record<string, AuthEntry>;
  for (const provider of INJECTED_PROVIDERS) {
    const token = entries[provider.routeKey]?.key;
    if (typeof token === 'string' && token.trim() !== '') {
      out[provider.apiKeyEnv] = token.trim();
    }
  }
  return out;
}

export async function writeModelPatch(
  dshHome: string,
  content: string = renderModelPatch(),
): Promise<string> {
  await fs.mkdir(dshHome, { recursive: true });
  const target = join(dshHome, MODEL_PATCH_FILENAME);
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, target);
  return target;
}

export function defaultMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.WRENYARD_MCP_URL ?? env.FOREMAN_MCP_URL ?? DEFAULT_WRENYARD_MCP_URL;
}
