import { defineModel } from './define.ts';

export const spacexaiModels = [
  defineModel('grok-4.7', 'Grok 4.7', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 500_000,
    pricing: [0.5, 2, 6],
    speed: 59,
  }, {
    lab: 'spacexai',
    family: 'grok',
    native: {
      contextWindow: 500_000,
      capabilities: ['text', 'image'],
    },
  }),
  defineModel('grok-4.6', 'Grok 4.6', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.5, 2, 6],
    speed: 59,
  }, { lab: 'spacexai', family: 'grok' }),
];
