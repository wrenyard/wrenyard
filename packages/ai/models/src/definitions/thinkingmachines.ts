import { defineModel } from './define.ts';

export const thinkingmachinesModels = [
  defineModel('inkling-small', 'Inkling Small Free', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'thinkingmachines', family: 'inkling' }),
  defineModel('inkling', 'Inkling Free', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'thinkingmachines', family: 'inkling' }),
];
