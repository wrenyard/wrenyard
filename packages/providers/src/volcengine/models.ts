import { defineProvider, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'volcengine', displayName: 'Volcengine Ark', credentialResolver: 'managed', defaultModel: 'doubao-seed-2-0-lite-260215',
  models: [model('doubao-seed-2-0-lite-260215', 262_144, 32_768, 'doubao-seed-2-0-lite', ['none', 'medium'])],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol !== 'openai_chat') throw new Error('Volcengine only exposes Chat Completions');
    return { thinking: { type: effort === 'none' ? 'disabled' : 'auto' } };
  },
  protocols: [openAI('https://ark.cn-beijing.volces.com/api/v3/chat/completions')],
  description: '火山引擎方舟官方模型 API。',
  setupHint: '输入火山方舟 API Key；Key 仅写入本机 Wrenyard runtime。',
});
