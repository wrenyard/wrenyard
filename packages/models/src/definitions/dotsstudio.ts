import { defineModel } from './define.ts';

export const dotsstudioModels = [
  defineModel('dots-3-note-preview', 'Dots3 Note Preview Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'dotsstudio', family: 'dots' }),
];
