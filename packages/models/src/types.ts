export type IntelligenceTier = 'low' | 'mid' | 'high' | 'premium';
export type ModelCapability = 'text' | 'image';
export type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const INTELLIGENCE_TIERS = ['low', 'mid', 'high', 'premium'] as const;
export const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** USD per million tokens: [cached, input, output]. */
export type ModelPricing = readonly [number, number, number];

export interface ModelNativeAttributes {
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: readonly ModelCapability[];
  thinkingLevels?: readonly ThinkingLevel[];
}

export interface ModelDefaults {
  intelligence: IntelligenceTier;
  capabilities: readonly ModelCapability[];
  thinkingLevels?: readonly ThinkingLevel[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing: ModelPricing;
  speed: number;
}

export interface RegisteredModel {
  id: string;
  displayName: string;
  lab: string;
  family?: string;
  version?: string;
  native?: ModelNativeAttributes;
  defaults: ModelDefaults;
}

export const THINKING_LOW_HIGH_MAX: readonly ThinkingLevel[] = ['low', 'high', 'max'];
export const THINKING_FULL: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const THINKING_UP_TO_XHIGH: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh'];
