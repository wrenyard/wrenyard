import { defineProvider, model, openAI, anthropic, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'zhipu-coding', displayName: 'Zhipu Coding', credentialResolver: 'managed', defaultModel: 'glm-5.3', quotaProvider: 'zhipu-coding',
  models: [
    model('glm-5.3', 1_048_576, 32_768, 'glm-5.3', REASONING_LOW_HIGH_MAX),
    model('glm-5.3-flash', 1_048_576, 32_768, 'glm-5.3-flash', REASONING_LOW_HIGH_MAX),
  ],
  protocols: [openAI('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'), anthropic('https://open.bigmodel.cn/api/anthropic/v1/messages')],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort } };
    return { reasoning_effort: effort };
  },
  description: '智谱 GLM 5.3 系列编程模型与订阅额度。',
  setupHint: '输入 GLM Coding API Key；Key 仅写入本机 Wrenyard runtime。',
});
