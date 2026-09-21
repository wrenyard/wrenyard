import { defineProvider, CANONICAL_MODELS, model, openAI, anthropic } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'qwen-coding', displayName: 'Qwen Coding Plan', credentialResolver: 'forge-managed', defaultModel: 'qwen3.7-plus',
  models: [model('qwen3.7-plus', 1_000_000, 131_072, CANONICAL_MODELS['qwen3.7-plus']), model('qwen3.6-plus', 1_000_000, 131_072), model('qwen3.5-plus', 1_000_000, 131_072, CANONICAL_MODELS['qwen3.5-plus']), model('qwen3-coder-next', 262_144, 32_768, CANONICAL_MODELS['qwen3-coder-next']), model('qwen3-coder-plus', 1_000_000, 131_072)],
  protocols: [openAI('https://coding.dashscope.aliyuncs.com/v1/chat/completions'), anthropic('https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages')],
  description: '阿里云百炼 Coding Plan 订阅模型。',
  setupHint: '输入 Coding Plan API Key（sk-sp-）；不要使用百炼按量计费 Key。',
});
