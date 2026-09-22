import { defineProvider, model, openAI, anthropic, THINKING_LOW_HIGH_MAX } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'opencode-zen', displayName: 'OpenCode Zen', credentialResolver: 'managed',
  nativeClients: ['opencode'], defaultModel: 'kimi-k3',
  models: [
    // Zen free pool: usable only through the genuine OpenCode client
    // transport, so these never appear in the client-agnostic gateway
    // directory. `union-alpha` speaks the Anthropic messages protocol; the
    // remaining free models are chat-completions only.
    { ...model('mimo-v2.5-free', 1_048_576, 32_768, 'mimo-v2.5'), free: true, supportedClients: ['opencode'] },
    { ...model('ling-3.0-flash-fin-free', 262_144, 32_768, 'ling-3.0-flash-fin'), free: true, supportedClients: ['opencode'] },
    { ...model('big-pickle'), free: true, supportedClients: ['opencode'] },
    { ...model('union-alpha'), free: true, supportedClients: ['opencode'] },
    { ...model('nemotron-3-ultra-free', 1_000_000, 32_768, 'nemotron-3-ultra'), free: true, supportedClients: ['opencode'] },
    { ...model('nemotron-3.5-lightning-free', 1_000_000, 32_768, 'nemotron-3.5-lightning'), free: true, supportedClients: ['opencode'] },
    // Paid Zen pool: gateway-usable, priced by the existing catalog metadata.
    model('glm-5.3', 1_048_576, 32_768, 'glm-5.3'),
    model('kimi-k3', 1_048_576, 32_768, 'kimi-k3', THINKING_LOW_HIGH_MAX),
  ],
  protocols: [
    openAI('https://opencode.ai/zen/v1/chat/completions'),
    anthropic('https://opencode.ai/zen/v1/messages'),
  ],
  description: 'OpenCode Zen 免费与付费模型。',
  setupHint: '免费模型仅可通过 OpenCode 客户端使用，数据可能用于改进并受额度限制；付费模型走 OpenCode Zen 余额。输入 OpenCode Zen 托管凭据即可使用。',
});
