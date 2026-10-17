import { defineProvider, model, openAI } from '../base/model-defaults.ts';
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
  id: 'opencode-go', displayName: 'OpenCode Go', credentialResolver: 'managed', defaultModel: 'glm-5.3-flash',
  // Supplier hook: the OpenCode identity and session-header forwarding.
  beforeRequest: forwardOpenCodeSession,
  models: [
    { ...model('glm-5.3-flash'), capabilities: ['text'], pricing: [0.03, 0.15, 0.50], reasoningEfforts: ['high'] },
    { ...model('glm-5.3'), capabilities: ['text'], pricing: [0.26, 1.4, 4.4], reasoningEfforts: ['high'] },
    { ...model('deepseek-v4.1-flash', 1_000_000, 384_000, 'deepseek-flash'), capabilities: ['text', 'image'], pricing: [0.006, 0.3, 1.2], reasoningEfforts: ['high'] },
    { ...model('hunyuan-hy3', undefined, undefined, 'hy3'), capabilities: ['text'], pricing: [0.035, 0.14, 0.58], reasoningEfforts: ['high'] },
  ],
  protocols: [openAI('https://opencode.ai/zen/go/v1/chat/completions')],
  convertReasoningEffort: (_modelId, effort, protocol) => {
      if (protocol === 'openai_responses') return { reasoning: { effort } };
      if (protocol === 'anthropic_messages') return { output_config: { effort } };
      return { reasoning_effort: effort };
    },
  description: 'OpenCode Go 付费订阅模型（$10/月）。',
  setupHint: 'OpenCode Go 与 Zen 免费试用相互独立，为 $10/月付费订阅；额度因模型而异；使用 OpenCode 客户端。超额后是否使用余额由控制台 Use balance 设置决定。',
});
