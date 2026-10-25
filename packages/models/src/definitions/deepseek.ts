import { defineModel } from './define.ts';

export const deepseekModels = [
  // Rolling DeepSeek-V4.1-Flash-1017: https://api-docs.deepseek.com/news/news261017/
  // Limits: https://api-docs.deepseek.com/api/list-models/
  // Peak USD/1M pricing (off-peak is half): https://api-docs.deepseek.com/quick_start/pricing/
  defineModel('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    pricing: [0.006, 0.3, 1.2],
    speed: 201,
  }, { lab: 'deepseek', family: 'deepseek-v4.1' }),
  // A distinct identity, NOT an alias of the paid `deepseek-v4.1-flash` above:
  // the OpenCode free route carries its own limits (200K context / 32K output)
  // versus the paid route's 1M, so both legitimately coexist.
  // Identity, limits and free status verified against the OpenCode catalog and
  // the native OpenCode CLI catalog on 2026-10-15.
  // Speed 95 is the initial measured median of 95.58 output TPS (floored to 95),
  // measured 2026-10-15 17:00–17:02 UTC with the native OpenCode client 1.19.0
  // using the exact selector opencode/deepseek-v4.1-flash-free with default
  // reasoning and zero credentials in an isolated `env -i` environment (fresh
  // HOME/XDG config/data/state/cache). Based on 3 sequential successful samples
  // with output tokens 217/207/240 divided by the CLI aggregated text
  // part.time end-start windows 1.972/2.170/2.511 s, yielding
  // 110.04/95.39/95.58 TPS. Method note: this is an estimate from
  // chunk-granularity part timestamps, NOT token-level instrumentation.
  // Never inherit the paid model's 201.
  defineModel('deepseek-v4.1-flash-free', 'DeepSeek V4.1 Flash Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: [0, 0, 0],
    speed: 95,
    free: true,
  }, { lab: 'deepseek', family: 'deepseek-v4.1' }),
  defineModel('deepseek-v4-pro', 'DeepSeek V4 Pro', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    // https://api-docs.deepseek.com/quick_start/pricing/ checked 2026-10-20 (384K maximum output).
    maxOutputTokens: 393_216,
    pricing: [0.044, 1.32, 3.96],
    speed: 20,
  }, { lab: 'deepseek', family: 'deepseek-v4' }),
];
