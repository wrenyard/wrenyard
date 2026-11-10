import { defineModel } from './define.ts';

export const minimaxModels = [
  // https://platform.minimaxi.com/docs/faq/models
  // GA id MiniMax-M3.1-Flash succeeds the M3.1 Flash Preview; thinking cannot be disabled
  // ('none'/'disabled' return HTTP 400; effort ladder low..max, default max).
  // Official pricing per 1M tokens: $0.15 input, $0.60 output, $0.015 cached.
  // Output limit 524,288 tokens; 131,072 is the documented recommended value.
  // Speed retains M3's catalog baseline as an initial estimate pending local measured samples.
  defineModel('minimax-m3.1-flash', 'MiniMax M3.1 Flash', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    pricing: [0.015, 0.15, 0.6],
    speed: 156,
  }, { lab: 'minimax', family: 'm3.1' }),
  defineModel('minimax-m3', 'MiniMax M3', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    pricing: [0.003, 0.15, 0.6],
    speed: 156,
  }, { lab: 'minimax', family: 'm3' }),
  defineModel('minimax-m2.7', 'MiniMax M2.7', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 204_800,
    pricing: [0.003, 0.15, 0.6],
    speed: 71,
  }, { lab: 'minimax', family: 'm2.7' }),
  defineModel('minimax-m2.7-highspeed', 'MiniMax M2.7 Highspeed', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 204_800,
    pricing: [0.003, 0.15, 0.6],
    speed: 100,
  }, { lab: 'minimax', family: 'm2.7' }),
];
