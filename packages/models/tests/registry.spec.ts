import { describe, expect, it } from 'vitest'

import { MODEL_METADATA_GAPS, models, REASONING_EFFORTS } from '../src/index.ts'

// Exact values that catch a present-but-wrong field, not only a missing one.
const EXPECTED = {
  'gpt-6.1-sol': {
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  'glm-5.3': {
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text'],
  },
  'claude-opus-5-5': {
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  'kimi-k3.1-pro': {
    maxInputTokens: 1_048_576,
    maxOutputTokens: 1_048_576,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text', 'image', 'video'],
  },
  'hunyuan-hy4': {
    maxInputTokens: 983_010,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['none', 'high'],
    inputModalities: ['text', 'image'],
  },
  'deepseek-v4-pro': {
    maxInputTokens: 1_048_576,
    maxOutputTokens: 393_216,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text'],
  },
} as const

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R4, approved registry case).
describe('model catalog metadata', () => {
  it.each(models.list())('defines the required metadata for $id', (model) => {
    expect(model.id).toBe(model.id.trim())
    expect(model.displayName.trim()).not.toBe('')
    expect(model.lab.trim()).not.toBe('')
    const gaps = MODEL_METADATA_GAPS[model.id] ?? []
    expect(model.defaults.contextWindow).toBeGreaterThan(0)
    if (gaps.includes('maxInputTokens')) {
      expect(model.defaults.maxInputTokens).toBeUndefined()
    } else {
      expect(model.defaults.maxInputTokens).toBeGreaterThan(0)
    }
    if (gaps.includes('inputModalities')) {
      expect(model.defaults.inputModalities).toBeUndefined()
    } else {
      expect(model.defaults.inputModalities?.length).toBeGreaterThan(0)
    }
    expect(model.defaults.intelligence).toMatch(/^(low|mid|high|premium)$/u)
    expect(model.defaults.speed).toBeGreaterThan(0)
    if (gaps.includes('maxOutputTokens')) {
      expect(model.defaults.maxOutputTokens).toBeUndefined()
    } else if (model.defaults.maxOutputTokens !== undefined) {
      expect(model.defaults.maxOutputTokens).toBeGreaterThan(0)
    }
    if (gaps.includes('reasoningEfforts')) {
      expect(model.defaults.reasoningEfforts).toBeUndefined()
    } else if (model.defaults.reasoningEfforts !== undefined) {
      for (const effort of model.defaults.reasoningEfforts) {
        expect(REASONING_EFFORTS).toContain(effort)
      }
    }
    const expected = EXPECTED[model.id as keyof typeof EXPECTED]
    if (expected !== undefined) {
      expect(model.defaults.maxInputTokens).toBe(expected.maxInputTokens)
      expect(model.defaults.maxOutputTokens).toBe(expected.maxOutputTokens)
      expect(model.defaults.reasoningEfforts).toEqual(expected.reasoningEfforts)
      expect(model.defaults.inputModalities).toEqual(expected.inputModalities)
    }
  })
})
