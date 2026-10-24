import { defineProvider, model, openAI, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';

export const definition = defineProvider({
  modelProtocols: ['openai_chat'],
  id: 'moonshot', displayName: 'Moonshot', credentialResolver: 'managed', defaultModel: 'kimi-k3.1-pro',
  models: [
    { ...model('kimi-k3.1-pro', 1_048_576, 1_048_576, undefined, REASONING_LOW_HIGH_MAX), supportsFast: true },
    model('kimi-k3', 1_048_576, 32_768, undefined, REASONING_LOW_HIGH_MAX),
  ],
  protocols: [openAI('https://api.moonshot.cn/v1/chat/completions')],
  // Fast is the K3.1 Pro Highspeed wire id and nothing else: only that model
  // has an upstream fast variant, and the reasoning effort stays untouched.
  fastMapping: {
    request: (modelId, fast) => (fast && modelId === 'kimi-k3.1-pro' ? { model: 'kimi-k3.1-pro-highspeed' } : {}),
  },
  convertReasoningEffort: (_modelId, effort, protocol) => {
      if (protocol === 'openai_responses') return { reasoning: { effort } };
      if (protocol === 'anthropic_messages') return { output_config: { effort } };
      return { reasoning_effort: effort };
    },
  description: '月之暗面官方开放平台的 Kimi 模型。',
  setupHint: '输入 Kimi 开放平台 API Key；它与 Kimi Coding Key 分开保存。',
});
