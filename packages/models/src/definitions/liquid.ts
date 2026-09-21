import { defineModel } from './define.ts';

export const liquidModels = [
  defineModel('lfm-2.5-2.6b', 'LFM2.5 2.6B Free', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'liquid', family: 'lfm' }),
];
