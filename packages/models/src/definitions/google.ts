import { defineModel } from './define.ts';

export const googleModels = [
  defineModel('gemini-3.8-flash', 'Gemini 3.8 Flash', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.075, 0.75, 3.5],
    speed: 40,
  }, { lab: 'google', family: 'gemini' }),
  defineModel('gemma-4-26b-a4b-it', 'Gemma 4 26B A4B Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'google', family: 'gemma' }),
  defineModel('gemma-4-31b-it', 'Gemma 4 31B Free', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
    speed: 20,
  }, { lab: 'google', family: 'gemma' }),
];
