import { defineModel } from './define.ts';

export const opencodeModels = [
  defineModel('big-pickle', 'Big Pickle Free', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'opencode', family: 'pickle' }),
  defineModel('union-alpha', 'Union Alpha Free', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'opencode', family: 'union' }),
];
