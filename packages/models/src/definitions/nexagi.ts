import { defineModel } from './define.ts';

export const nexagiModels = [
  defineModel('nex-n2.5-mini', 'Nex N2.5 Mini Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 119,
  }, { lab: 'nexagi', family: 'nex' }),
  defineModel('nex-n2.5-pro', 'Nex N2.5 Pro Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'nexagi', family: 'nex' }),
];
