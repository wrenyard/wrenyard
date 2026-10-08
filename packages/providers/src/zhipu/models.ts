import { defineProvider, model, openAI, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'zhipu', displayName: 'Zhipu', credentialResolver: 'managed', defaultModel: 'glm-5.3',
  // The open platform's current lineup, matching the vendor's own "Latest
  // Models" price table. GLM-5.2 stays because the open platform still sells
  // it after the Coding plan dropped it; GLM-5.3-FlashX is deliberately absent
  // until its throughput is measured rather than vendor-claimed.
  models: [
    model('glm-5.3', 1_048_576, 32_768, 'glm-5.3', REASONING_LOW_HIGH_MAX),
    model('glm-5.3-flash', 1_048_576, 32_768, 'glm-5.3-flash', REASONING_LOW_HIGH_MAX),
    model('glm-5.2', 1_048_576, 32_768, undefined, ['none', 'high', 'max']),
  ],
  protocols: [openAI('https://open.bigmodel.cn/api/paas/v4/chat/completions')],
  // GLM-5.2 can disable reasoning entirely: `none` maps to a disabled thinking
  // block; every other level is sent as the `reasoning_effort` field.
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort } };
    return { reasoning_effort: effort };
  },
  description: '智谱 BigModel 官方按量计费 API。',
  setupHint: '输入智谱开放平台 API Key；它与 GLM Coding Key 分开保存。',
});
