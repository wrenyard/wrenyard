import { defineModel } from './define.ts';

export const moonshotModels = [
  defineModel('kimi-k2.5', 'Kimi K2.5', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 262_144,
    pricing: [0.003, 0.15, 0.6],
    speed: 40,
  }, { lab: 'moonshot', family: 'kimi' }),
  defineModel('kimi-k2.6', 'Kimi K2.6', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 262_144,
    pricing: [0.003, 0.15, 0.6],
    speed: 56,
  }, { lab: 'moonshot', family: 'kimi' }),
  defineModel('kimi-k2.8', 'Kimi K2.8 Preview', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    pricing: [0.003, 0.15, 0.6],
    speed: 40,
  }, { lab: 'moonshot', family: 'kimi' }),
  defineModel('kimi-k3.1-pro', 'Kimi K3.1 Pro', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    pricing: [0.2, 2, 10],
    speed: 40,
  }, { lab: 'moonshot', family: 'kimi' }),
  defineModel('kimi-k3', 'Kimi K3', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    pricing: [0.3, 3, 15],
    speed: 40,
  }, { lab: 'moonshot', family: 'kimi' }),
];
