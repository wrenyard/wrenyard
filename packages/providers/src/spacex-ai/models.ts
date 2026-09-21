import { defineProvider, model } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'spacex-ai', displayName: 'Super Grok', credentialResolver: 'grok-oauth', nativeClients: ['grok'], defaultModel: 'grok-4.5', quotaProvider: 'spacex-ai', useClientBinary: true,
  models: [model('grok-4.5', 2_000_000, 131_072)],
  description: 'SpaceXAI 提供的 Grok 原生 OAuth 模型服务。',
  setupHint: '请使用 Grok 客户端完成 OAuth 登录，返回啾啾工坊后刷新状态。',
});
