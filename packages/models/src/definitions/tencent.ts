import { defineModel } from './define.ts';

export const tencentModels = [
  defineModel('hunyuan-hy3', 'HY3', {
    intelligence: 'low',
    contextWindow: 200_000,
    capabilities: ['text'],
    // https://cloud.tencent.com/document/product/1823/130051 checked 2026-10-20 (hy3 max output 128k).
    maxOutputTokens: 131_072,
    pricing: [0.035, 0.139, 0.556],
    speed: 94,
  }, { lab: 'tencent', family: 'hunyuan' }),
  defineModel('hunyuan-hy4-preview', 'HY4 Preview', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 262_144,
    // https://cloud.tencent.com/document/product/1823/130051 checked 2026-10-20 (hy4-preview max output 64k).
    maxOutputTokens: 65_536,
    pricing: [0.042, 0.834, 2.501],
    speed: 38,
  }, { lab: 'tencent', family: 'hunyuan' }),
];
