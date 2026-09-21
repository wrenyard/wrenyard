import { defineModel } from './define.ts';

export const inclusionaiModels = [
  defineModel('ling-3.0-flash-fin', 'Ling 3.0 Flash Fin Free', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 119,
  }, { lab: 'inclusionai', family: 'ling' }),
  defineModel('ling-3.0-flash-vl', 'Ling 3.0 Flash VL Free', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'inclusionai', family: 'ling' }),
  defineModel('ling-3.0-flash-sante', 'Ling 3.0 Flash Sante Free', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'inclusionai', family: 'ling' }),
];
