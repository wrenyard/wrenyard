import { defineModel } from './define.ts';

export const poolsideModels = [
  defineModel('laguna-s-2.1', 'Laguna S 2.1 Free', {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'poolside', family: 'laguna' }),
  defineModel('laguna-xs-2.1', 'Laguna XS 2.1 Free', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'poolside', family: 'laguna' }),
];
