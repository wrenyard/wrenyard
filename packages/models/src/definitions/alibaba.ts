import { defineModel } from './define.ts';

export const alibabaModels = [
  defineModel('qwen3.8-max', 'Qwen3.8 Max', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 39,
  }, { lab: 'alibaba', family: 'qwen' }),
  defineModel('qwen3.7-plus', 'Qwen3.7 Plus', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 56,
  }, { lab: 'alibaba', family: 'qwen' }),
  defineModel('qwen3.7-flash', 'Qwen3.7 Flash', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 111,
  }, { lab: 'alibaba', family: 'qwen' }),
  defineModel('qwen3.6-plus', 'Qwen3.6 Plus', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 56,
  }, { lab: 'alibaba', family: 'qwen' }),
  defineModel('qwen3.5-plus', 'Qwen3.5 Plus', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 54,
  }, { lab: 'alibaba', family: 'qwen' }),
  defineModel('qwen3-coder-next', 'Qwen3 Coder Next', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 128,
  }, { lab: 'alibaba', family: 'qwen-coder' }),
  defineModel('qwen3-coder-plus', 'Qwen3 Coder Plus', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 29,
  }, { lab: 'alibaba', family: 'qwen-coder' }),
  defineModel('qwen3.8-27b', 'Qwen3.8 27B Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'alibaba', family: 'qwen' }),
];
