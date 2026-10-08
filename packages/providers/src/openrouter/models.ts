import { defineProvider, model, openAI } from '../base/model-defaults.ts';
import type { ReasoningEffort } from '../base/index.ts';

// OpenRouter forwards a public effort through the OpenAI-style `reasoning`
// object. Forced-thinking GPT/Claude/Qwen rows expose no `none` level; every
// other row still declares a conservative non-empty ladder.
const REASONING_WITHOUT_NONE: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_BASIC: readonly ReasoningEffort[] = ['medium'];

export const definition = defineProvider({
  id: 'openrouter', displayName: 'OpenRouter', credentialResolver: 'managed', defaultModel: 'nex-agi/nex-n2.5-mini:free',
  models: [
    model('anthropic/claude-sonnet-5.5', undefined, undefined, 'claude-sonnet-5-5', REASONING_WITHOUT_NONE),
    model('openai/gpt-6.1-sol', undefined, undefined, 'gpt-6.1-sol', REASONING_WITHOUT_NONE),
    { ...model('nex-agi/nex-n2.5-mini:free', 262_144, 235_929, 'nex-n2.5-mini'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('nex-agi/nex-n2.5-pro:free', 262_144, 235_929, 'nex-n2.5-pro'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('cohere/north-mini-code:free', 256_000, 64_000, 'north-mini-code'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('inclusionai/ling-3.0-flash-vl:free', 262_144, 32_768, 'ling-3.0-flash-vl'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('inclusionai/ling-3.0-flash-sante:free', 262_144, 32_768, 'ling-3.0-flash-sante'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('inclusionai/ling-3.0-flash-fin:free', 262_144, 32_768, 'ling-3.0-flash-fin'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('qwen/qwen3.8-27b:free', 262_144, 235_929, 'qwen3.8-27b'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('dots-studio/dots-3-note-preview:free', 512_000, 460_800, 'dots-3-note-preview'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('liquid/lfm-2.5-2.6b:free', 65_536, 8_192, 'lfm-2.5-2.6b'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('nvidia/nemotron-3.5-lightning:free', 1_000_000, 65_536, 'nemotron-3.5-lightning'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('thinkingmachines/inkling-small:free', 1_048_576, 262_144, 'inkling-small'), free: true, capabilities: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high', 'max'] },
    { ...model('thinkingmachines/inkling:free', 1_048_576, 262_144, 'inkling'), free: true, capabilities: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high', 'max'] },
    { ...model('poolside/laguna-s-2.1:free', 262_144, 32_768, 'laguna-s-2.1'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('poolside/laguna-xs-2.1:free', 262_144, 32_768, 'laguna-xs-2.1'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('nvidia/nemotron-3-ultra-550b-a55b:free', 1_000_000, 65_536, 'nemotron-3-ultra'), free: true, reasoningEfforts: ['medium', 'high'] },
    { ...model('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 256_000, 65_536, 'nemotron-3-nano-omni-30b-a3b-reasoning'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('google/gemma-4-26b-a4b-it:free', 262_144, 32_768, 'gemma-4-26b-a4b-it'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('google/gemma-4-31b-it:free', 262_144, 32_768, 'gemma-4-31b-it'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('nvidia/nemotron-3-super-120b-a12b:free', 262_144, 235_929, 'nemotron-3-super-120b-a12b'), free: true, reasoningEfforts: ['low', 'medium'] },
  ],
  protocols: [openAI('https://openrouter.ai/api/v1/chat/completions')],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol !== 'openai_chat') throw new Error('OpenRouter only exposes Chat Completions');
    return { reasoning: { effort } };
  },
  description: 'OpenRouter 免费与付费模型。',
  setupHint: '免费池共享 50 次/天、20 次/分钟限制；累计购买至少 $10 额度后提升至 1000 次/天。付费模型使用账户余额。输入 OpenRouter API Key；每日剩余免费次数暂不可查询。',
});
