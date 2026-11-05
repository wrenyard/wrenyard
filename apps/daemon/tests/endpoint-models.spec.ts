import { describe, expect, it } from 'vitest'

import { parseModelList } from '../lib/daemon/services/endpoint-models.mts'
import {
  anthropicOpus55,
  gatewayHy4,
  kimiK31Pro,
  magpieCodexRoute,
  magpieRoutingGroup,
  openAiDatedGpt55,
  openAiGpt61Sol,
  zhipuChatGlm53,
  zhipuResponsesGlm53,
} from './endpoint-models.fixtures.ts'

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R4, approved cases).
describe('model list normalization', () => {
  it('reads the metadata listed for a Magpie routing group', () => {
    expect(parseModelList(magpieRoutingGroup)).toEqual([{
      id: 'group/coding',
      displayName: 'Coding Group',
      maxInputTokens: 1_048_576,
      maxOutputTokens: 1_000_000,
      reasoningEfforts: ['high'],
      inputModalities: ['text', 'image'],
    }])
  })

  it('keeps endpoint metadata over catalog defaults', () => {
    expect(parseModelList(magpieCodexRoute)).toEqual([{
      id: 'codex/gpt-6-astra',
      displayName: 'GPT 6 Astra',
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      inputModalities: ['text', 'image'],
    }])
  })

  it('reads K3.1 Pro metadata from Kimi', () => {
    expect(parseModelList(kimiK31Pro)).toEqual([{
      id: 'kimi-coding/k3.1-pro',
      displayName: 'Kimi K3.1 Pro',
      maxInputTokens: 1_048_576,
      reasoningEfforts: ['low', 'high', 'max'],
      inputModalities: ['text', 'image', 'video'],
    }])
  })

  it('fills OpenAI model metadata from the catalog', () => {
    expect(parseModelList(openAiGpt61Sol)).toEqual([{
      id: 'gpt-6.1-sol',
      displayName: 'GPT 6.1 Sol',
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      inputModalities: ['text', 'image', 'pdf'],
    }])
  })

  it('fills Zhipu Chat model metadata from the catalog', () => {
    expect(parseModelList(zhipuChatGlm53)).toEqual([{
      id: 'glm-5.3',
      displayName: 'GLM 5.3',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 131_072,
      reasoningEfforts: ['low', 'high', 'max'],
      inputModalities: ['text'],
    }])
  })

  it('reads Zhipu Responses model metadata', () => {
    expect(parseModelList(zhipuResponsesGlm53)).toEqual([{
      id: 'glm-5.3',
      displayName: 'GLM-5.3',
      maxInputTokens: 200_000,
      maxOutputTokens: 131_072,
      reasoningEfforts: ['low', 'high', 'max'],
      inputModalities: ['text'],
    }])
  })

  it('keeps the Anthropic model name and fills missing metadata', () => {
    expect(parseModelList(anthropicOpus55)).toEqual([{
      id: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      inputModalities: ['text', 'image', 'pdf'],
    }])
  })

  it('reads HY4 metadata from the Wrenyard gateway', () => {
    expect(parseModelList(gatewayHy4)).toEqual([{
      id: 'tencent/hy4',
      displayName: 'HY4',
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536,
      reasoningEfforts: ['none', 'high'],
      inputModalities: ['text', 'image'],
    }])
  })

  it('uses a 200k input limit when the model cannot be matched', () => {
    expect(parseModelList(openAiDatedGpt55)).toEqual([{
      id: 'gpt-5.5-2026-04-23',
      displayName: 'gpt-5.5-2026-04-23',
      maxInputTokens: 200_000,
      inputModalities: ['text'],
    }])
  })
})
