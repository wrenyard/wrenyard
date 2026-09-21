import { defineModel } from './define.ts';
import { THINKING_LOW_HIGH_MAX } from '../types.ts';

export const deepseekModels = [
  defineModel('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    contextWindow: 1_000_000,
    maxOutputTokens: 50_000,
    pricing: [0.006, 0.3, 1.2],
    speed: 201,
  }, { lab: 'deepseek', family: 'deepseek-v4.1' }),
  defineModel('deepseek-pro', 'DeepSeek V4 Pro', {
    intelligence: 'mid',
    capabilities: ['text'],
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    pricing: [0.044, 1.32, 3.96],
    speed: 20,
  }, { lab: 'deepseek', family: 'deepseek-v4' }),
];
