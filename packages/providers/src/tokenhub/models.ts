import { defineProvider, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'tokenhub', displayName: 'Tencent Cloud TokenHub', credentialResolver: 'managed', defaultModel: 'deepseek/deepseek-flash',
  models: [model('hy4-preview', 262_144, 32_768, 'hunyuan-hy4-preview'), model('deepseek/deepseek-flash', 1_000_000, 384_000, 'deepseek-v4.1-flash'), model('glm-5.3', 1_048_576, 32_768, 'glm-5.3'), model('glm-5.3-flash', 1_048_576, 32_768, 'glm-5.3-flash')],
  protocols: [openAI('https://tokenhub.tencentmaas.com/v1/chat/completions'), anthropic('https://tokenhub.tencentmaas.com/v1/messages', 'x-api-key')],
  description: '腾讯云大模型服务平台 TokenHub 的公开 API。',
  setupHint: '输入腾讯云 TokenHub API Key；Key 仅写入本机 Wrenyard runtime。',
});
