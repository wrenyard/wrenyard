import { defineModel } from './define.ts';

export const xiaomiModels = [
  defineModel('mimo-v2.5', 'OpenCode Zen Mimo v2.5 Free', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 29,
  }, { lab: 'xiaomi', family: 'mimo' }),
];
