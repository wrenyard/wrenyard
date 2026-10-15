import { defineProvider, model, openAI, anthropic, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';
import type { ProviderRequestHookContext } from '../base/contracts.ts';

/**
 * The OpenCode service requires the stable OpenCode User-Agent and forwards the
 * client's session header. Only a well-formed single-line token is forwarded,
 * so it cannot smuggle extra header lines into the upstream request.
 */
function forwardOpenCodeSession(context: ProviderRequestHookContext): void {
  context.headers.set('user-agent', 'wrenyard');
  const value = context.requestHeaders['x-opencode-session'];
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return;
  if (value.includes('\r') || value.includes('\n')) return;
  context.headers.set('x-opencode-session', value);
}

export const definition = defineProvider({
  id: 'opencode-zen', displayName: 'OpenCode Zen', credentialResolver: 'managed',
  nativeClients: ['opencode'], defaultModel: 'kimi-k3',
  // Supplier hook: the OpenCode identity and session-header forwarding.
  beforeRequest: forwardOpenCodeSession,
  models: [
    // Zen free pool: usable only through the genuine OpenCode client
    // transport, so these never appear in the client-agnostic gateway
    // directory. `union-alpha` speaks the Anthropic messages protocol; the
    // remaining free models are chat-completions only.
    { ...model('mimo-v2.5-free', 1_048_576, 32_768, 'mimo-v2.5'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('ling-3.0-flash-fin-free', 262_144, 32_768, 'ling-3.0-flash-fin'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('big-pickle'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('union-alpha'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('nemotron-3-ultra-free', 1_000_000, 32_768, 'nemotron-3-ultra'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    { ...model('nemotron-3.5-lightning-free', 1_000_000, 32_768, 'nemotron-3.5-lightning'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['high'] },
    // Free DeepSeek is its own identity, distinct from the paid
    // `deepseek-v4.1-flash` above: different context/output limits. Its
    // reasoning uses the native provider default (the 'default' sentinel), so no
    // effort ladder is fabricated; no alias/fallback is added.
    { ...model('deepseek-v4.1-flash-free', 200_000, 32_000, 'deepseek-v4.1-flash-free'), free: true, supportedClients: ['opencode'], reasoningEfforts: ['default'] },
    // Paid Zen pool, priced by the registered catalog metadata.
    model('glm-5.3', 1_048_576, 32_768, 'glm-5.3', REASONING_LOW_HIGH_MAX),
    model('kimi-k3', 1_048_576, 32_768, 'kimi-k3', REASONING_LOW_HIGH_MAX),
    // Zen serves Sol through Responses. The native OpenCode client owns that
    // transport; the existing Chat Completions gateway cannot serve this model.
    { canonical: 'gpt-6.1-sol', overrides: { supportedClients: ['opencode'], reasoningEfforts: ['high'] } },
    // The official Zen Argon endpoint uses @ai-sdk/google, so this model is
    // reachable only through the native OpenCode client and is never published
    // through the OpenAI or Anthropic gateway.
    { canonical: 'gemini-4-argon', overrides: { supportedClients: ['opencode'], reasoningEfforts: ['low', 'medium', 'high'] } },
  ],
  reasoningEffortMappings: {
    ...Object.fromEntries(['mimo-v2.5-free','ling-3.0-flash-fin-free','big-pickle','union-alpha','nemotron-3-ultra-free','nemotron-3.5-lightning-free','glm-5.3','kimi-k3','gemini-4-argon','gpt-6.1-sol'].map(id=>[id,{opencode:Object.fromEntries((id === 'glm-5.3' || id === 'kimi-k3' ? REASONING_LOW_HIGH_MAX : id === 'gemini-4-argon' ? ['low','medium','high'] : ['high']).map(e=>[e,{effort:e}]))}])),
    // Native provider-default reasoning: a non-empty, model-only mapping so the
    // validator accepts it, while no --variant effort is emitted because
    // clientReasoningEffort stays undefined.
    'deepseek-v4.1-flash-free': { opencode: { default: { model: 'deepseek-v4.1-flash-free' } } },
  },
  protocols: [
    openAI('https://opencode.ai/zen/v1/chat/completions'),
    anthropic('https://opencode.ai/zen/v1/messages'),
  ],
  convertReasoningEffort: (_modelId, effort, protocol) => {
      if (protocol === 'openai_responses') return { reasoning: { effort } };
      if (protocol === 'anthropic_messages') return { output_config: { effort } };
      return { reasoning_effort: effort };
    },
  description: 'OpenCode Zen 免费与付费模型。',
  setupHint: '免费模型走原生 OpenCode 客户端，无需 API Key；其中 DeepSeek 免费路由适用零数据保留、不用于训练的条款，其余免费模型的数据使用条款以各自上游为准。付费 OpenCode Zen 模型需要 OpenCode Zen 托管凭据（API Key）。免费额度有限且未公开。',
});
