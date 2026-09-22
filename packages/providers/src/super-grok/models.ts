import { defineProvider } from '../base/model-defaults.ts';

// Super Grok is the Grok subscription identity. It is quota-only: no
// independently confirmed runnable subscription route exists, so it declares
// no models, no native client, and no execution binary. It is never merged
// with SpaceXAI (the model API) by an id rewrite.
export const definition = defineProvider({
  id: 'super-grok', displayName: 'Super Grok', credentialResolver: 'grok-oauth',
  models: [], quotaProvider: 'super-grok',
  description: 'Super Grok 订阅服务：仅提供订阅额度观测。',
  setupHint: '请使用 Grok 客户端完成 OAuth 登录，返回啾啾工坊后刷新订阅额度。',
});
