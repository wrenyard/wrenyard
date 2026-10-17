import { defineProvider, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'deepseek', displayName: 'DeepSeek', credentialResolver: 'managed', defaultModel: 'deepseek-v4.1-flash',
  // The official open platform publishes exactly two models: V4.1 Flash and
  // V4 Pro. Pro was scheduled to fold into Flash on 2026-09-14 but DeepSeek
  // reversed that and kept it billable, so it is a live route again. The
  // registered identity is public; the platform's own spelling stays private.
  models: [
    model('deepseek-v4.1-flash', 1_000_000, 384_000, 'deepseek-flash', ['none', 'high', 'max']),
    model('deepseek-v4-pro', 1_000_000, 384_000, 'deepseek-pro', ['none', 'high', 'max']),
  ],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort } };
    return { thinking: { type: 'enabled' }, reasoning_effort: effort };
  },
  protocols: [openAI('https://api.deepseek.com/chat/completions')],
});
