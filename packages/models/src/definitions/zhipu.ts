import { defineModel } from './define.ts';

export const zhipuModels = [
  defineModel('glm-5.3', 'GLM 5.3', {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: [0.26, 1.4, 4.4],
    speed: 64,
  }, { lab: 'zhipu', family: 'glm-5.3' }),
  defineModel('glm-5.3-flash', 'GLM 5.3 Flash', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.03, 0.15, 0.5],
    speed: 73,
  }, { lab: 'zhipu', family: 'glm-5.3' }),
  defineModel('glm-5.2', 'GLM 5.2', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.26, 1.4, 4.4],
    speed: 63,
  }, { lab: 'zhipu', family: 'glm-5.2' }),
];
