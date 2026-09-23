import { defineModel } from './define.ts';

export const xiaomiModels = [
  defineModel('mimo-v2.5', 'OpenCode Zen Mimo v2.5 Free', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
    speed: 29,
  }, { lab: 'xiaomi', family: 'mimo' }),
  // Speed defaults for the entries below are initial catalog estimates pending local measured samples.
  // MiMo exposes thinking as on/off only, so no graded thinkingLevels are declared.
  defineModel('mimo-v2.6-pro', 'MiMo V2.6 Pro', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.0036, 0.435, 0.87],
    speed: 40,
  }, { lab: 'xiaomi', family: 'mimo' }),
  defineModel('mimo-v2.6-flash', 'MiMo V2.6 Flash', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.0028, 0.14, 0.28],
    speed: 80,
  }, { lab: 'xiaomi', family: 'mimo' }),
  defineModel('mimo-v2.6-pro-ultraspeed', 'MiMo V2.6 Pro Ultraspeed', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.036, 4.35, 8.7],
    speed: 80,
  }, { lab: 'xiaomi', family: 'mimo' }),
];
