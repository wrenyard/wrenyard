import { defineProvider, model, openAI, anthropic, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'opencode-zen', displayName: 'OpenCode Zen', credentialResolver: 'managed',
  nativeClients: ['opencode'], defaultModel: 'kimi-k3',
  models: [
    // Zen free pool: usable only through the genuine OpenCode client
    // transport, so these never appear in the client-agnostic gateway
    // directory. `union-alpha` speaks the Anthropic messages protocol; the
    // remaining free models are chat-completions only.
    { ...model('mimo-v2.5-free', 1_048_576, 32_768, 'mimo-v2.5'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('ling-3.0-flash-fin-free', 262_144, 32_768, 'ling-3.0-flash-fin'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('big-pickle'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('union-alpha'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('nemotron-3-ultra-free', 1_000_000, 32_768, 'nemotron-3-ultra'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('nemotron-3.5-lightning-free', 1_000_000, 32_768, 'nemotron-3.5-lightning'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    // Paid Zen pool, priced by the registered catalog metadata.
    model('glm-5.3', 1_048_576, 32_768, 'glm-5.3', REASONING_LOW_HIGH_MAX),
    model('kimi-k3', 1_048_576, 32_768, 'kimi-k3', REASONING_LOW_HIGH_MAX),
    // Zen serves Sol through Responses. The native OpenCode client owns that
    // transport; the existing Chat Completions gateway cannot serve this model.
    { canonical: 'gpt-6.1-sol', overrides: { supportedClients: ['opencode'], reasoningEfforts: ['high'] } },
  ],
  reasoningEffortMappings: Object.fromEntries(['mimo-v2.5-free','ling-3.0-flash-fin-free','big-pickle','union-alpha','nemotron-3-ultra-free','nemotron-3.5-lightning-free','glm-5.3','kimi-k3','gpt-6.1-sol'].map(id=>[id,{opencode:Object.fromEntries((id === 'glm-5.3' || id === 'kimi-k3' ? REASONING_LOW_HIGH_MAX : ['high']).map(e=>[e,{effort:e}]))}])),
  protocols: [
    openAI('https://opencode.ai/zen/v1/chat/completions'),
    anthropic('https://opencode.ai/zen/v1/messages'),
  ],
  convertReasoningEffort: (_modelId, effort, protocol) => {
      if (protocol === 'openai_responses') return { reasoning: { effort } };
      if (protocol === 'anthropic_messages') return { output_config: { effort } };
      return { reasoning_effort: effort };
    },
  description: 'OpenCode Zen 免费与付费模型。',
  setupHint: '免费模型仅可通过 OpenCode 客户端使用，数据可能用于改进并受额度限制；付费模型走 OpenCode Zen 余额。输入 OpenCode Zen 托管凭据即可使用。',
});
