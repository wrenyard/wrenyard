import { defineProvider, model, openAI, THINKING_LOW_HIGH_MAX } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'deepseek', displayName: 'DeepSeek', credentialResolver: 'forge-managed', defaultModel: 'deepseek-flash',
  // The official open platform publishes exactly two models: V4.1 Flash and
  // V4 Pro. Pro was scheduled to fold into Flash on 2026-09-14 but DeepSeek
  // reversed that and kept it billable, so it is a live route again.
  models: [
    model('deepseek-flash', 1_000_000, 384_000, undefined, THINKING_LOW_HIGH_MAX),
    model('deepseek-pro', 1_000_000, 384_000, undefined, THINKING_LOW_HIGH_MAX),
  ],
  protocols: [openAI('https://api.deepseek.com/chat/completions')],
});
