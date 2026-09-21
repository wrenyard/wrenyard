import { defineModel } from './define.ts';
import { THINKING_LOW_HIGH_MAX } from '../types.ts';

export const moonshotModels = [
  defineModel('kimi-k2.5', 'Kimi K2.5', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 40,
  }, { lab: 'moonshot', family: 'kimi' }),
  defineModel('kimi-k2.6', 'Kimi K2.6', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 56,
  }, { lab: 'moonshot', family: 'kimi' }),
  defineModel('kimi-k2.8', 'Kimi K2.8 Preview', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    pricing: [0.003, 0.15, 0.6],
    speed: 40,
  }, { lab: 'moonshot', family: 'kimi' }),
  defineModel('kimi-k3', 'Kimi K3', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    pricing: [0.3, 3, 15],
    speed: 40,
  }, { lab: 'moonshot', family: 'kimi' }),
];
