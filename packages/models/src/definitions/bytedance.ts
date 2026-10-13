import { defineModel } from './define.ts';

export const bytedanceModels = [
  defineModel('doubao-seed-2-0-lite', 'Doubao Seed 2.0 Lite', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 262_144,
    pricing: [0.003, 0.15, 0.6],
    speed: 35,
  }, { lab: 'bytedance', family: 'doubao' }),
];
