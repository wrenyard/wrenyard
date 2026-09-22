import { defineProvider, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'volcengine', displayName: 'Volcengine Ark', credentialResolver: 'managed', defaultModel: 'doubao-seed-2-0-lite-260215',
  models: [model('doubao-seed-2-0-lite-260215', 262_144, 32_768)],
  protocols: [openAI('https://ark.cn-beijing.volces.com/api/v3/chat/completions')],
  description: '火山引擎方舟官方模型 API。',
  setupHint: '输入火山方舟 API Key；Key 仅写入本机 Wrenyard runtime。',
});
