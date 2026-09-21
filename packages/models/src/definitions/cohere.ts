import { defineModel } from './define.ts';

export const cohereModels = [
  defineModel('north-mini-code', 'North Mini Code Free', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 78,
  }, { lab: 'cohere', family: 'north' }),
];
