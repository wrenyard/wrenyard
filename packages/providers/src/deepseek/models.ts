import { defineProvider, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'deepseek', displayName: 'DeepSeek', credentialResolver: 'managed', defaultModel: 'deepseek-v4.1-flash',
  // Flash keeps its registered identity; the rolling 1017 release uses the same wire ID.
  // IDs and limits: https://api-docs.deepseek.com/api/list-models/
  // Effort mapping: https://api-docs.deepseek.com/guides/thinking_mode/
  models: [
    model('deepseek-v4.1-flash', 1_048_576, 393_216, 'deepseek-flash', ['none', 'low', 'medium', 'high', 'xhigh', 'max']),
    model('deepseek-v4-pro', 1_048_576, 393_216, 'deepseek-v4-pro', ['none', 'high', 'max']),
  ],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    // The upstream effort ladder has no `medium` or `xhigh`; both map to `high`.
    const upstreamEffort = (effort === 'medium' || effort === 'xhigh') ? 'high' : effort;
    if (protocol === 'openai_responses') return { reasoning: { effort: upstreamEffort } };
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort: upstreamEffort } };
    return { thinking: { type: 'enabled' }, reasoning_effort: upstreamEffort };
  },
  protocols: [openAI('https://api.deepseek.com/chat/completions')],
});
