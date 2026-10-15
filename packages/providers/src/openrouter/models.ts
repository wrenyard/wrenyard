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
    model('google/gemini-4-argon', undefined, undefined, 'gemini-4-argon', ['low', 'medium', 'high']),
    { ...model('nex-agi/nex-n2.5-mini:free', 262_144, 235_929, 'nex-n2.5-mini'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('nex-agi/nex-n2.5-pro:free', 262_144, 235_929, 'nex-n2.5-pro'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('cohere/north-mini-code:free', 256_000, 64_000, 'north-mini-code'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('inclusionai/ling-3.0-flash-vl:free', 262_144, 32_768, 'ling-3.0-flash-vl'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('inclusionai/ling-3.0-flash-sante:free', 262_144, 32_768, 'ling-3.0-flash-sante'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('inclusionai/ling-3.0-flash-fin:free', 262_144, 32_768, 'ling-3.0-flash-fin'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('qwen/qwen3.8-27b:free', 262_144, 235_929, 'qwen3.8-27b'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('dots-studio/dots-3-note-preview:free', 512_000, 460_800, 'dots-3-note-preview'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('liquid/lfm-2.5-2.6b:free', 65_536, 8_192, 'lfm-2.5-2.6b'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('nvidia/nemotron-3.5-lightning:free', 1_000_000, 65_536, 'nemotron-3.5-lightning'), free: true, reasoningEfforts: ['default'] },
    { ...model('thinkingmachines/inkling-small:free', 1_048_576, 262_144, 'inkling-small'), free: true, capabilities: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high', 'max'] },
    { ...model('thinkingmachines/inkling:free', 1_048_576, 262_144, 'inkling'), free: true, capabilities: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high', 'max'] },
    { ...model('poolside/laguna-s-2.1:free', 262_144, 32_768, 'laguna-s-2.1'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('poolside/laguna-xs-2.1:free', 262_144, 32_768, 'laguna-xs-2.1'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('nvidia/nemotron-3-ultra-550b-a55b:free', 1_000_000, 65_536, 'nemotron-3-ultra'), free: true, reasoningEfforts: ['default'] },
    { ...model('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 256_000, 65_536, 'nemotron-3-nano-omni-30b-a3b-reasoning'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('google/gemma-4-26b-a4b-it:free', 262_144, 32_768, 'gemma-4-26b-a4b-it'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('google/gemma-4-31b-it:free', 262_144, 32_768, 'gemma-4-31b-it'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('nvidia/nemotron-3-super-120b-a12b:free', 262_144, 235_929, 'nemotron-3-super-120b-a12b'), free: true, reasoningEfforts: ['default'] },
  ],
  // Initial measured TPS, recorded only after real verification: measured on the
  // installed daemon 1.0.65 from real session
  // f42a6c7d-729b-461d-b148-4ff02e12133d. Sampler formula:
  // TPS = streamTokens / (streamMs / 1000). These are short PONG /
  // short reasoning-inclusive initial observations, not sustained text
  // benchmarks, and they do not establish intelligence. See
  // docs/free-mainstream-models.md.
  // Catalog.validateSpeed requires a positive integer, so each stored value is
  // the measured TPS floored; the exact measured value is kept in its comment.
  modelSpeedOverrides: {
    // measured 97.345 TPS, 2026-10-15T17:03:45.852Z, TTFT 1957 ms, floored to 97
    'nvidia/nemotron-3.5-lightning:free': 97,
    // measured 2.356 TPS, 2026-10-15T17:04:24.314Z, TTFT 9407 ms, floored to 2
    'nvidia/nemotron-3-ultra-550b-a55b:free': 2,
    // measured 33.659 TPS, 2026-10-15T17:04:28.646Z, TTFT 2002 ms, floored to 33
    'nvidia/nemotron-3-super-120b-a12b:free': 33,
  },
  // Provenance of the measured override above: the initial measured TPS and
  // when/how it was measured. These never replace the integer override, which
  // stays the routing fact.
  modelSpeedMeasurements: {
    'nvidia/nemotron-3.5-lightning:free': {
      initialTps: 97.345,
      measuredAt: '2026-10-15T17:03:45.852Z',
      method: 'installed daemon 1.0.65 session sampler, streamTokens / (streamMs / 1000) over a short reasoning-inclusive PONG observation (not a sustained benchmark)',
    },
    'nvidia/nemotron-3-ultra-550b-a55b:free': {
      initialTps: 2.356,
      measuredAt: '2026-10-15T17:04:24.314Z',
      method: 'installed daemon 1.0.65 session sampler, streamTokens / (streamMs / 1000) over a short reasoning-inclusive PONG observation (not a sustained benchmark)',
    },
    'nvidia/nemotron-3-super-120b-a12b:free': {
      initialTps: 33.659,
      measuredAt: '2026-10-15T17:04:28.646Z',
      method: 'installed daemon 1.0.65 session sampler, streamTokens / (streamMs / 1000) over a short reasoning-inclusive PONG observation (not a sustained benchmark)',
    },
  },
  protocols: [openAI('https://openrouter.ai/api/v1/chat/completions')],
  // OpenRouter free requests must not carry a model fallback list or route
  // object, which would let the client select a paid model. The exact free
  // model id is preserved; no fallback, retry, or substitution is added.
  beforeRequest: (context) => {
    delete context.body.models;
    delete context.body.route;
  },
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol !== 'openai_chat') throw new Error('OpenRouter only exposes Chat Completions');
    // The provider-default sentinel keeps upstream behavior for rows whose
    // source confirms reasoning support without a specific effort ladder, so
    // no fabricated effort should be serialized.
    if (effort === 'default') return {};
    return { reasoning: { effort } };
  },
  description: 'OpenRouter 免费与付费模型。',
  setupHint: '免费池共享 50 次/天、20 次/分钟限制；累计购买至少 $10 额度后提升至 1000 次/天。付费模型使用账户余额。输入 OpenRouter API Key；每日剩余免费次数暂不可查询。',
});
