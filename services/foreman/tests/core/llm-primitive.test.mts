import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  llm,
  setLlmPrimitive,
} from '../../lib/core/operations/primitives/llm.mts'
import type { LlmInput } from '../../lib/types.mts'

afterEach(() => {
  setLlmPrimitive(undefined)
})

describe('llm primitive', () => {
  it('delegates to the injected runtime implementation', async () => {
    const calls: Array<{ input: LlmInput; model?: string; maxTokens?: number }> = []
    setLlmPrimitive(async (input, opts = {}) => {
      calls.push({ input, model: opts.model, maxTokens: opts.maxTokens })
      return 'runtime response'
    })

    const result = await llm('classify', { model: 'kimi-for-coding', maxTokens: 16 })

    assert.equal(result, 'runtime response')
    assert.deepEqual(calls, [{ input: 'classify', model: 'kimi-for-coding', maxTokens: 16 }])
  })

  it('fails clearly before the daemon injects an implementation', async () => {
    await assert.rejects(
      () => llm('classify'),
      /LLM primitive has not been injected/u,
    )
  })

  it('forwards a native request-body object and protocol option unchanged', async () => {
    const calls: Array<{ input: unknown; protocol?: string }> = []
    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }
    setLlmPrimitive(async (input, opts = {}) => {
      calls.push({ input, protocol: opts.protocol })
      return 'runtime response'
    })

    const result = await llm(body, { protocol: 'openai' })

    assert.equal(result, 'runtime response')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].input, body)
    assert.equal(calls[0].protocol, 'openai')
  })
})
