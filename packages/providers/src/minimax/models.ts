import { defineProvider, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'minimax', displayName: 'MiniMax', credentialResolver: 'managed', defaultModel: 'MiniMax-M3',
  models: [model('MiniMax-M3', 1_000_000, 131_072, 'minimax-m3', ['none', 'medium'])],
  protocols: [openAI('https://api.minimaxi.com/v1/chat/completions'), anthropic('https://api.minimaxi.com/anthropic/v1/messages')],
  // MiniMax M3 exposes only `none` and `medium`: `medium` selects adaptive
  // thinking, `none` disables it entirely. Every other MiniMax row sends the
  // level verbatim as `reasoning_effort`.
  convertReasoningEffort: (modelId, effort, protocol) => {
    if (protocol !== 'openai_chat' && protocol !== 'anthropic_messages') throw new Error('MiniMax M3 does not expose Responses');
    if (modelId !== 'MiniMax-M3' && modelId !== 'minimax-m3') throw new Error('Unknown MiniMax route');
    if (effort !== 'none' && effort !== 'medium') throw new Error('MiniMax M3 supports only none and medium');
    return { thinking: { type: effort === 'medium' ? 'adaptive' : 'disabled' } };
  },
  description: 'MiniMax 官方按量计费 API。',
  setupHint: '输入 MiniMax 按量计费 API Key；Key 仅写入本机 Wrenyard runtime。',
});
