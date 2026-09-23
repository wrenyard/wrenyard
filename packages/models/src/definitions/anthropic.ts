import { defineModel } from './define.ts';
import { THINKING_FULL } from '../types.ts';

export const anthropicModels = [
  defineModel('claude-fable-5', 'Claude Fable 5', {
    intelligence: 'premium',
    capabilities: ['text'],
    pricing: [1, 10, 50],
    speed: 63,
  }, { lab: 'anthropic', family: 'claude' }),
  defineModel('claude-fable-5-1', 'Claude Fable 5.1', {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    pricing: [0.25, 10, 50],
    speed: 40,
  }, { lab: 'anthropic', family: 'claude' }),
  defineModel('claude-opus-5', 'Claude Opus 5', {
    intelligence: 'premium',
    capabilities: ['text'],
    pricing: [0.5, 5, 25],
    speed: 50,
  }, { lab: 'anthropic', family: 'claude' }),
  // Speed default for the entry below is an initial catalog estimate pending local measured samples.
  defineModel('claude-opus-5-5', 'Claude Opus 5.5', {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    thinkingLevels: THINKING_FULL,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.2, 4, 20],
    speed: 65,
  }, { lab: 'anthropic', family: 'claude' }),
  defineModel('claude-sonnet-5', 'Claude Sonnet 5', {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.2, 2, 10],
    speed: 60,
  }, { lab: 'anthropic', family: 'claude' }),
  defineModel('claude-haiku-4-5', 'Claude Haiku 4.5', {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.1, 1, 5],
    speed: 81,
  }, { lab: 'anthropic', family: 'claude' }),
];
