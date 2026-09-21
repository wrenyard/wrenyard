import { defineModel } from './define.ts';

export const thinkingmachinesModels = [
  defineModel('inkling-small', 'Inkling Small Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'thinkingmachines', family: 'inkling' }),
  defineModel('inkling', 'Inkling Free', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'thinkingmachines', family: 'inkling' }),
];
