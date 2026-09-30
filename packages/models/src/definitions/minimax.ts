import { defineModel } from './define.ts';
import { THINKING_FULL } from '../types.ts';

export const minimaxModels = [
  // https://platform.minimax.io/docs/guides/text-generation
  // Preview has no published token price: use the fixed DeepSeek Flash off-peak reference price.
  // Speed retains M3's catalog baseline as an initial estimate pending local measured samples.
  defineModel('minimax-m3.1-flash-preview', 'MiniMax M3.1 Flash Preview', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    thinkingLevels: THINKING_FULL,
    contextWindow: 1_000_000,
    pricing: [0.003, 0.15, 0.6],
    speed: 156,
  }, { lab: 'minimax', family: 'm3.1' }),
  defineModel('minimax-m3', 'MiniMax M3', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 156,
  }, { lab: 'minimax', family: 'm3' }),
  defineModel('minimax-m2.7', 'MiniMax M2.7', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 71,
  }, { lab: 'minimax', family: 'm2.7' }),
  defineModel('minimax-m2.7-highspeed', 'MiniMax M2.7 Highspeed', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 100,
  }, { lab: 'minimax', family: 'm2.7' }),
];
