import { defineProvider, model, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'anthropic', displayName: 'Anthropic', credentialResolver: 'managed',
  defaultModel: 'claude-sonnet-5', quotaProvider: 'anthropic',
  models: [
    { ...model('claude-opus-5', 1_000_000, 131_072, 'claude-opus-5'), family: 'claude', claudeTier: 'opus', supports1MContext: true },
    { ...model('claude-sonnet-5', 1_000_000, 131_072), family: 'claude', claudeTier: 'sonnet', supports1MContext: true },
    { ...model('claude-haiku-4-5-20251001', 200_000, 64_000, 'claude-haiku-4-5'), family: 'claude', claudeTier: 'haiku' },
  ],
  protocols: [anthropic('https://api.anthropic.com/v1/messages', 'x-api-key')],
  description: 'Anthropic 官方开放平台 API，与 Claude Code 登录态分开配置。',
  setupHint: '输入 Anthropic API Key；Key 仅写入本机 Wrenyard runtime。',
});
