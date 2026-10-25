import { defineModel } from './define.ts';

export const xiaomiModels = [
  defineModel('mimo-v2.5', 'OpenCode Zen Mimo v2.5 Free', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 1_048_576,
    pricing: [0.003, 0.15, 0.6],
    speed: 29,
  }, { lab: 'xiaomi', family: 'mimo' }),
  // Speed defaults for the entries below are initial catalog estimates pending local measured samples.
  // Reasoning effort is route-owned: providers declare the levels they materialize, never the registry.
  defineModel('mimo-v2.6-pro', 'MiMo V2.6 Pro', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.0036, 0.435, 0.87],
    speed: 40,
  }, { lab: 'xiaomi', family: 'mimo' }),
  // The intelligence tier is a product classification informed by the AA
  // Intelligence Index of 38 for MiMo, not a tier the source publishes. Speed
  // 51 floors the AA generation rate of 51.9 tokens/s measured after the first
  // streamed chunk (https://artificialanalysis.ai/models/mimo-v2-6-flash).
  // Identity mapping: https://models.opencode.ai/providers/opencode/ and the
  // models.dev MiMo family page.
  defineModel('mimo-v2.6-flash', 'MiMo V2.6 Flash', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    pricing: [0.0028, 0.14, 0.28],
    speed: 51,
  }, { lab: 'xiaomi', family: 'mimo' }),
  defineModel('mimo-v2.6-pro-ultraspeed', 'MiMo V2.6 Pro Ultraspeed', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.036, 4.35, 8.7],
    speed: 80,
  }, { lab: 'xiaomi', family: 'mimo' }),
];
