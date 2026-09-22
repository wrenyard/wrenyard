import { defineProvider, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'zhipu', displayName: 'Zhipu', credentialResolver: 'managed', defaultModel: 'glm-5.3',
  // The open platform's current lineup, matching the vendor's own "Latest
  // Models" price table. GLM-5.2 stays because the open platform still sells
  // it after the Coding plan dropped it; GLM-5.3-FlashX is deliberately absent
  // until its throughput is measured rather than vendor-claimed.
  models: [
    model('glm-5.3', 1_048_576, 32_768, 'glm-5.3'),
    model('glm-5.3-flash', 1_048_576, 32_768, 'glm-5.3-flash'),
    model('glm-5.2', 1_048_576, 32_768),
  ],
  protocols: [openAI('https://open.bigmodel.cn/api/paas/v4/chat/completions')],
  description: '智谱 BigModel 官方按量计费 API。',
  setupHint: '输入智谱开放平台 API Key；它与 GLM Coding Key 分开保存。',
});
