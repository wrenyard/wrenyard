import { defineProvider, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'deepseek', displayName: 'DeepSeek', credentialResolver: 'managed', defaultModel: 'deepseek-flash',
  // The official open platform publishes exactly two models: V4.1 Flash and
  // V4 Pro. Pro was scheduled to fold into Flash on 2026-09-14 but DeepSeek
  // reversed that and kept it billable, so it is a live route again.
  models: [
    model('deepseek-flash', 1_000_000, 384_000, 'deepseek-v4.1-flash', ['none', 'high', 'max']),
    model('deepseek-pro', 1_000_000, 384_000, 'deepseek-v4-pro', ['none', 'high', 'max']),
  ],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort } };
    return { thinking: { type: 'enabled' }, reasoning_effort: effort };
  },
  protocols: [openAI('https://api.deepseek.com/chat/completions')],
});
