import { defineProvider, model, openAI, anthropic, effortLadder } from '../base/model-defaults.ts';

// M3.1 Flash Preview materializes low through max; `none` is not offered.
const REASONING_LOW_MAX = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const definition = defineProvider({
  id: 'minimax-coding', displayName: 'MiniMax Coding Plan', credentialResolver: 'managed', defaultModel: 'MiniMax-M3.1-Flash-Preview',
  // M3.1 Flash Preview is subscription-only; the pay-as-you-go provider keeps M3.
  models: [model('MiniMax-M3.1-Flash-Preview', undefined, undefined, 'minimax-m3.1-flash-preview', REASONING_LOW_MAX)],
  reasoningEffortMappings: {
    'MiniMax-M3.1-Flash-Preview': {
      claude: effortLadder(REASONING_LOW_MAX),
      codebuddy: effortLadder(REASONING_LOW_MAX),
      grok: effortLadder(REASONING_LOW_MAX),
    },
  },
  protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'adaptive' }, output_config: { effort } };
    return { reasoning_effort: effort };
  },
  description: 'MiniMax Token Plan 的订阅 Key 接入。',
  setupHint: '输入 MiniMax 订阅 Key；订阅 Key 与按量计费 API Key 不可混用。',
});
