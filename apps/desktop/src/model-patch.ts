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
    ],
  },
  {
    id: 'llm-pi-ai.zhipu-coding',
    routeKey: 'zhipu-coding',
    displayName: 'Zhipu Coding',
    apiKeyEnv: 'FORGE_DSH_ZHIPU_CODING_API_KEY',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: [
      { id: 'glm-5.3', label: 'GLM 5.3', contextWindow: 1048576, maxTokens: 32768 },
      { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', contextWindow: 1048576, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.openai',
    routeKey: 'openai',
    displayName: 'OpenAI API',
    apiKeyEnv: 'FORGE_DSH_OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1050000, maxTokens: 131072 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 1050000, maxTokens: 131072 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 1050000, maxTokens: 131072 },
    ],
  },
  {
    id: 'llm-pi-ai.zhipu',
    routeKey: 'zhipu',
    displayName: 'Zhipu Open Platform',
    apiKeyEnv: 'FORGE_DSH_ZHIPU_API_KEY',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5.2', label: 'GLM-5.2', contextWindow: 1048576, maxTokens: 131072 },
      { id: 'glm-5-turbo', label: 'GLM-5 Turbo', contextWindow: 202752, maxTokens: 32768 },
      { id: 'glm-4.7-flash', label: 'GLM-4.7 Flash', contextWindow: 202752, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.moonshot',
    routeKey: 'moonshot',
    displayName: 'Moonshot API',
    apiKeyEnv: 'FORGE_DSH_MOONSHOT_API_KEY',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 262144, maxTokens: 32768 },
      { id: 'kimi-k2.5', label: 'Kimi K2.5', contextWindow: 262144, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.minimax',
    routeKey: 'minimax',
    displayName: 'MiniMax Open Platform',
    apiKeyEnv: 'FORGE_DSH_MINIMAX_API_KEY',
    baseURL: 'https://api.minimaxi.com/v1',
    models: [
      { id: 'MiniMax-M3', label: 'MiniMax M3', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', contextWindow: 204800, maxTokens: 32768 },
      { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', contextWindow: 204800, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.minimax-coding',
    routeKey: 'minimax-coding',
    displayName: 'MiniMax Coding Plan',
    apiKeyEnv: 'FORGE_DSH_MINIMAX_CODING_API_KEY',
    baseURL: 'https://api.minimaxi.com/v1',
    models: [
      { id: 'MiniMax-M3', label: 'MiniMax M3', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', contextWindow: 204800, maxTokens: 32768 },
      { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', contextWindow: 204800, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.qwen',
    routeKey: 'qwen',
    displayName: 'Qwen Model Studio',
    apiKeyEnv: 'FORGE_DSH_QWEN_API_KEY',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'qwen3.7-flash', label: 'Qwen3.7 Flash', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'qwen3-coder-next', label: 'Qwen3 Coder Next', contextWindow: 262144, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.qwen-coding',
    routeKey: 'qwen-coding',
    displayName: 'Qwen Coding Plan',
    apiKeyEnv: 'FORGE_DSH_QWEN_CODING_API_KEY',
    baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
    models: [
      { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'qwen3.6-plus', label: 'Qwen3.6 Plus', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'qwen3-coder-next', label: 'Qwen3 Coder Next', contextWindow: 262144, maxTokens: 32768 },
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', contextWindow: 1000000, maxTokens: 131072 },
    ],
  },
  {
    id: 'llm-pi-ai.tokenhub',
    routeKey: 'tokenhub',
    displayName: 'Tencent Cloud TokenHub',
    apiKeyEnv: 'FORGE_DSH_TOKENHUB_API_KEY',
    baseURL: 'https://tokenhub.tencentmaas.com/v1',
    models: [
      { id: 'hy4-preview', label: 'Hunyuan HY4 Preview', contextWindow: 262144, maxTokens: 32768 },
      { id: 'deepseek-v4-flash-202605', label: 'DeepSeek V4 Flash', contextWindow: 1048576, maxTokens: 393216 },
      { id: 'deepseek-v4-pro-202606', label: 'DeepSeek V4 Pro', contextWindow: 1048576, maxTokens: 393216 },
      { id: 'deepseek/deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision', contextWindow: 1048576, maxTokens: 393216 },
      { id: 'glm-5.3', label: 'GLM-5.3', contextWindow: 1048576, maxTokens: 32768 },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', contextWindow: 1048576, maxTokens: 32768 },
      { id: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 262144, maxTokens: 32768 },
      { id: 'minimax-m2.7', label: 'MiniMax M2.7', contextWindow: 204800, maxTokens: 32768 },
      { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus', contextWindow: 1048576, maxTokens: 32768 },
    ],
  },
  {
    id: 'llm-pi-ai.volcengine',
    routeKey: 'volcengine',
    displayName: 'Volcengine Ark',
    apiKeyEnv: 'FORGE_DSH_VOLCENGINE_API_KEY',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      { id: 'doubao-seed-2-0-lite-260215', label: 'Doubao Seed 2.0 Lite', contextWindow: 262144, maxTokens: 32768 },
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
 * Missing or unreadable auth.json yields an empty map; the corresponding
 * routes remain absent from Desktop's configured model picker.
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

/** DSH provider id of the native DeepSeek route, mapped to its product id. */
const NATIVE_DEEPSEEK_PROVIDER = 'deepseek-official';

/** Product provider id for the native DeepSeek route. */
export const DEEPSEEK_PROVIDER_ID = 'deepseek';

/**
 * Canonical product provider ids whose credentials are actually routable by the
 * DSH child: injected routes only when their `apiKeyEnv` value is present in
 * the resolved injected credential env, native DeepSeek only when the
 * inherited `DEEPSEEK_API_KEY` is non-empty. Pure helper; values are never
 * returned or logged.
 */
export function configuredModelProviderIds(
  injectedEnv: NodeJS.ProcessEnv = {},
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const ids: string[] = [];
  for (const provider of INJECTED_PROVIDERS) {
    const value = injectedEnv[provider.apiKeyEnv];
    if (typeof value === 'string' && value.trim() !== '') ids.push(provider.routeKey);
  }
  const native = env.DEEPSEEK_API_KEY;
  if (typeof native === 'string' && native.trim() !== '') ids.push(DEEPSEEK_PROVIDER_ID);
  return ids;
}

/** Map a DSH provider id to its canonical product provider id. */
export function canonicalProviderId(provider: string): string {
  return provider === NATIVE_DEEPSEEK_PROVIDER ? DEEPSEEK_PROVIDER_ID : provider;
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
