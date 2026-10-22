import { defineProvider, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  modelProtocols: ['openai_chat', 'anthropic_messages'],
  id: 'tokenhub', displayName: 'Tencent Cloud TokenHub', credentialResolver: 'managed', defaultModel: 'deepseek-v4.1-flash',
  models: [model('hunyuan-hy4-preview', 262_144, 32_768, 'hy4-preview', ['none', 'high']), model('deepseek-v4.1-flash', 1_000_000, 384_000, 'deepseek/deepseek-flash', ['none', 'high', 'max']), model('glm-5.3', 1_048_576, 32_768, undefined, ['low', 'high', 'max']), model('glm-5.3-flash', 1_048_576, 32_768, undefined, ['low', 'high', 'max'])],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort } };
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    return { reasoning_effort: effort };
  },
  protocols: [openAI('https://tokenhub.tencentmaas.com/v1/chat/completions'), anthropic('https://tokenhub.tencentmaas.com/v1/messages', 'x-api-key')],
  description: '腾讯云大模型服务平台 TokenHub 的公开 API。',
  setupHint: '输入腾讯云 TokenHub API Key；Key 仅写入本机 Wrenyard runtime。',
});
