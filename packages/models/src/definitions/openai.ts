import { defineModel } from './define.ts';

export const openaiModels = [
  defineModel('gpt-6-astra', 'GPT 6 Astra', {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    maxOutputTokens: 128_000,
    pricing: [1, 10, 50],
    speed: 51,
  }, { lab: 'openai', family: 'gpt-6' }),
  // Speed defaults for the entries below are initial catalog estimates pending local measured samples.
  defineModel('gpt-6-sol', 'GPT 6 Sol', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: [0.2, 2, 10],
    speed: 63,
  }, { lab: 'openai', family: 'gpt-6' }),
  defineModel('gpt-6-luna', 'GPT 6 Luna', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: [0.01, 0.1, 0.5],
    speed: 107,
  }, { lab: 'openai', family: 'gpt-6' }),
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  // Initial speed estimate retains Sol's catalog baseline pending local measured samples.
  defineModel('gpt-6.1-sol', 'GPT 6.1 Sol', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: [0.1, 2, 10],
    speed: 63,
  }, { lab: 'openai', family: 'gpt-6' }),
  defineModel('gpt-5.6-sol', 'GPT 5.6 Sol', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.4, 4, 20],
    speed: 63,
  }, { lab: 'openai', family: 'gpt-5.6' }),
  defineModel('gpt-5.6-terra', 'GPT 5.6 Terra', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.2, 2, 12],
    speed: 98,
  }, { lab: 'openai', family: 'gpt-5.6' }),
  defineModel('gpt-5.6-luna', 'GPT 5.6 Luna', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.02, 0.2, 1.2],
    speed: 107,
  }, { lab: 'openai', family: 'gpt-5.6' }),
  defineModel('gpt-5.5', 'GPT 5.5', {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: [0.5, 5, 30],
    speed: 89,
  }, { lab: 'openai', family: 'gpt-5.5' }),
  defineModel('gpt-5.4', 'GPT 5.4', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.25, 2.5, 15],
    speed: 140,
  }, { lab: 'openai', family: 'gpt-5.4' }),
];
