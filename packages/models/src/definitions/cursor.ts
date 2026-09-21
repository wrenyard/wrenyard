import { defineModel } from './define.ts';

export const cursorModels = [
  defineModel('composer-2.5', 'Composer 2.5', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    pricing: [0.2, 0.5, 2.5],
    speed: 40,
  }, { lab: 'cursor', family: 'composer' }),
  defineModel('muse-spark-1.3', 'Muse Spark 1.3', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.15, 1.25, 4.25],
    speed: 40,
  }, { lab: 'cursor', family: 'muse' }),
];
