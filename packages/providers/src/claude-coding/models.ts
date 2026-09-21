import { defineProvider } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'claude-coding', displayName: 'Claude', credentialResolver: 'claude',
  nativeClients: ['claude'], models: [], quotaProvider: 'claude-coding', useClientBinary: true,
  description: 'Claude Code 与 Anthropic 模型服务。',
  setupHint: '请使用 Claude Code 完成登录，返回啾啾工坊后刷新状态。',
});
