import { defineProvider, CANONICAL_MODELS, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'opencode-go', displayName: 'OpenCode Go', credentialResolver: 'forge-managed', defaultModel: 'glm-5.3-flash',
  models: [
    { ...model('glm-5.3-flash', undefined, undefined, CANONICAL_MODELS['glm-5.3-flash']), capabilities: ['text'], pricing: [0.03, 0.15, 0.50] },
    { ...model('glm-5.3', undefined, undefined, CANONICAL_MODELS['glm-5.3']), capabilities: ['text'], pricing: [0.26, 1.4, 4.4] },
    { ...model('deepseek-flash', 1_000_000, 384_000), capabilities: ['text', 'image'], intelligence: 'mid', pricing: [0.006, 0.3, 1.2] },
    { ...model('hy3'), capabilities: ['text'], pricing: [0.035, 0.14, 0.58] },
  ],
  protocols: [openAI('https://opencode.ai/zen/go/v1/chat/completions')],
  description: 'OpenCode Go 付费订阅模型（$10/月）。',
  setupHint: 'OpenCode Go 与 Zen 免费试用相互独立，为 $10/月付费订阅；额度因模型而异；使用 OpenCode 客户端。超额后是否使用余额由控制台 Use balance 设置决定。',
});
