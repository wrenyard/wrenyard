import { defineProvider, model, openAI, anthropic, REASONING_LOW_HIGH_MAX, effortLadder } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'kimi-coding', displayName: 'Kimi Coding', credentialResolver: 'managed',
  defaultModel: 'k3', quotaProvider: 'kimi-coding',
  models: [
    model('k3', 1_048_576, 32_768, 'kimi-k3', REASONING_LOW_HIGH_MAX),
    // K2.8 Preview context is 1M; no official max-output or reference token
    // price is published, so neither is registered. `kimi-for-coding` is the
    // exact official wire id clients send for this canonical model.
    model('kimi-k2.8', 1_048_576, undefined, 'kimi-k2.8', ['none', 'low', 'high', 'max']),
  ],
  modelAliases: { 'kimi-for-coding': 'kimi-k2.8' },
  protocols: [
    openAI('https://api.kimi.com/coding/v1/chat/completions'),
    anthropic('https://api.kimi.com/coding/v1/messages'),
  ],
  // Gateway clients may materialize K3 thinking once their native syntax
  // supports it; the exact wire alias is the level itself. K3 never exposes
  // `none` (it swaps to K2.8 upstream); K2.8 Preview supports `none` through
  // the disabled-thinking switch; native clients map only their documented effort levels.
  reasoningEffortMappings: {
    k3: {
      codex: effortLadder(REASONING_LOW_HIGH_MAX),
      claude: effortLadder(REASONING_LOW_HIGH_MAX),
      codebuddy: effortLadder(REASONING_LOW_HIGH_MAX),
      grok: effortLadder(REASONING_LOW_HIGH_MAX),
    },
    'kimi-k2.8': {
      codex: effortLadder(['low','high','max']),
      claude: effortLadder(['low','high','max']),
      codebuddy: effortLadder(['low','high','max']),
      grok: effortLadder(['low','high','max']),
    },
  },
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort } };
    return { reasoning_effort: effort };
  },
  description: 'Moonshot Kimi K3 与 Kimi K2.8 Preview 编程模型与订阅额度。',
  setupHint: '输入 Kimi Coding API Key；Key 仅写入本机 Wrenyard runtime。',
});
