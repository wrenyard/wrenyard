import { defineModel } from './define.ts';

export const cohereModels = [
  defineModel('north-mini-code', 'North Mini Code', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 256_000,
    pricing: [0.003, 0.15, 0.6],
    speed: 78,
  }, { lab: 'cohere', family: 'north' }),
];
