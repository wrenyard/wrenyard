import { defineModel } from './define.ts';

export const googleModels = [
  defineModel('gemini-3.8-flash', 'Gemini 3.8 Flash', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    pricing: [0.075, 0.75, 3.5],
    speed: 40,
  }, { lab: 'google', family: 'gemini' }),
  // Gemini 4 Argon. Introductory cached/input/output price [0.10, 2, 10] USD/M
  // is valid through 2026-11-30 and becomes [0.20, 4, 20] afterwards. The
  // 1,048,576 token window is shared by input/thinking/output, with a 65,536
  // synchronous streaming max output (no long-decode implementation). speed 100
  // is the rounded community figure (Artificial Analysis AI Studio High 99.5
  // tokens/s, 10K input, 72h median). Sources:
  // https://ai.google.dev/gemini-api/docs/models/gemini-4-argon
  // https://ai.google.dev/gemini-api/docs/pricing
  // https://artificialanalysis.ai/models/gemini-4-argon/providers
  defineModel('gemini-4-argon', 'Gemini 4 Argon', {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: [0.10, 2, 10],
    speed: 100,
  }, { lab: 'google', family: 'gemini' }),
  defineModel('gemma-4-26b-a4b-it', 'Gemma 4 26B A4B Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 262_144,
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'google', family: 'gemma' }),
  defineModel('gemma-4-31b-it', 'Gemma 4 31B Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 262_144,
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'google', family: 'gemma' }),
];
