import { defineProvider, CANONICAL_MODELS, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'zhipu-coding', displayName: 'Zhipu Coding', credentialResolver: 'managed', defaultModel: 'glm-5.3', quotaProvider: 'zhipu-coding',
  models: [model('glm-5.3', 1_048_576, 32_768, CANONICAL_MODELS['glm-5.3']), model('glm-5.3-flash', 1_048_576, 32_768, CANONICAL_MODELS['glm-5.3-flash'])],
  protocols: [openAI('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'), anthropic('https://open.bigmodel.cn/api/anthropic/v1/messages')],
  description: '智谱 GLM 5.3 系列编程模型与订阅额度。',
  setupHint: '输入 GLM Coding API Key；Key 仅写入本机 Wrenyard runtime。',
});
