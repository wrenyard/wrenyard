import { defineProvider, model, openAI } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'openrouter', displayName: 'OpenRouter', credentialResolver: 'managed', defaultModel: 'nex-agi/nex-n2.5-mini:free',
  models: [
    { ...model('nex-agi/nex-n2.5-mini:free', 262_144, 235_929, 'nex-n2.5-mini'), free: true, capabilities: ['text', 'image'] },
    { ...model('nex-agi/nex-n2.5-pro:free', 262_144, 235_929, 'nex-n2.5-pro'), free: true, capabilities: ['text', 'image'] },
    { ...model('cohere/north-mini-code:free', 256_000, 64_000, 'north-mini-code'), free: true },
    { ...model('inclusionai/ling-3.0-flash-vl:free', 262_144, 32_768, 'ling-3.0-flash-vl'), free: true, capabilities: ['text', 'image'] },
    { ...model('inclusionai/ling-3.0-flash-sante:free', 262_144, 32_768, 'ling-3.0-flash-sante'), free: true },
    { ...model('inclusionai/ling-3.0-flash-fin:free', 262_144, 32_768, 'ling-3.0-flash-fin'), free: true },
    { ...model('qwen/qwen3.8-27b:free', 262_144, 235_929, 'qwen3.8-27b'), free: true, capabilities: ['text', 'image'] },
    { ...model('dots-studio/dots-3-note-preview:free', 512_000, 460_800, 'dots-3-note-preview'), free: true, capabilities: ['text', 'image'] },
    { ...model('liquid/lfm-2.5-2.6b:free', 65_536, 8_192, 'lfm-2.5-2.6b'), free: true },
    { ...model('nvidia/nemotron-3.5-lightning:free', 1_000_000, 65_536, 'nemotron-3.5-lightning'), free: true },
    { ...model('thinkingmachines/inkling-small:free', 1_048_576, 262_144, 'inkling-small'), free: true, capabilities: ['text', 'image'] },
    { ...model('thinkingmachines/inkling:free', 1_048_576, 262_144, 'inkling'), free: true, capabilities: ['text', 'image'] },
    { ...model('poolside/laguna-s-2.1:free', 262_144, 32_768, 'laguna-s-2.1'), free: true },
    { ...model('poolside/laguna-xs-2.1:free', 262_144, 32_768, 'laguna-xs-2.1'), free: true },
    { ...model('nvidia/nemotron-3-ultra-550b-a55b:free', 1_000_000, 65_536, 'nemotron-3-ultra'), free: true },
    { ...model('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 256_000, 65_536, 'nemotron-3-nano-omni-30b-a3b-reasoning'), free: true, capabilities: ['text', 'image'] },
    { ...model('google/gemma-4-26b-a4b-it:free', 262_144, 32_768, 'gemma-4-26b-a4b-it'), free: true, capabilities: ['text', 'image'] },
    { ...model('google/gemma-4-31b-it:free', 262_144, 32_768, 'gemma-4-31b-it'), free: true, capabilities: ['text', 'image'] },
    { ...model('nvidia/nemotron-3-super-120b-a12b:free', 262_144, 235_929, 'nemotron-3-super-120b-a12b'), free: true },
  ],
  protocols: [openAI('https://openrouter.ai/api/v1/chat/completions')],
  description: 'OpenRouter 免费模型。',
  setupHint: '免费池共享 50 次/天、20 次/分钟限制；累计购买至少 $10 额度后提升至 1000 次/天。输入 OpenRouter API Key；每日剩余免费次数暂不可查询。',
});
