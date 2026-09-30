import { defineProvider, model, openAI, anthropic, THINKING_FULL, effortLadder } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'minimax-coding', displayName: 'MiniMax Coding Plan', credentialResolver: 'managed', defaultModel: 'MiniMax-M3.1-Flash-Preview',
  // M3.1 Flash Preview is subscription-only; the pay-as-you-go provider keeps M3.
  models: [model('MiniMax-M3.1-Flash-Preview', undefined, undefined, 'minimax-m3.1-flash-preview')],
  thinkingMappings: {
    'MiniMax-M3.1-Flash-Preview': {
      claude: effortLadder(THINKING_FULL),
      codebuddy: effortLadder(THINKING_FULL),
      grok: effortLadder(THINKING_FULL),
    },
  },
  protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  description: 'MiniMax Token Plan 的订阅 Key 接入。',
  setupHint: '输入 MiniMax 订阅 Key；订阅 Key 与按量计费 API Key 不可混用。',
});
