import { defineModel } from './define.ts';

export const nvidiaModels = [
  defineModel('nemotron-3-ultra', 'Nemotron 3 Ultra Free', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'nvidia', family: 'nemotron' }),
  defineModel('nemotron-3.5-lightning', 'Nemotron 3.5 Lightning Free', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'nvidia', family: 'nemotron' }),
  defineModel('nemotron-3-nano-omni-30b-a3b-reasoning', 'Nemotron 3 Nano Omni Free', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'nvidia', family: 'nemotron' }),
  defineModel('nemotron-3-super-120b-a12b', 'Nemotron 3 Super Free', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'nvidia', family: 'nemotron' }),
];
