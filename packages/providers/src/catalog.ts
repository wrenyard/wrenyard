import { Catalog, type ClientDefinition, type DispatchPlan, type ModelDefinition, type ProviderDefinition } from '@wrenyard/catalog';

const clients: readonly ClientDefinition[] = [
  { id: 'claude', nativeProvider: 'anthropic', gatewayProtocols: ['anthropic_messages'] },
  { id: 'codebuddy', nativeProvider: 'codebuddy', gatewayProtocols: ['openai_chat'] },
  { id: 'codex', nativeProvider: 'codex', gatewayProtocols: ['openai_responses'] },
  { id: 'cursor', nativeProvider: 'cursor', gatewayProtocols: ['openai_chat'] },
  { id: 'dsh', gatewayProtocols: ['openai_chat'] },
  { id: 'grok', nativeProvider: 'spacex-ai', gatewayProtocols: ['openai_chat'] },
  { id: 'opencode', nativeProvider: 'opencode-native', gatewayProtocols: ['openai_chat', 'anthropic_messages'] },
];

const model = (id: string, displayName: string, contextWindow?: number, maxTokens?: number): ModelDefinition => ({
  id, displayName,
  ...(contextWindow ? { contextWindow } : {}),
  ...(maxTokens ? { maxTokens } : {}),
});

const openAI = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'openai_chat' as const, endpoint, authScheme });
const anthropic = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'anthropic_messages' as const, endpoint, authScheme });

const builtinProviders: readonly ProviderDefinition[] = [
  {
    id: 'anthropic', displayName: 'Claude Subscription', credentialResolver: 'claude',
    nativeClients: ['claude'], models: [], quotaProvider: 'anthropic', useClientBinary: true,
  },
  {
    id: 'anthropic-api', displayName: 'Anthropic API', credentialResolver: 'forge-managed',
    defaultModel: 'claude-sonnet-5',
    models: [
      { ...model('claude-fable-5', 'Claude Fable 5', 1_000_000, 131_072), family: 'claude', supports1MContext: true },
      { ...model('claude-opus-5', 'Claude Opus 5', 1_000_000, 131_072), family: 'claude', claudeTier: 'opus', supports1MContext: true },
      { ...model('claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 131_072), family: 'claude', claudeTier: 'sonnet', supports1MContext: true },
      { ...model('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200_000, 64_000), family: 'claude', claudeTier: 'haiku' },
    ],
    protocols: [anthropic('https://api.anthropic.com/v1/messages', 'x-api-key')],
  },
  {
    id: 'codebuddy', displayName: 'CodeBuddy', credentialResolver: 'codebuddy',
    nativeClients: ['codebuddy'], defaultModel: 'deepseek-v4-flash', useClientBinary: true,
    models: [
      model('deepseek-v4-flash', 'DeepSeek V4 Flash'),
      model('deepseek-v4-pro', 'DeepSeek V4 Pro'),
      model('hy4-preview-ioa', 'HY4 Preview'),
      model('kimi-k2.6', 'Kimi K2.6'),
      model('minimax-m3', 'MiniMax M3'),
      model('minimax-m2.7', 'MiniMax M2.7'),
      model('kimi-k2.7', 'Kimi K2.7 Code'),
      model('hy3-preview', 'HY3 Preview'),
    ],
    protocols: [openAI('https://copilot.tencent.com/v2/chat/completions')],
  },
  {
    id: 'codex', displayName: 'Codex Subscription', credentialResolver: 'codex',
    nativeClients: ['codex'], defaultModel: 'gpt-5.6-sol', quotaProvider: 'codex',
    models: [
      model('gpt-5.6-sol', 'GPT-5.6 Sol', 1_050_000, 131_072),
      model('gpt-5.6-terra', 'GPT-5.6 Terra', 1_050_000, 131_072),
      model('gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000, 131_072),
      model('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'),
      model('gpt-5.5', 'GPT-5.5'), model('gpt-5.4', 'GPT-5.4'), model('gpt-5.4-mini', 'GPT-5.4 Mini'),
    ],
  },
  {
    id: 'codex-spark', displayName: 'Codex Spark', credentialResolver: 'codex',
    nativeClients: ['codex'], defaultModel: 'gpt-5.3-codex-spark', quotaProvider: 'codex-spark',
    models: [{ ...model('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'), taskOnly: true }],
  },
  {
    id: 'cursor', displayName: 'Cursor', credentialResolver: 'cursor', nativeClients: ['cursor'],
    defaultModel: 'composer-2.5', quotaProvider: 'cursor', useClientBinary: true,
    models: [model('composer-2.5', 'Composer 2.5', 200_000), model('cursor-grok-4.6-high', 'Grok 4.6 High', 256_000), model('kimi-k3', 'Kimi K3', 1_048_576), model('claude-opus-5', 'Claude Opus 5', 300_000)],
  },
  {
    id: 'kimi-coding', displayName: 'Kimi Coding', credentialResolver: 'forge-managed',
    defaultModel: 'k3', quotaProvider: 'kimi-coding',
    models: [model('k3', 'Kimi K3', 1_048_576, 32_768)],
    protocols: [
      openAI('https://api.kimi.com/coding/v1/chat/completions'),
      anthropic('https://api.kimi.com/coding/v1/messages'),
    ],
  },
  {
    id: 'minimax', displayName: 'MiniMax Open Platform', credentialResolver: 'forge-managed', defaultModel: 'MiniMax-M3',
    models: [model('MiniMax-M3', 'MiniMax M3', 1_000_000, 131_072), model('MiniMax-M2.7', 'MiniMax M2.7', 204_800, 32_768), model('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 204_800, 32_768)],
    protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  },
  {
    id: 'minimax-coding', displayName: 'MiniMax Coding Plan', credentialResolver: 'forge-managed', defaultModel: 'MiniMax-M3',
    models: [model('MiniMax-M3', 'MiniMax M3', 1_000_000, 131_072), model('MiniMax-M2.7', 'MiniMax M2.7', 204_800, 32_768), model('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 204_800, 32_768)],
    protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  },
  {
    id: 'moonshot', displayName: 'Moonshot API', credentialResolver: 'forge-managed', defaultModel: 'kimi-k2.6',
    models: [model('kimi-k2.6', 'Kimi K2.6', 262_144, 32_768), model('kimi-k2.5', 'Kimi K2.5', 262_144, 32_768)],
    protocols: [openAI('https://api.moonshot.cn/v1/chat/completions')],
  },
  {
    id: 'openai', displayName: 'OpenAI API', credentialResolver: 'forge-managed', defaultModel: 'gpt-5.6-sol',
    models: [model('gpt-5.6-sol', 'GPT-5.6 Sol', 1_050_000, 131_072), model('gpt-5.6-terra', 'GPT-5.6 Terra', 1_050_000, 131_072), model('gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000, 131_072)],
    protocols: [
      openAI('https://api.openai.com/v1/chat/completions'),
      { protocol: 'openai_responses', endpoint: 'https://api.openai.com/v1/responses', authScheme: 'bearer' },
    ],
  },
  {
    id: 'opencode-native', displayName: 'OpenCode Native', credentialResolver: 'forge-managed', nativeClients: ['opencode'], models: [],
  },
  {
    id: 'qwen', displayName: 'Qwen Model Studio', credentialResolver: 'forge-managed', defaultModel: 'qwen3.7-plus',
    models: [model('qwen3.8-max', 'Qwen3.8 Max', 1_000_000, 131_072), model('qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 131_072), model('qwen3.7-flash', 'Qwen3.7 Flash', 1_000_000, 131_072), model('qwen3-coder-next', 'Qwen3 Coder Next', 262_144, 32_768)],
    protocols: [openAI('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'), anthropic('https://dashscope.aliyuncs.com/apps/anthropic/v1/messages')],
  },
  {
    id: 'qwen-coding', displayName: 'Qwen Coding Plan', credentialResolver: 'forge-managed', defaultModel: 'qwen3.7-plus',
    models: [model('qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 131_072), model('qwen3.6-plus', 'Qwen3.6 Plus', 1_000_000, 131_072), model('qwen3.5-plus', 'Qwen3.5 Plus', 1_000_000, 131_072), model('qwen3-coder-next', 'Qwen3 Coder Next', 262_144, 32_768), model('qwen3-coder-plus', 'Qwen3 Coder Plus', 1_000_000, 131_072)],
    protocols: [openAI('https://coding.dashscope.aliyuncs.com/v1/chat/completions'), anthropic('https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages')],
  },
  {
    id: 'spacex-ai', displayName: 'SpaceX AI', credentialResolver: 'grok-oauth', nativeClients: ['grok'], defaultModel: 'grok-4.5', quotaProvider: 'spacex-ai', useClientBinary: true,
    models: [model('grok-4.5', 'Grok 4.5', 2_000_000, 131_072)],
  },
  {
    id: 'tokenhub', displayName: 'Tencent Cloud TokenHub', credentialResolver: 'forge-managed', defaultModel: 'deepseek-v4-flash-202605',
    models: [model('hy4-preview', 'Hunyuan HY4 Preview', 262_144, 32_768), model('deepseek-v4-flash-202605', 'DeepSeek V4 Flash', 1_048_576, 393_216), model('deepseek-v4-pro-202606', 'DeepSeek V4 Pro', 1_048_576, 393_216), model('deepseek/deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision', 1_048_576, 393_216), model('glm-5.3', 'GLM-5.3', 1_048_576, 32_768), model('glm-5.3-flash', 'GLM-5.3 Flash', 1_048_576, 32_768), model('kimi-k2.6', 'Kimi K2.6', 262_144, 32_768), model('minimax-m2.7', 'MiniMax M2.7', 204_800, 32_768), model('qwen3.5-plus', 'Qwen3.5 Plus', 1_048_576, 32_768)],
    protocols: [openAI('https://tokenhub.tencentmaas.com/v1/chat/completions'), anthropic('https://tokenhub.tencentmaas.com/v1/messages', 'x-api-key')],
  },
  {
    id: 'volcengine', displayName: 'Volcengine Ark', credentialResolver: 'forge-managed', defaultModel: 'doubao-seed-2-0-lite-260215',
    models: [model('doubao-seed-2-0-lite-260215', 'Doubao Seed 2.0 Lite', 262_144, 32_768)],
    protocols: [openAI('https://ark.cn-beijing.volces.com/api/v3/chat/completions')],
  },
  {
    id: 'zhipu', displayName: 'Zhipu Open Platform', credentialResolver: 'forge-managed', defaultModel: 'glm-5.2',
    models: [model('glm-5.2', 'GLM-5.2', 1_048_576, 131_072), model('glm-5-turbo', 'GLM-5 Turbo', 202_752, 32_768), model('glm-4.7-flash', 'GLM-4.7 Flash', 202_752, 32_768)],
    protocols: [openAI('https://open.bigmodel.cn/api/paas/v4/chat/completions')],
  },
  {
    id: 'zhipu-coding', displayName: 'Zhipu Coding', credentialResolver: 'forge-managed', defaultModel: 'glm-5.3', quotaProvider: 'zhipu-coding',
    models: [model('glm-5.3', 'GLM-5.3', 1_048_576, 32_768), model('glm-5.3-flash', 'GLM-5.3 Flash', 1_048_576, 32_768)],
    protocols: [openAI('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'), anthropic('https://open.bigmodel.cn/api/anthropic/v1/messages')],
  },
];

const PROVIDER_PRESENTATION: Readonly<Record<string, { description: string; setupHint: string }>> = {
  anthropic: {
    description: 'Claude Code 与 Anthropic 模型服务。',
    setupHint: '请使用 Claude Code 完成登录，返回啾啾工坊后刷新状态。',
  },
  'anthropic-api': {
    description: 'Anthropic 官方开放平台 API，与 Claude Code 登录态分开配置。',
    setupHint: '输入 Anthropic API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  codebuddy: {
    description: 'CodeBuddy 提供的 DeepSeek、混元与 Kimi 模型。',
    setupHint: '请在 CodeBuddy 客户端完成登录，返回啾啾工坊后刷新状态。',
  },
  codex: {
    description: 'OpenAI Codex 编程模型与订阅额度。',
    setupHint: '请使用 Codex CLI 完成登录，返回啾啾工坊后刷新状态。',
  },
  'codex-spark': {
    description: '低延迟 Codex Spark 模型与独立额度池。',
    setupHint: 'Codex Spark 复用 Codex 登录状态；请先使用 Codex CLI 登录。',
  },
  cursor: {
    description: 'Cursor Composer 与 Grok 模型服务。',
    setupHint: '请在 Cursor Desktop 中完成登录，返回啾啾工坊后刷新状态。',
  },
  'kimi-coding': {
    description: 'Moonshot Kimi K3 编程模型与订阅额度。',
    setupHint: '输入 Kimi Coding API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  minimax: {
    description: 'MiniMax 官方按量计费 API。',
    setupHint: '输入 MiniMax 按量计费 API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  'minimax-coding': {
    description: 'MiniMax Token Plan 的订阅 Key 接入。',
    setupHint: '输入 MiniMax 订阅 Key；订阅 Key 与按量计费 API Key 不可混用。',
  },
  moonshot: {
    description: '月之暗面官方开放平台的 Kimi 模型。',
    setupHint: '输入 Kimi 开放平台 API Key；它与 Kimi Coding Key 分开保存。',
  },
  openai: {
    description: 'OpenAI 官方开放平台 API，与 Codex 登录态分开配置。',
    setupHint: '输入 OpenAI API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  'opencode-native': {
    description: 'OpenCode 原生模型服务。',
    setupHint: '请在 OpenCode 中完成配置，返回啾啾工坊后刷新状态。',
  },
  qwen: {
    description: '阿里云百炼按量计费的 Qwen 模型。',
    setupHint: '输入百炼按量计费 API Key；它与 Coding Plan Key 分开保存。',
  },
  'qwen-coding': {
    description: '阿里云百炼 Coding Plan 订阅模型。',
    setupHint: '输入 Coding Plan API Key（sk-sp-）；不要使用百炼按量计费 Key。',
  },
  'spacex-ai': {
    description: 'SpaceXAI 提供的 Grok 原生 OAuth 模型服务。',
    setupHint: '请使用 Grok 客户端完成 OAuth 登录，返回啾啾工坊后刷新状态。',
  },
  tokenhub: {
    description: '腾讯云大模型服务平台 TokenHub 的公开 API。',
    setupHint: '输入腾讯云 TokenHub API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  volcengine: {
    description: '火山引擎方舟官方模型 API。',
    setupHint: '输入火山方舟 API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  zhipu: {
    description: '智谱 BigModel 官方按量计费 API。',
    setupHint: '输入智谱开放平台 API Key；它与 GLM Coding Key 分开保存。',
  },
  'zhipu-coding': {
    description: '智谱 GLM-5.3 系列编程模型与订阅额度。',
    setupHint: '输入 GLM Coding API Key；Key 仅写入本机 Wrenyard runtime。',
  },
};

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = builtinProviders.map((provider) => ({
  ...provider,
  ...PROVIDER_PRESENTATION[provider.id],
}));

const BUILTIN_RUN_TARGETS = {
  'codex-sol': ['codex', 'codex', 'gpt-5.6-sol'],
  'codex-terra': ['codex', 'codex', 'gpt-5.6-terra'],
  'codex-luna': ['codex', 'codex', 'gpt-5.6-luna'],
  'codex-spark': ['codex', 'codex-spark', 'gpt-5.3-codex-spark'],
  'cb-hy': ['codebuddy', 'codebuddy', 'hy4-preview-ioa'],
  'cb-ds': ['codebuddy', 'codebuddy', 'deepseek-v4-pro'],
  'cb-dsf': ['codebuddy', 'codebuddy', 'deepseek-v4-flash'],
  'cb-kimi': ['codebuddy', 'codebuddy', 'kimi-k2.6'],
  'cc-kimi': ['claude', 'kimi-coding', 'k3'],
  'cc-glm': ['claude', 'zhipu-coding', 'glm-5.3'],
  'cc-glmf': ['claude', 'zhipu-coding', 'glm-5.3-flash'],
  'gk-glm': ['grok', 'zhipu-coding', 'glm-5.3'],
  'gk-glmf': ['grok', 'zhipu-coding', 'glm-5.3-flash'],
  'gk-kimi': ['grok', 'kimi-coding', 'k3'],
  'gk-grok': ['grok', 'spacex-ai', 'grok-4.5'],
  'cur-composer': ['cursor', 'cursor', 'composer-2.5'],
  'cur-grok': ['cursor', 'cursor', 'cursor-grok-4.6-high'],
  'cur-kimi': ['cursor', 'cursor', 'kimi-k3'],
  'cur-opus': ['cursor', 'cursor', 'claude-opus-5'],
} as const;

export function createBuiltinCatalog(): Catalog {
  const catalog = new Catalog();
  for (const client of clients) catalog.registerClient(client);
  for (const provider of BUILTIN_PROVIDERS) catalog.registerProvider(provider);
  return catalog;
}

export function resolveBuiltinDispatchPlans(catalog: Catalog): Readonly<Record<string, DispatchPlan>> {
  return Object.fromEntries(Object.entries(BUILTIN_RUN_TARGETS).map(([profile, [client, provider, model]]) =>
    [profile, catalog.resolveRun(client, provider, model)]));
}
