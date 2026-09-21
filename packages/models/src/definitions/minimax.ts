import { defineModel } from './define.ts';

export const minimaxModels = [
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
