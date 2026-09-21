import { defineModel } from './define.ts';

export const spacexaiModels = [
  defineModel('grok-4.6', 'Grok 4.6', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.5, 2, 6],
    speed: 59,
  }, { lab: 'spacexai', family: 'grok' }),
  defineModel('grok-4.5', 'Grok 4.5', {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 58,
  }, { lab: 'spacexai', family: 'grok' }),
];
