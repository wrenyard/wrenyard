import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFwaRawExecutor } from '../../lib/daemon/execution/fwa-raw-executor.mts'

void describe('fwa-raw-executor', () => {
  void it('strips protocol from body and passes openai opts', async () => {
    let capturedInput: unknown
    let capturedOpts: unknown
    const fakeRunner = async (input: unknown, opts: unknown) => {
      capturedInput = input
      capturedOpts = opts
      return JSON.stringify({
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      })
    }
    const executor = createFwaRawExecutor(fakeRunner as any)
    const result = await executor({
      protocol: 'openai',
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // Protocol field should NOT be in the forwarded body
    assert.ok(!('protocol' in ((capturedInput ?? {}) as Record<string, unknown>)))
    // OpenAI opts passed
    assert.deepStrictEqual((capturedOpts as Record<string, unknown>).protocol, 'openai')
    assert.deepStrictEqual((capturedOpts as Record<string, unknown>).model, 'gpt-4')
    // Valid response returned
    assert.ok(Array.isArray(result.choices))
    assert.equal(result.choices[0].message.content, 'ok')
  })

  void it('projects canonical provider/model to upstream body model and forwards transport options', async () => {
    let capturedInput: Record<string, unknown> = {}
    let capturedOpts: Record<string, unknown> = {}
    const executor = createFwaRawExecutor((async (input: unknown, opts: unknown) => {
      capturedInput = input as Record<string, unknown>
      capturedOpts = opts as Record<string, unknown>
      return JSON.stringify({
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      })
    }) as any)

    await executor({
      protocol: 'openai',
      model: 'zhipu-coding/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      timeout_ms: 90_000,
      max_retries: 2,
      retry_backoff_ms: 500,
    })

    assert.equal(capturedInput.model, 'glm-5.2')
    assert.equal(capturedOpts.model, 'zhipu-coding/glm-5.2')
    assert.equal(capturedOpts.timeoutMs, 90_000)
    assert.equal(capturedOpts.maxRetries, 2)
    assert.equal(capturedOpts.retryBackoffMs, 500)
    assert.ok(!('timeout_ms' in capturedInput))
    assert.ok(!('max_retries' in capturedInput))
    assert.ok(!('retry_backoff_ms' in capturedInput))
  })

  void it('rejects null JSON response', async () => {
    const fakeRunner = async () => 'null'
    const executor = createFwaRawExecutor(fakeRunner as any)
    await assert.rejects(
      () => executor({ protocol: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
      /invalid non-object response/,
    )
  })

  void it('rejects array JSON response', async () => {
    const fakeRunner = async () => '[]'
    const executor = createFwaRawExecutor(fakeRunner as any)
    await assert.rejects(
      () => executor({ protocol: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
      /invalid non-object response/,
    )
  })
})
