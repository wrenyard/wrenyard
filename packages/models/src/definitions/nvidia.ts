import { defineModel } from './define.ts';

export const nvidiaModels = [
  // Speed 2 is the floored verified OpenRouter provider override for this exact
  // pair (measured 2.356 TPS at 2026-10-15T17:04:24.314Z, TTFT 9407 ms, via the
  // installed-daemon session sampler streamTokens / (streamMs / 1000) over a
  // short reasoning-inclusive observation, not a sustained benchmark). The
  // provider override and its provenance remain unchanged.
  defineModel('nemotron-3-ultra', 'Nemotron 3 Ultra', {
    intelligence: 'high',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    speed: 2,
  }, { lab: 'nvidia', family: 'nemotron' }),
  // Speed 97 is the floored verified OpenRouter provider override for this exact
  // pair (measured 97.345 TPS at 2026-10-15T17:03:45.852Z, TTFT 1957 ms, via the
  // installed-daemon session sampler streamTokens / (streamMs / 1000) over a
  // short reasoning-inclusive observation, not a sustained benchmark). The
  // provider override and its provenance remain unchanged.
  defineModel('nemotron-3.5-lightning', 'Nemotron 3.5 Lightning', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    speed: 97,
  }, { lab: 'nvidia', family: 'nemotron' }),
  defineModel('nemotron-3-nano-omni-30b-a3b-reasoning', 'Nemotron 3 Nano Omni Free', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    contextWindow: 256_000,
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'nvidia', family: 'nemotron' }),
  // Speed 33 is the floored verified OpenRouter provider override for this exact
  // pair (measured 33.659 TPS at 2026-10-15T17:04:28.646Z, TTFT 2002 ms, via the
  // installed-daemon session sampler streamTokens / (streamMs / 1000) over a
  // short reasoning-inclusive observation, not a sustained benchmark). The
  // provider override and its provenance remain unchanged.
  defineModel('nemotron-3-super-120b-a12b', 'Nemotron 3 Super', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 262_144,
    maxOutputTokens: 235_929,
    speed: 33,
  }, { lab: 'nvidia', family: 'nemotron' }),
  // The intelligence tier is a product classification informed by the AA
  // Intelligence Index of 26 for this model, not a tier the source publishes.
  // Speed 388 floors the AA generation rate of 388.0 tokens/s measured after
  // the first streamed chunk (https://artificialanalysis.ai/models/nemotron-3-5-super-vl).
  // This is the distinct Nemotron 3.5 Super VL 120B A12B identity, not
  // Nemotron 3 Super 120B A12B. Identity mapping:
  // https://models.opencode.ai/providers/opencode/ and the models.dev
  // canonical page. Pricing and maxOutputTokens stay absent: neither is
  // established for this identity.
  defineModel('nemotron-3.5-super-vl-120b-a12b', 'Nemotron 3.5 Super VL 120B A12B', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    speed: 388,
  }, { lab: 'nvidia', family: 'nemotron' }),
];
