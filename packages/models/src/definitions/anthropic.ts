import { defineModel } from './define.ts';

export const anthropicModels = [
  defineModel('claude-fable-5', 'Claude Fable 5', {
    intelligence: 'premium',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    pricing: [1, 10, 50],
    speed: 63,
  }, { lab: 'anthropic', family: 'claude' }),
  defineModel('claude-fable-5-1', 'Claude Fable 5.1', {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    pricing: [0.25, 10, 50],
    speed: 40,
  }, { lab: 'anthropic', family: 'claude' }),
  defineModel('claude-opus-5', 'Claude Opus 5', {
    intelligence: 'premium',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    pricing: [0.5, 5, 25],
    speed: 50,
  }, { lab: 'anthropic', family: 'claude' }),
  // Speed default for the entry below is an initial catalog estimate pending local measured samples.
  defineModel('claude-opus-5-5', 'Claude Opus 5.5', {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.2, 4, 20],
    speed: 65,
  }, { lab: 'anthropic', family: 'claude' }),
  defineModel('claude-sonnet-5', 'Claude Sonnet 5', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    pricing: [0.2, 2, 10],
    speed: 60,
  }, { lab: 'anthropic', family: 'claude' }),
  // https://platform.claude.com/docs/en/models/sonnet-5-5/overview
  // Initial speed estimate uses the vendor's 30% uplift over Sonnet 5; local samples take precedence.
  defineModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.2, 2, 10],
    speed: 78,
  }, { lab: 'anthropic', family: 'claude' }),
  // https://docs.anthropic.com/en/docs/about-claude/models/overview
  // Haiku 5.5 documented facts: 1M context window, 128K max output, adaptive thinking.
  // Pricing source (2026-10-14): https://platform.claude.com/docs/en/about-claude/pricing
  // [0.01, 0.1, 0.5] USD per million tokens is the base rate for prompts of at most 100k tokens;
  // prompts above 100k bill at [0.05, 0.5, 2.5], which this single base tuple cannot represent.
  // Speed source (2026-10-14): https://artificialanalysis.ai/models/claude-haiku-5-5-medium/providers
  // 179 is rounded from Artificial Analysis Anthropic medium-effort 178.7 output TPS, measured on the
  // 10k-input-token workload as a rolling 72-hour P50 observed 2026-10-14.
  defineModel('claude-haiku-5-5', 'Claude Haiku 5.5', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: [0.01, 0.1, 0.5],
    speed: 179,
  }, { lab: 'anthropic', family: 'claude' }),
];
