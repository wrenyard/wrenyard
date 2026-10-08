import { defineProvider, model, openAI, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'moonshot', displayName: 'Moonshot', credentialResolver: 'managed', defaultModel: 'kimi-k3',
  models: [model('kimi-k3', 1_048_576, 32_768, 'kimi-k3', REASONING_LOW_HIGH_MAX)],
  protocols: [openAI('https://api.moonshot.cn/v1/chat/completions')],
  convertReasoningEffort: (_modelId, effort, protocol) => {
      if (protocol === 'openai_responses') return { reasoning: { effort } };
      if (protocol === 'anthropic_messages') return { output_config: { effort } };
      return { reasoning_effort: effort };
    },
  description: '月之暗面官方开放平台的 Kimi 模型。',
  setupHint: '输入 Kimi 开放平台 API Key；它与 Kimi Coding Key 分开保存。',
});
