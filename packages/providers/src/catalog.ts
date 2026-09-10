import { Catalog, type CanonicalModelDefinition, type ClientDefinition, type DispatchPlan, type IntelligenceEvidence, type IntelligenceTier, type ModelCapability, type ModelDefinition, type ModelPricing, type ModelSpeedMeta, type ProviderDefinition, type ReasoningEffort } from '@wrenyard/catalog';

const SRC_DEEPSEEK = 'https://api-docs.deepseek.com/quick_start/pricing/';
const SRC_TENCENT_HY = 'https://intl.cloud.tencent.com/zh/document/product/1300/78937';
const SRC_TENCENT_TOKENHUB = 'https://cloud.tencent.com/document/product/1823/130055';
const SRC_TENCENT_DS_IDMAP = 'https://cloud.tencent.com/document/product/1823/132248';
const SRC_OPENAI = 'https://developers.openai.com';
const SRC_OPENAI_SPARK = 'https://www.openai.com/index/introducing-gpt-5-3-codex-spark/';
const SRC_AA_DEEPSEEK = 'https://artificialanalysis.ai/models/deepseek-v4-flash/';
const SRC_AA_DEEPSEEK_PRO = 'https://artificialanalysis.ai/models/deepseek-v4-pro/';
const SRC_KIMI = 'https://www.kimi.com/en/blog/kimi-k3';
const SRC_AA_KIMI = 'https://artificialanalysis.ai/models/kimi-k3/';
const SRC_ZAI = 'https://docs.z.ai/guides/overview/pricing';
const SRC_AA_GLMF = 'https://artificialanalysis.ai/models/glm-5-3-flash/';
const SRC_AA_LUNA = 'https://artificialanalysis.ai/models/gpt-5-6-luna-xhigh/';
const SRC_AA_SOL = 'https://artificialanalysis.ai/models/gpt-5-6-sol-xhigh/';
const DEFAULT_CHECKED_AT = '2026-09-05';
const SPEED_CHECKED_AT = '2026-09-09';
const INTEL_CHECKED_AT = '2026-09-09';
const SRC_AA_HY3 = 'https://artificialanalysis.ai/models/hy3/';
const SRC_AA_MINIMAX_M27 = 'https://artificialanalysis.ai/models/minimax-m2-7/';
const SRC_AA_MINIMAX_M3 = 'https://artificialanalysis.ai/models/minimax-m3/';
const SRC_AA_GROK46 = 'https://artificialanalysis.ai/models/grok-4-6-high/';
const SRC_AA_TERRA = 'https://artificialanalysis.ai/models/gpt-5-6-terra-xhigh/';
const SRC_AA_ASTRA = 'https://artificialanalysis.ai/models/gpt-6-astra-xhigh/';
const SRC_AA_QCN = 'https://artificialanalysis.ai/models/qwen3-coder-next/';
const SRC_AA_Q37 = 'https://artificialanalysis.ai/models/qwen3-7-plus/';
const SRC_AA_Q38 = 'https://artificialanalysis.ai/models/qwen3-8-max/';
const SRC_AA_GLM = 'https://artificialanalysis.ai/models/glm-5-3/';
const SRC_AA_FABLE = 'https://artificialanalysis.ai/models/claude-fable-5/';
const SRC_AA_OPUS = 'https://artificialanalysis.ai/models/claude-opus-5-xhigh/';
const SRC_AA_HAIKU = 'https://artificialanalysis.ai/models/claude-4-5-haiku/';
const SRC_AA_GLM47 = 'https://artificialanalysis.ai/models/glm-4-7-flash/';
const SRC_AA_GLM5 = 'https://artificialanalysis.ai/models/glm-5-turbo/';
const SRC_AA_GLM52 = 'https://artificialanalysis.ai/models/glm-5-2/';
const SRC_AA_GPT54 = 'https://artificialanalysis.ai/models/gpt-5-4/';
const SRC_AA_KIMI25 = 'https://artificialanalysis.ai/models/kimi-k2-5/providers';
const SRC_AA_KIMI26 = 'https://artificialanalysis.ai/models/kimi-k2-6/';
const SRC_AA_Q36 = 'https://artificialanalysis.ai/models/qwen3-6-plus/';

const clients: readonly ClientDefinition[] = [
  { id: 'claude', nativeProvider: 'anthropic', gatewayProtocols: ['anthropic_messages'], taskCapable: true },
  { id: 'codebuddy', nativeProvider: 'codebuddy', gatewayProtocols: ['openai_chat'], taskCapable: true },
  { id: 'codex', nativeProvider: 'codex', gatewayProtocols: ['openai_responses'], taskCapable: true },
  { id: 'cursor', nativeProvider: 'cursor', gatewayProtocols: ['openai_chat'], taskCapable: true },
  { id: 'dsh', gatewayProtocols: ['openai_chat'] },
  {
    id: 'grok',
    nativeProvider: 'spacex-ai',
    gatewayProtocols: ['openai_chat'],
    unsupportedGatewayProviders: ['codebuddy'],
    taskCapable: true,
  },
  { id: 'opencode', nativeProvider: 'opencode-native', gatewayProtocols: ['openai_chat', 'anthropic_messages'], taskCapable: true },
];

/**
 * Shared provider-level gateway boundary for built-in clients. Protocol
 * compatibility is evaluated separately; this helper carries only known
 * execution restrictions that protocol metadata cannot express.
 */
export function isBuiltinClientGatewayProviderSupported(clientID: string, providerID: string): boolean {
  const client = clients.find((candidate) => candidate.id === clientID);
  return client !== undefined && !client.unsupportedGatewayProviders?.includes(providerID);
}

type RawModelDefinition = Omit<ModelDefinition, 'speed'> & { speed?: ModelSpeedMeta };
type RawProviderDefinition = Omit<ProviderDefinition, 'models'> & { models: readonly RawModelDefinition[] };

// Shared identities are deliberately opt-in. Each entry represents an exact,
// evidence-backed model version exposed through more than one provider route;
// an unlisted route remains provider-local even when its raw id happens to
// match another provider's id. This registry is the single canonical label
// source for model-only statistics.
const CANONICAL_MODELS = {
  'claude-opus-5': { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
  'glm-5.3': { id: 'glm-5.3', displayName: 'GLM-5.3' },
  'glm-5.3-flash': { id: 'glm-5.3-flash', displayName: 'GLM-5.3 Flash' },
  'gpt-5.3-codex-spark': { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark' },
  'gpt-5.6-luna': { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
  'gpt-5.6-sol': { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  'gpt-5.6-terra': { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
  'hunyuan-hy4-preview': { id: 'hunyuan-hy4-preview', displayName: 'Hunyuan HY4 Preview' },
  'kimi-k2.6': { id: 'kimi-k2.6', displayName: 'Kimi K2.6' },
  'kimi-k3': { id: 'kimi-k3', displayName: 'Kimi K3' },
  'minimax-m2.7': { id: 'minimax-m2.7', displayName: 'MiniMax M2.7' },
  'minimax-m2.7-highspeed': { id: 'minimax-m2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed' },
  'minimax-m3': { id: 'minimax-m3', displayName: 'MiniMax M3' },
  'qwen3-coder-next': { id: 'qwen3-coder-next', displayName: 'Qwen3 Coder Next' },
  'qwen3.5-plus': { id: 'qwen3.5-plus', displayName: 'Qwen3.5 Plus' },
  'qwen3.7-plus': { id: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus' },
} as const satisfies Readonly<Record<string, CanonicalModelDefinition>>;

const model = (
  id: string,
  displayName: string,
  contextWindow?: number,
  maxTokens?: number,
  canonicalModel?: CanonicalModelDefinition,
): RawModelDefinition => ({
  id, displayName,
  ...(contextWindow ? { contextWindow } : {}),
  ...(maxTokens ? { maxTokens } : {}),
  ...(canonicalModel ? { canonicalModel } : {}),
});

const openAI = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'openai_chat' as const, endpoint, authScheme });
const anthropic = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'anthropic_messages' as const, endpoint, authScheme });

const builtinProviders: readonly RawProviderDefinition[] = [
  {
    id: 'anthropic', displayName: 'Claude Subscription', credentialResolver: 'claude',
    nativeClients: ['claude'], models: [], quotaProvider: 'anthropic', useClientBinary: true,
  },
  {
    id: 'anthropic-api', displayName: 'Anthropic API', credentialResolver: 'forge-managed',
    defaultModel: 'claude-sonnet-5',
    models: [
      { ...model('claude-fable-5', 'Claude Fable 5', 1_000_000, 131_072), family: 'claude', supports1MContext: true },
      { ...model('claude-opus-5', 'Claude Opus 5', 1_000_000, 131_072, CANONICAL_MODELS['claude-opus-5']), family: 'claude', claudeTier: 'opus', supports1MContext: true },
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
      model('hy4-preview', 'HY4 Preview', undefined, undefined, CANONICAL_MODELS['hunyuan-hy4-preview']),
      model('hy3', 'HY3'),
      model('minimax-m3', 'MiniMax M3', undefined, undefined, CANONICAL_MODELS['minimax-m3']),
      model('kimi-k3', 'Kimi K3', undefined, undefined, CANONICAL_MODELS['kimi-k3']),
      model('glm-5.3', 'GLM-5.3', undefined, undefined, CANONICAL_MODELS['glm-5.3']),
      model('glm-5.3-flash', 'GLM-5.3 Flash', undefined, undefined, CANONICAL_MODELS['glm-5.3-flash']),
    ],
    modelAliases: { 'hy4-preview-ioa': 'hy4-preview' },
    protocols: [openAI('https://copilot.tencent.com/v2/chat/completions')],
  },
  {
    id: 'codex', displayName: 'Codex Subscription', credentialResolver: 'codex',
    nativeClients: ['codex'], defaultModel: 'gpt-5.6-sol', quotaProvider: 'codex',
    models: [
      model('gpt-5.6-sol', 'GPT-5.6 Sol', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-sol']),
      model('gpt-5.6-terra', 'GPT-5.6 Terra', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-terra']),
      model('gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-luna']),
      model('gpt-6-astra', 'GPT-6 Astra', 1_050_000, 128_000),
      model('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', undefined, undefined, CANONICAL_MODELS['gpt-5.3-codex-spark']),
      model('gpt-5.5', 'GPT-5.5'), model('gpt-5.4', 'GPT-5.4'), model('gpt-5.4-mini', 'GPT-5.4 Mini'),
    ],
    modelAliases: { 'codex-astra': 'gpt-6-astra' },
  },
  {
    id: 'codex-spark', displayName: 'Codex Spark', credentialResolver: 'codex',
    nativeClients: ['codex'], defaultModel: 'gpt-5.3-codex-spark', quotaProvider: 'codex-spark',
    models: [{ ...model('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', undefined, undefined, CANONICAL_MODELS['gpt-5.3-codex-spark']), taskOnly: true }],
  },
  {
    id: 'cursor', displayName: 'Cursor', credentialResolver: 'cursor', nativeClients: ['cursor'],
    defaultModel: 'composer-2.5', quotaProvider: 'cursor', useClientBinary: true,
    models: [model('composer-2.5', 'Composer 2.5', 200_000), model('cursor-grok-4.6-high', 'Grok 4.6 High', 256_000), model('kimi-k3', 'Kimi K3', 1_048_576, undefined, CANONICAL_MODELS['kimi-k3']), model('claude-opus-5', 'Claude Opus 5', 300_000, undefined, CANONICAL_MODELS['claude-opus-5'])],
  },
  {
    id: 'kimi-coding', displayName: 'Kimi Coding', credentialResolver: 'forge-managed',
    defaultModel: 'k3', quotaProvider: 'kimi-coding',
    models: [model('k3', 'Kimi K3', 1_048_576, 32_768, CANONICAL_MODELS['kimi-k3'])],
    protocols: [
      openAI('https://api.kimi.com/coding/v1/chat/completions'),
      anthropic('https://api.kimi.com/coding/v1/messages'),
    ],
  },
  {
    id: 'minimax', displayName: 'MiniMax Open Platform', credentialResolver: 'forge-managed', defaultModel: 'MiniMax-M3',
    models: [model('MiniMax-M3', 'MiniMax M3', 1_000_000, 131_072, CANONICAL_MODELS['minimax-m3']), model('MiniMax-M2.7', 'MiniMax M2.7', 204_800, 32_768, CANONICAL_MODELS['minimax-m2.7']), model('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 204_800, 32_768, CANONICAL_MODELS['minimax-m2.7-highspeed'])],
    protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  },
  {
    id: 'minimax-coding', displayName: 'MiniMax Coding Plan', credentialResolver: 'forge-managed', defaultModel: 'MiniMax-M3',
    models: [model('MiniMax-M3', 'MiniMax M3', 1_000_000, 131_072, CANONICAL_MODELS['minimax-m3']), model('MiniMax-M2.7', 'MiniMax M2.7', 204_800, 32_768, CANONICAL_MODELS['minimax-m2.7']), model('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 204_800, 32_768, CANONICAL_MODELS['minimax-m2.7-highspeed'])],
    protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  },
  {
    id: 'moonshot', displayName: 'Moonshot API', credentialResolver: 'forge-managed', defaultModel: 'kimi-k2.6',
    models: [model('kimi-k2.6', 'Kimi K2.6', 262_144, 32_768, CANONICAL_MODELS['kimi-k2.6']), model('kimi-k2.5', 'Kimi K2.5', 262_144, 32_768)],
    protocols: [openAI('https://api.moonshot.cn/v1/chat/completions')],
  },
  {
    id: 'openai', displayName: 'OpenAI API', credentialResolver: 'forge-managed', defaultModel: 'gpt-5.6-sol',
    models: [model('gpt-5.6-sol', 'GPT-5.6 Sol', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-sol']), model('gpt-5.6-terra', 'GPT-5.6 Terra', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-terra']), model('gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-luna'])],
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
    models: [model('qwen3.8-max', 'Qwen3.8 Max', 1_000_000, 131_072), model('qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 131_072, CANONICAL_MODELS['qwen3.7-plus']), model('qwen3.7-flash', 'Qwen3.7 Flash', 1_000_000, 131_072), model('qwen3-coder-next', 'Qwen3 Coder Next', 262_144, 32_768, CANONICAL_MODELS['qwen3-coder-next'])],
    protocols: [openAI('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'), anthropic('https://dashscope.aliyuncs.com/apps/anthropic/v1/messages')],
  },
  {
    id: 'qwen-coding', displayName: 'Qwen Coding Plan', credentialResolver: 'forge-managed', defaultModel: 'qwen3.7-plus',
    models: [model('qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 131_072, CANONICAL_MODELS['qwen3.7-plus']), model('qwen3.6-plus', 'Qwen3.6 Plus', 1_000_000, 131_072), model('qwen3.5-plus', 'Qwen3.5 Plus', 1_000_000, 131_072, CANONICAL_MODELS['qwen3.5-plus']), model('qwen3-coder-next', 'Qwen3 Coder Next', 262_144, 32_768, CANONICAL_MODELS['qwen3-coder-next']), model('qwen3-coder-plus', 'Qwen3 Coder Plus', 1_000_000, 131_072)],
    protocols: [openAI('https://coding.dashscope.aliyuncs.com/v1/chat/completions'), anthropic('https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages')],
  },
  {
    id: 'spacex-ai', displayName: 'SpaceX AI', credentialResolver: 'grok-oauth', nativeClients: ['grok'], defaultModel: 'grok-4.5', quotaProvider: 'spacex-ai', useClientBinary: true,
    models: [model('grok-4.5', 'Grok 4.5', 2_000_000, 131_072)],
  },
  {
    id: 'tokenhub', displayName: 'Tencent Cloud TokenHub', credentialResolver: 'forge-managed', defaultModel: 'deepseek-v4-flash-202605',
    models: [model('hy4-preview', 'Hunyuan HY4 Preview', 262_144, 32_768, CANONICAL_MODELS['hunyuan-hy4-preview']), model('deepseek-v4-flash-202605', 'DeepSeek V4 Flash', 1_048_576, 393_216), model('deepseek-v4-pro-202606', 'DeepSeek V4 Pro', 1_048_576, 393_216), model('deepseek/deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision', 1_048_576, 393_216), model('glm-5.3', 'GLM-5.3', 1_048_576, 32_768, CANONICAL_MODELS['glm-5.3']), model('glm-5.3-flash', 'GLM-5.3 Flash', 1_048_576, 32_768, CANONICAL_MODELS['glm-5.3-flash']), model('kimi-k2.6', 'Kimi K2.6', 262_144, 32_768, CANONICAL_MODELS['kimi-k2.6']), model('minimax-m2.7', 'MiniMax M2.7', 204_800, 32_768, CANONICAL_MODELS['minimax-m2.7']), model('qwen3.5-plus', 'Qwen3.5 Plus', 1_048_576, 32_768, CANONICAL_MODELS['qwen3.5-plus'])],
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
    models: [model('glm-5.3', 'GLM-5.3', 1_048_576, 32_768, CANONICAL_MODELS['glm-5.3']), model('glm-5.3-flash', 'GLM-5.3 Flash', 1_048_576, 32_768, CANONICAL_MODELS['glm-5.3-flash'])],
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

function speedDefault(
  tps: number,
  source: string,
  basis: string,
  conservative = false,
): ModelSpeedMeta {
  return {
    tps,
    source,
    checkedAt: SPEED_CHECKED_AT,
    basis,
    ...(conservative ? { conservative: true } : {}),
  };
}

// External/public throughput is a catalog baseline only. A valid exact-profile
// local agent_turn_v1 sample supersedes it, as does an exact provider override.
// Keys are exact registered model ids; aliases are never used for lookup.
const MODEL_SPEED_DEFAULTS: Readonly<Record<string, ModelSpeedMeta>> = {
  'MiniMax-M2.7': speedDefault(60, 'https://platform.minimaxi.com/docs/api-reference/api-overview', 'MiniMax official documented output speed for exact MiniMax-M2.7.'),
  'MiniMax-M2.7-highspeed': speedDefault(100, 'https://platform.minimaxi.com/docs/api-reference/api-overview', 'MiniMax official documented output speed for exact MiniMax-M2.7-highspeed.'),
  'MiniMax-M3': speedDefault(155.5, 'https://artificialanalysis.ai/models/minimax-m3/', 'Artificial Analysis median output speed for MiniMax M3; exact registered case-preserving API id.'),
  'claude-fable-5': speedDefault(63.3, 'https://artificialanalysis.ai/models/claude-fable-5/', 'Artificial Analysis output-speed measurement for Claude Fable 5.'),
  'claude-haiku-4-5-20251001': speedDefault(80.6, 'https://artificialanalysis.ai/models/claude-4-5-haiku/', 'Artificial Analysis output-speed measurement for Claude Haiku 4.5; registered id is the dated Anthropic API id.'),
  'claude-opus-5': speedDefault(50, 'https://artificialanalysis.ai/models/claude-opus-5-xhigh/', 'Artificial Analysis output-speed baseline for Claude Opus 5 xhigh.'),
  'claude-sonnet-5': speedDefault(60, 'https://artificialanalysis.ai/models/claude-sonnet-5-non-reasoning/', 'Artificial Analysis output-speed baseline for Claude Sonnet 5 non-reasoning.'),
  'composer-2.5': speedDefault(40, 'user-specified', 'User-selected Wrenyard baseline for exact standard cursor/composer-2.5; no measured source and not composer-2.5-fast.'),
  'cursor-grok-4.6-high': speedDefault(58.5, 'https://artificialanalysis.ai/models/releases/grok-4-6', 'Artificial Analysis output-speed measurement for the same Grok 4.6 high model and effort exposed by Cursor.'),
  'deepseek-v4-flash': speedDefault(125.7, SRC_AA_DEEPSEEK, 'Artificial Analysis output-speed measurement for DeepSeek V4 Flash.'),
  'deepseek-v4-flash-202605': speedDefault(125.7, SRC_AA_DEEPSEEK, `Artificial Analysis DeepSeek V4 Flash output speed; Tencent documents exact 202605 id mapping at ${SRC_TENCENT_DS_IDMAP}.`),
  'deepseek-v4-pro': speedDefault(76.9, SRC_AA_DEEPSEEK_PRO, 'Artificial Analysis output-speed measurement for DeepSeek V4 Pro.'),
  'deepseek-v4-pro-202606': speedDefault(76.9, SRC_AA_DEEPSEEK_PRO, `Artificial Analysis DeepSeek V4 Pro output speed; Tencent documents exact 202606 id mapping at ${SRC_TENCENT_DS_IDMAP}.`),
  'deepseek/deepseek-v4-flash-vision-exp': speedDefault(120.1, 'https://artificialanalysis.ai/models/deepseek-v4-flash-vision/', `Artificial Analysis output-speed measurement for DeepSeek V4 Flash Vision; Tencent documents the exact registered id at ${SRC_TENCENT_DS_IDMAP}.`),
  'doubao-seed-2-0-lite-260215': speedDefault(35.1, 'https://aihubmix.com/compare/doubao-seed-2-0-lite-260215/qwen3.8-max-preview', 'AIHubMix public rolling output-throughput measurement for the exact dated Doubao model.'),
  'glm-4.7-flash': speedDefault(102.5, 'https://artificialanalysis.ai/models/glm-4-7-flash/', 'Artificial Analysis output-speed measurement for GLM-4.7 Flash.'),
  'glm-5-turbo': speedDefault(42, 'https://openrouter.ai/z-ai/glm-5-turbo/pricing', 'OpenRouter public output-throughput snapshot for exact GLM-5 Turbo.'),
  'glm-5.2': speedDefault(62.8, 'https://artificialanalysis.ai/models/glm-5-2/', 'Artificial Analysis output-speed measurement for GLM-5.2.'),
  'glm-5.3': speedDefault(63.7, 'https://artificialanalysis.ai/models/glm-5-3/', 'Artificial Analysis output-speed measurement for GLM-5.3.'),
  'glm-5.3-flash': speedDefault(73.1, SRC_AA_GLMF, 'Artificial Analysis output-speed measurement for GLM-5.3 Flash.'),
  'gpt-5.3-codex-spark': speedDefault(1000, SRC_OPENAI_SPARK, 'OpenAI reports more than 1000 tokens/s on Cerebras; 1000 is the conservative catalog lower bound.', true),
  'gpt-5.4': speedDefault(139.6, 'https://artificialanalysis.ai/models/gpt-5-4/', 'Artificial Analysis output-speed measurement for GPT-5.4.'),
  'gpt-5.4-mini': speedDefault(218.5, 'https://artificialanalysis.ai/models/gpt-5-4-mini/', 'Artificial Analysis output-speed measurement for GPT-5.4 Mini.'),
  'gpt-5.5': speedDefault(88.9, 'https://artificialanalysis.ai/models/gpt-5-5/', 'Artificial Analysis output-speed measurement for GPT-5.5.'),
  'gpt-5.6-luna': speedDefault(107, SRC_AA_LUNA, 'Artificial Analysis output-speed measurement for GPT-5.6 Luna xhigh, matching the registered effort.'),
  'gpt-5.6-sol': speedDefault(63.2, SRC_AA_SOL, 'Artificial Analysis output-speed measurement for GPT-5.6 Sol xhigh, matching the registered effort.'),
  'gpt-5.6-terra': speedDefault(98.4, 'https://artificialanalysis.ai/models/gpt-5-6-terra-xhigh/', 'Artificial Analysis output-speed measurement for GPT-5.6 Terra xhigh, matching the registered effort.'),
  'gpt-6-astra': speedDefault(50.6, 'https://artificialanalysis.ai/models/gpt-6-astra-xhigh/', 'Artificial Analysis output-speed measurement for GPT-6 Astra xhigh, matching the registered effort.'),
  'grok-4.5': speedDefault(57.5, 'https://artificialanalysis.ai/models/grok-4-5/', 'Artificial Analysis output-speed measurement for Grok 4.5.'),
  hy3: speedDefault(93.8, 'https://artificialanalysis.ai/models/hy3/', 'Artificial Analysis output-speed measurement for Tencent Hunyuan HY3.'),
  'hy4-preview': speedDefault(38, 'https://openrouter.ai/tencent/hy4-preview', 'OpenRouter public provider throughput for exact Tencent HY4 Preview.'),
  k3: speedDefault(39.7, SRC_AA_KIMI, 'Artificial Analysis Kimi K3 output speed; k3 is the exact registered Kimi Coding route id for that documented model.'),
  'kimi-k2.5': speedDefault(39.9, 'https://artificialanalysis.ai/models/kimi-k2-5/providers', 'Artificial Analysis minimum current provider output speed for Kimi K2.5; retained for the registered decommissioned model.'),
  'kimi-k2.6': speedDefault(56.3, 'https://artificialanalysis.ai/models/kimi-k2-6/', 'Artificial Analysis output-speed measurement for Kimi K2.6.'),
  'kimi-k3': speedDefault(39.7, SRC_AA_KIMI, 'Artificial Analysis output-speed measurement for Kimi K3.'),
  'minimax-m2.7': speedDefault(71.3, 'https://artificialanalysis.ai/models/minimax-m2-7/', 'Artificial Analysis output-speed measurement for MiniMax M2.7.'),
  'minimax-m3': speedDefault(155.5, 'https://artificialanalysis.ai/models/minimax-m3/', 'Artificial Analysis output-speed measurement for MiniMax M3.'),
  'qwen3-coder-next': speedDefault(128, 'https://artificialanalysis.ai/models/qwen3-coder-next/', 'Artificial Analysis output-speed measurement for Qwen3 Coder Next.'),
  'qwen3-coder-plus': speedDefault(29, 'https://openrouter.ai/qwen/qwen3-coder-plus/providers', 'OpenRouter public one-week P50 average output throughput for exact Qwen3 Coder Plus.'),
  'qwen3.5-plus': speedDefault(54, 'https://openrouter.ai/qwen/qwen3.5-plus-02-15/providers', 'OpenRouter output throughput for the dated Qwen3.5 Plus release used by the current Qwen3.5 Plus alias.'),
  'qwen3.6-plus': speedDefault(56.1, 'https://artificialanalysis.ai/models/qwen3-6-plus/', 'Artificial Analysis output-speed measurement for Qwen3.6 Plus.'),
  'qwen3.7-flash': speedDefault(111.12, 'https://www.respan.ai/models/openrouter/qwen/qwen3.7-flash', 'Respan public real-traffic output-throughput measurement for exact Qwen3.7 Flash.'),
  'qwen3.7-plus': speedDefault(56.2, 'https://artificialanalysis.ai/models/qwen3-7-plus/', 'Artificial Analysis output-speed measurement for Qwen3.7 Plus.'),
  'qwen3.8-max': speedDefault(39.4, 'https://artificialanalysis.ai/models/qwen3-8-max/', 'Artificial Analysis output-speed measurement for Qwen3.8 Max.'),
};

type ModelMeta = {
  intelligence?: IntelligenceTier;
  intelligenceEvidence?: IntelligenceEvidence;
  reasoningEffort?: ReasoningEffort;
  capabilities: readonly ModelCapability[];
  maxOutputTokens?: number;
  pricing?: ModelPricing;
};

const MODEL_METADATA: Readonly<Record<string, ModelMeta>> = {
  'deepseek-v4-flash': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: { inputUsdPerMillion: 0.44, cachedInputUsdPerMillion: 0.014, outputUsdPerMillion: 1.32, source: SRC_DEEPSEEK, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_DEEPSEEK, checkedAt: INTEL_CHECKED_AT, status: 'product_provisional', indexVersion: 'v4.3', score: 35, reasoningConfiguration: 'max', basis: 'AA max; route version/effort not pinned' },
  },
  'deepseek-v4-pro': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: { inputUsdPerMillion: 1.32, cachedInputUsdPerMillion: 0.044, outputUsdPerMillion: 3.96, source: SRC_DEEPSEEK, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_DEEPSEEK_PRO, checkedAt: INTEL_CHECKED_AT, status: 'product_provisional', indexVersion: 'v4.3', score: 36, reasoningConfiguration: 'max' },
  },
  'hy4-preview': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: { inputUsdPerMillion: 0.834, cachedInputUsdPerMillion: 0.042, outputUsdPerMillion: 2.501, source: SRC_TENCENT_HY, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_TENCENT_HY, checkedAt: INTEL_CHECKED_AT, status: 'product_provisional', indexVersion: 'v4.3', basis: 'page evidence only; no verified score' },
  },
  'hy3': {
    intelligence: 'low',
    capabilities: ['text'],
    // Canonical CodeBuddy hunyuan model. Reference price derived from the
    // official Tencent TokenHub CNY list 1/0.25/4 (input/cached/output) using
    // the repository's fixed 7.2 CNY/USD with three-decimal convention.
    pricing: { inputUsdPerMillion: 0.139, cachedInputUsdPerMillion: 0.035, outputUsdPerMillion: 0.556, source: SRC_TENCENT_TOKENHUB, checkedAt: '2026-09-08' },
    intelligenceEvidence: { source: SRC_AA_HY3, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 26 },
  },
  'gpt-6-astra': {
    reasoningEffort: 'xhigh',
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    maxOutputTokens: 128_000,
    pricing: { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50, source: SRC_OPENAI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_ASTRA, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 53, reasoningConfiguration: 'xhigh' },
  },
  'gpt-5.3-codex-spark': {
    reasoningEffort: 'xhigh',
    capabilities: ['text'],
    // Spark has no exact AA intelligence match; left unknown.
  },
  'gpt-5.6-sol': {
    reasoningEffort: 'xhigh',
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: { inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.4, outputUsdPerMillion: 20, source: SRC_OPENAI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_SOL, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 44, reasoningConfiguration: 'xhigh' },
  },
  'gpt-5.6-terra': {
    reasoningEffort: 'xhigh',
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 12, source: SRC_OPENAI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_TERRA, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 38, reasoningConfiguration: 'xhigh' },
  },
  'gpt-5.6-luna': {
    reasoningEffort: 'xhigh',
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.2, source: SRC_OPENAI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_LUNA, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 35, reasoningConfiguration: 'xhigh' },
  },
  'kimi-k3': {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: { inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.30, outputUsdPerMillion: 15, source: SRC_KIMI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_KIMI, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 44, reasoningConfiguration: 'max', basis: 'product-approved measured high exception; AA max evidence' },
  },
  'k3': {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: { inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.30, outputUsdPerMillion: 15, source: SRC_KIMI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_KIMI, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 44, reasoningConfiguration: 'max', basis: 'product-approved measured high exception; AA max evidence' },
  },
  'glm-5.3': {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: { inputUsdPerMillion: 1.4, cachedInputUsdPerMillion: 0.26, outputUsdPerMillion: 4.4, source: SRC_ZAI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_GLM, checkedAt: INTEL_CHECKED_AT, status: 'product_provisional', indexVersion: 'v4.3', score: 45, reasoningConfiguration: 'max' },
  },
  'glm-5.3-flash': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: { inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.03, outputUsdPerMillion: 0.50, source: SRC_ZAI, checkedAt: DEFAULT_CHECKED_AT },
    intelligenceEvidence: { source: SRC_AA_GLMF, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 42 },
  },
  'minimax-m2.7': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_MINIMAX_M27, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 23 },
  },
  'MiniMax-M2.7': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_MINIMAX_M27, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 23 },
  },
  'minimax-m3': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_MINIMAX_M3, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 30 },
  },
  'MiniMax-M3': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_MINIMAX_M3, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 30 },
  },
  'cursor-grok-4.6-high': {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 6, source: 'https://docs.x.ai/developers/pricing', checkedAt: '2026-09-10' },
    intelligenceEvidence: { source: SRC_AA_GROK46, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 44, reasoningConfiguration: 'high' },
  },
  'qwen3-coder-next': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_QCN, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 10 },
  },
  'qwen3.7-plus': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_Q37, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 26 },
  },
  'qwen3.8-max': {
    intelligence: 'mid',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_Q38, checkedAt: INTEL_CHECKED_AT, status: 'measured', indexVersion: 'v4.3', score: 40 },
  },
  'claude-haiku-4-5-20251001': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_HAIKU, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 15, reasoningConfiguration: 'non-reasoning' },
  },
  'glm-4.7-flash': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_GLM47, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 15, reasoningConfiguration: 'reasoning' },
  },
  'glm-5-turbo': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_GLM5, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 27 },
  },
  'glm-5.2': {
    intelligence: 'mid',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_GLM52, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 39, reasoningConfiguration: 'max' },
  },
  'gpt-5.4': {
    intelligence: 'mid',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_GPT54, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 39, reasoningConfiguration: 'xhigh' },
  },
  'kimi-k2.5': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_KIMI25, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 23, reasoningConfiguration: 'reasoning' },
  },
  'kimi-k2.6': {
    intelligence: 'mid',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_KIMI26, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 31 },
  },
  'qwen3.6-plus': {
    intelligence: 'low',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_Q36, checkedAt: INTEL_CHECKED_AT, status: 'estimated', indexVersion: 'v4.3', score: 27 },
  },
  'claude-fable-5': {
    intelligence: 'premium',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_FABLE, checkedAt: INTEL_CHECKED_AT, status: 'product_provisional', indexVersion: 'v4.3', reasoningConfiguration: 'adaptive max', basis: 'Exact-model intelligence score is unverified; provisional tier only.' },
  },
  'claude-opus-5': {
    intelligence: 'premium',
    capabilities: ['text'],
    intelligenceEvidence: { source: SRC_AA_OPUS, checkedAt: INTEL_CHECKED_AT, status: 'product_provisional', indexVersion: 'v4.3', score: 51, reasoningConfiguration: 'adaptive max' },
  },
};

function withMeta(def: RawModelDefinition): ModelDefinition {
  const speed = def.speed ?? MODEL_SPEED_DEFAULTS[def.id];
  if (!speed) {
    throw new Error(`built-in model ${def.id} is missing required default speed metadata`);
  }
  const meta = MODEL_METADATA[def.id];
  if (!meta) {
    return { ...def, capabilities: def.capabilities ?? ['text'], speed };
  }
  return {
    ...def,
    intelligence: def.intelligence ?? meta.intelligence,
    intelligenceEvidence: def.intelligenceEvidence ?? meta.intelligenceEvidence,
    reasoningEffort: def.reasoningEffort ?? meta.reasoningEffort,
    capabilities: def.capabilities ?? meta.capabilities,
    speed,
    maxOutputTokens: def.maxOutputTokens ?? meta.maxOutputTokens,
    pricing: def.pricing ?? meta.pricing,
  };
}

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = builtinProviders.map((provider) => ({
  ...provider,
  ...PROVIDER_PRESENTATION[provider.id],
  models: provider.models.map(withMeta),
}));

export function createBuiltinCatalog(): Catalog {
  const catalog = new Catalog();
  for (const client of clients) catalog.registerClient(client);
  for (const provider of BUILTIN_PROVIDERS) catalog.registerProvider(provider);
  return catalog;
}

export function canonicalizeBuiltinPublicModelId(publicId: string): string {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return publicId;
  const providerId = publicId.slice(0, separator);
  const modelId = publicId.slice(separator + 1);
  const provider = BUILTIN_PROVIDERS.find((candidate) => candidate.id === providerId);
  const canonicalModelId = provider?.modelAliases?.[modelId];
  return canonicalModelId ? `${providerId}/${canonicalModelId}` : publicId;
}

// Derive logical task dispatch plans solely from Catalog compatibility and
// task-capable client metadata. Keys are canonical provider/model:client targets
// (formatRunSyntax); no source preset table, seed, profile aliases, or policy
// registry exists in this file.
export function deriveTaskDispatchPlans(catalog: Catalog): Readonly<Record<string, DispatchPlan>> {
  return Object.fromEntries(catalog.enumerateTaskCandidates().map((candidate) => [
    candidate.profileId,
    catalog.resolveRun(candidate.client, candidate.provider, candidate.model),
  ]));
}
