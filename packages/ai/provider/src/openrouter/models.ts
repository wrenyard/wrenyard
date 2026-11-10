import { defineProvider, model, openAI, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';
import type { ReasoningEffort } from '../base/index.ts';

// OpenRouter forwards a public effort through the OpenAI-style `reasoning`
// object. Forced-thinking GPT/Claude/Qwen rows expose no `none` level; every
// other row still declares a conservative non-empty ladder.
const REASONING_WITHOUT_NONE: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_BASIC: readonly ReasoningEffort[] = ['medium'];

export const definition = defineProvider({
  modelProtocols: ['openai_chat'],
  id: 'openrouter', displayName: 'OpenRouter', credentialResolver: 'managed', defaultModel: 'nex-n2.5-mini',
  models: [
    model('claude-sonnet-5-5', undefined, undefined, 'anthropic/claude-sonnet-5.5', REASONING_WITHOUT_NONE),
    model('gpt-6.1-sol', undefined, undefined, 'openai/gpt-6.1-sol', REASONING_WITHOUT_NONE),
    model('gemini-4-argon', undefined, undefined, 'google/gemini-4-argon', ['low', 'medium', 'high']),
    model('kimi-k3.1-pro', undefined, undefined, 'moonshotai/kimi-k3.1-pro', REASONING_LOW_HIGH_MAX),
    { ...model('nex-n2.5-mini', 262_144, 235_929, 'nex-agi/nex-n2.5-mini:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('nex-n2.5-pro', 262_144, 235_929, 'nex-agi/nex-n2.5-pro:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('north-mini-code', 256_000, 64_000, 'cohere/north-mini-code:free'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('ling-3.0-flash-vl', 262_144, 32_768, 'inclusionai/ling-3.0-flash-vl:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('ling-3.0-flash-sante', 262_144, 32_768, 'inclusionai/ling-3.0-flash-sante:free'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('ling-3.0-flash-fin', 262_144, 32_768, 'inclusionai/ling-3.0-flash-fin:free'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('qwen3.8-27b', 262_144, 235_929, 'qwen/qwen3.8-27b:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('dots-3-note-preview', 512_000, 460_800, 'dots-studio/dots-3-note-preview:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('lfm-2.5-2.6b', 65_536, 8_192, 'liquid/lfm-2.5-2.6b:free'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('nemotron-3.5-lightning', 1_000_000, 65_536, 'nvidia/nemotron-3.5-lightning:free'), free: true, reasoningEfforts: ['default'] },
    { ...model('inkling-small', 1_048_576, 262_144, 'thinkingmachines/inkling-small:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high', 'max'] },
    { ...model('inkling', 1_048_576, 262_144, 'thinkingmachines/inkling:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high', 'max'] },
    { ...model('laguna-s-2.1', 262_144, 32_768, 'poolside/laguna-s-2.1:free'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('laguna-xs-2.1', 262_144, 32_768, 'poolside/laguna-xs-2.1:free'), free: true, reasoningEfforts: REASONING_BASIC },
    { ...model('nemotron-3-ultra', 1_000_000, 65_536, 'nvidia/nemotron-3-ultra-550b-a55b:free'), free: true, reasoningEfforts: ['default'] },
    { ...model('nemotron-3-nano-omni-30b-a3b-reasoning', 256_000, 65_536, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('gemma-4-26b-a4b-it', 262_144, 32_768, 'google/gemma-4-26b-a4b-it:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('gemma-4-31b-it', 262_144, 32_768, 'google/gemma-4-31b-it:free'), free: true, capabilities: ['text', 'image'], reasoningEfforts: REASONING_BASIC },
    { ...model('nemotron-3-super-120b-a12b', 262_144, 235_929, 'nvidia/nemotron-3-super-120b-a12b:free'), free: true, reasoningEfforts: ['default'] },
  ],
  // Initial measured TPS, recorded only after real verification: measured on the
  // installed daemon 1.0.65 from a real session. Sampler formula:
  // TPS = streamTokens / (streamMs / 1000). These are short PONG /
  // short reasoning-inclusive initial observations, not sustained text
  // benchmarks, and they do not establish intelligence.
  // Catalog.validateSpeed requires a positive integer, so each stored value is
  // the measured TPS floored; the exact measured value is kept in its comment.
  modelSpeedOverrides: {
    // measured 97.345 TPS, 2026-10-15T17:03:45.852Z, TTFT 1957 ms, floored to 97
    'nemotron-3.5-lightning': 97,
    // measured 2.356 TPS, 2026-10-15T17:04:24.314Z, TTFT 9407 ms, floored to 2
    'nemotron-3-ultra': 2,
    // measured 33.659 TPS, 2026-10-15T17:04:28.646Z, TTFT 2002 ms, floored to 33
    'nemotron-3-super-120b-a12b': 33,
  },
  // Provenance of the measured override above: the initial measured TPS and
  // when/how it was measured. These never replace the integer override, which
  // stays the routing fact.
  modelSpeedMeasurements: {
    'nemotron-3.5-lightning': {
      initialTps: 97.345,
      measuredAt: '2026-10-15T17:03:45.852Z',
      method: 'installed daemon 1.0.65 session sampler, streamTokens / (streamMs / 1000) over a short reasoning-inclusive PONG observation (not a sustained benchmark)',
    },
    'nemotron-3-ultra': {
      initialTps: 2.356,
      measuredAt: '2026-10-15T17:04:24.314Z',
      method: 'installed daemon 1.0.65 session sampler, streamTokens / (streamMs / 1000) over a short reasoning-inclusive PONG observation (not a sustained benchmark)',
    },
    'nemotron-3-super-120b-a12b': {
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
