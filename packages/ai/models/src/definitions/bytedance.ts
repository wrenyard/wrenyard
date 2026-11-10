import { defineModel } from './define.ts';

export const bytedanceModels = [
  defineModel('doubao-seed-2-0-lite', 'Doubao Seed 2.0 Lite', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 262_144,
    // https://www.volcengine.com/docs/82379/1330310 checked 2026-10-20 (max answer 128k; default answer length 4k).
    maxOutputTokens: 131_072,
    pricing: [0.003, 0.15, 0.6],
    speed: 35,
  }, { lab: 'bytedance', family: 'doubao' }),
];
