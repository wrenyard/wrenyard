import { defineProvider, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'qwen', displayName: 'Qwen Model Studio', credentialResolver: 'managed', defaultModel: 'qwen3.8-max',
  models: [model('qwen3.8-max', 1_000_000, 131_072)],
  protocols: [openAI('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'), anthropic('https://dashscope.aliyuncs.com/apps/anthropic/v1/messages')],
  description: '阿里云百炼按量计费的 Qwen 模型。',
  setupHint: '输入百炼按量计费 API Key；它与 Coding Plan Key 分开保存。',
});
