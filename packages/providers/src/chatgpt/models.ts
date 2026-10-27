import { defineProvider, REASONING_FULL, effortLadder } from '../base/model-defaults.ts';
import { chatGptAfterResponse, chatGptBeforeRequest } from './runtime.ts';

export const definition = defineProvider({
  modelProtocols: ['openai_responses'],
  id: 'chatgpt', displayName: 'ChatGPT', credentialResolver: 'codex',
  nativeClients: ['codex'], defaultModel: 'gpt-6-astra', quotaProvider: 'chatgpt',
  // Supplier hooks: the pinned streamed/non-persisted openai_responses request
  // contract and the missing Content-Type repair on its SSE response.
  beforeRequest: chatGptBeforeRequest,
  afterResponse: chatGptAfterResponse,
  // Fast is supported on the ChatGPT subscription surface: the official Codex
  // docs state Fast mode covers GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol and GPT-6
  // Luna where available when signed in with ChatGPT
  // (https://developers.openai.com/codex/speed.md), and the Codex config
  // reference maps `fast` to the request value `priority`
  // (https://developers.openai.com/codex/config-reference). The mapping below
  // emits that documented Responses field and nothing for other protocols.
  models: [
    {
      canonical: 'gpt-6-astra',
      overrides: { contextWindow: 1_050_000, reasoningEfforts: REASONING_FULL, supportsFast: true },
    },
    // Client eligibility is not pinned here; it comes from the installed Codex
    // client's own model discovery for the signed-in account.
    { canonical: 'gpt-6.1-sol', overrides: { reasoningEfforts: REASONING_FULL, supportsFast: true } },
    { canonical: 'gpt-6.1-terra', overrides: { reasoningEfforts: REASONING_FULL, supportsFast: true } },
    { canonical: 'gpt-6-luna', overrides: { reasoningEfforts: REASONING_FULL, supportsFast: true } },
  ],
  // The official service tier is the only Fast surface: priority means Fast on
  // and default means explicitly off. The subscription route speaks only the
  // Responses protocol, so any other protocol contributes no fields.
  fastMapping: {
    request: (_modelId, fast, protocol) => protocol === 'openai_responses'
      ? { service_tier: fast ? 'priority' : 'default' }
      : {},
  },
  modelAliases: { 'codex-astra': 'gpt-6-astra' },
  // The subscription Responses surface of the ChatGPT backend. Codex-native
  // clients keep their existing native transport; this entry only lets the
  // Model Gateway forward the exact openai_responses protocol.
  protocols: [
    {
      protocol: 'openai_responses',
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      authScheme: 'bearer',
    },
  ],
  // Native Codex wire identity effort: each declared level is sent as the exact
  // effort token; the public canonical model id is retained.
  reasoningEffortMappings: {
    'gpt-6-astra': { codex: effortLadder(REASONING_FULL) },
    'gpt-6.1-sol': { codex: effortLadder(REASONING_FULL) },
    'gpt-6.1-terra': { codex: effortLadder(REASONING_FULL) },
    'gpt-6-luna': { codex: effortLadder(REASONING_FULL) },
  },
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol === 'openai_chat') return { reasoning_effort: effort };
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    throw new Error('Anthropic protocol is unsupported by this provider');
  },
  description: 'ChatGPT 编程模型使用账号适用的 5h、7d 额度池。',
  setupHint: '请使用 Codex CLI 完成登录，返回啾啾工坊后刷新状态。',
});
