import { defineProvider, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'qwen-coding', displayName: 'Qwen Coding Plan', credentialResolver: 'managed',
  models: [],
  protocols: [openAI('https://coding.dashscope.aliyuncs.com/v1/chat/completions'), anthropic('https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages')],
  description: '阿里云百炼 Coding Plan 订阅模型。',
  setupHint: '输入 Coding Plan API Key（sk-sp-）；不要使用百炼按量计费 Key。',
});
