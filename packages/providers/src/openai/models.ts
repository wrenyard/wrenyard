import { defineProvider, REASONING_FULL, effortLadder } from '../base/model-defaults.ts';

// GPT-6.1 Sol tool calls require Responses; Chat Completions is text-only.
export const definition = defineProvider({
  id: 'openai', displayName: 'OpenAI', credentialResolver: 'managed', defaultModel: 'gpt-6.1-sol',
  models: [
    { canonical: 'gpt-6-astra', overrides: { reasoningEfforts: REASONING_FULL } },
    { canonical: 'gpt-6.1-sol', overrides: { reasoningEfforts: REASONING_FULL } },
    { canonical: 'gpt-6-luna', overrides: { reasoningEfforts: REASONING_FULL } },
  ],
  reasoningEffortMappings: {
    'gpt-6-astra': { codex: effortLadder(REASONING_FULL) },
    'gpt-6.1-sol': { codex: effortLadder(REASONING_FULL) },
    'gpt-6-luna': { codex: effortLadder(REASONING_FULL) },
  },
  protocols: [
    { protocol: 'openai_responses', endpoint: 'https://api.openai.com/v1/responses', authScheme: 'bearer' },
  ],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol === 'openai_chat') return { reasoning_effort: effort };
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    throw new Error('Anthropic protocol is unsupported by this provider');
  },
  description: 'OpenAI 官方开放平台 API，与 Codex 登录态分开配置。',
  setupHint: '输入 OpenAI API Key；Key 仅写入本机 Wrenyard runtime。',
});
