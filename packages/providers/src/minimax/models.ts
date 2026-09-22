import { defineProvider, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'minimax', displayName: 'MiniMax', credentialResolver: 'managed', defaultModel: 'MiniMax-M3',
  models: [model('MiniMax-M3', 1_000_000, 131_072, 'minimax-m3')],
  protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  description: 'MiniMax 官方按量计费 API。',
  setupHint: '输入 MiniMax 按量计费 API Key；Key 仅写入本机 Wrenyard runtime。',
});
