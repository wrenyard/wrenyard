import { defineProvider, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'minimax-coding', displayName: 'MiniMax Coding Plan', credentialResolver: 'managed', defaultModel: 'MiniMax-M3',
  models: [model('MiniMax-M3', 1_000_000, 131_072, 'minimax-m3')],
  protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  description: 'MiniMax Token Plan 的订阅 Key 接入。',
  setupHint: '输入 MiniMax 订阅 Key；订阅 Key 与按量计费 API Key 不可混用。',
});
