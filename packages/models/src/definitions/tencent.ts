import { defineModel } from './define.ts';

export const tencentModels = [
  defineModel('hunyuan-hy3', 'HY3', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.035, 0.139, 0.556],
    speed: 94,
  }, { lab: 'tencent', family: 'hunyuan' }),
  defineModel('hunyuan-hy4-preview', 'HY4 Preview', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.042, 0.834, 2.501],
    speed: 38,
  }, { lab: 'tencent', family: 'hunyuan' }),
];
