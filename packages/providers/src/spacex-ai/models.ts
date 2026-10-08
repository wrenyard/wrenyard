import { defineProvider, model, REASONING_UP_TO_XHIGH } from '../base/model-defaults.ts';

// SpaceXAI is the model API. The Super Grok subscription is a separate
// provider id with its own metadata, quota row, and pool; neither identity
// rewrites into the other.
export const definition = defineProvider({
  id: 'spacex-ai', displayName: 'SpaceXAI', credentialResolver: 'grok-oauth', nativeClients: ['grok'], defaultModel: 'grok-4.7', quotaProvider: 'spacex-ai', useClientBinary: true,
  // The Grok client sends a text prompt file and does not forward images.
  // The native CLI receives an explicit mapped reasoning effort.
  models: [{ ...model('grok-4.7', 500_000, undefined, 'grok-4.7', REASONING_UP_TO_XHIGH), capabilities: ['text'] }],
  reasoningEffortMappings: { 'grok-4.7': { grok: Object.fromEntries(REASONING_UP_TO_XHIGH.map(e => [e,{effort:e}])) } },
  convertReasoningEffort: () => { throw new Error('SpaceXAI only supports native Grok effort settings'); },
  description: 'SpaceXAI 提供的 Grok 原生 OAuth 模型 API 服务。',
  setupHint: '请使用 Grok 客户端完成 OAuth 登录，返回啾啾工坊后刷新状态。',
});
