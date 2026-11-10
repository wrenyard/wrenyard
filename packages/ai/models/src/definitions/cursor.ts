import { defineModel } from './define.ts';

export const cursorModels = [
  defineModel('muse-spark-1.3', 'Muse Spark 1.3', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 300_000,
    pricing: [0.15, 1.25, 4.25],
    speed: 40,
  }, { lab: 'cursor', family: 'muse' }),
];
