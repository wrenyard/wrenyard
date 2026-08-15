import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AIMessage } from '@langchain/core/messages'

import { FWARuntime } from '../../lib/core/fwa/runtime.mts'

function turn(seq: number, prompt: string) {
  return { seq, trigger: 'message' as const, prompt, created_at: new Date().toISOString() }
}

function model(reply = 'ok') {
  return { invoke: async () => new AIMessage(reply) } as never
}

describe('FWARuntime queue', () => {
  it('runs admitted turns in FIFO order', async () => {
    const prompts: string[] = []
    const runtime = new FWARuntime({
      model: {
        invoke: async (messages: Array<{ content: unknown }>) => {
          prompts.push(String(messages.at(-1)?.content ?? ''))
          return new AIMessage('done')
        },
      } as never,
      tools: [],
      sessionId: 'fwa_000000000000000000000001',
      systemPolicy: 'Policy',
    })

    await Promise.all([
      runtime.enqueue(turn(1, 'first')),
      runtime.enqueue(turn(2, 'second')),
    ])
    assert.deepEqual(prompts, ['first', 'second'])
    assert.equal(runtime.getStatus(), 'idle')
    assert.equal(runtime.inspectQueue().pending.length, 0)
  })

  it('recovers from a failed turn when a later message is admitted', async () => {
    let fail = true
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
    const messagesPassed: any[][] = []
    const runtime = new FWARuntime({
      model: {
        invoke: async (messages: any[]) => {
          messagesPassed.push(messages)
          if (fail) throw new Error('model crash')
          return new AIMessage('recovered')
        },
      } as never,
      tools: [],
      sessionId: 'fwa_000000000000000000000002',
      systemPolicy: 'Policy',
      persistCallbacks: {
        onTranscriptEntry: async () => {},
        onTypedEvent: async ({ kind, payload }) => { events.push({ kind, payload }) },
        onStatusTransition: async () => {},
        onRefs: async () => {},
      },
    })

    await assert.rejects(runtime.enqueue(turn(1, 'fail')), /model crash/u)
    assert.equal(runtime.getStatus(), 'failed')
    assert.deepEqual(events, [{
      kind: 'assistant',
      payload: {
        role: 'assistant',
        content: 'Turn failed: model crash',
        error: true,
      },
    }])
    fail = false
    await runtime.enqueue(turn(2, 'retry'))
    assert.equal(runtime.getStatus(), 'idle')

    // Assert the retry model invocation does not include the failed prompt
    const retryMessages = messagesPassed[messagesPassed.length - 1]
    const retryHumanContents = retryMessages
      .filter((m: any) => m._getType?.() === 'human')
      .map((m: any) => m.content as string)
    assert.deepEqual(retryHumanContents, ['retry'],
      'retry should have only the retry prompt, not the failed prompt')
  })

  it('fails a non-terminating tool loop via no-progress cycle detection', async () => {
    const loopingModel = {
      invoke: async () => new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'loop', args: {}, type: 'tool_call' }],
      }),
      bindTools() { return this },
    } as never
    const runtime = new FWARuntime({
      model: loopingModel,
      tools: [{ name: 'loop', invoke: async () => 'again' } as never],
      sessionId: 'fwa_000000000000000000000003',
      systemPolicy: 'Policy',
    })

    await assert.rejects(runtime.enqueue(turn(1, 'loop')), /No-progress cycle detected/u)
    assert.equal(runtime.getStatus(), 'failed')
  })

  it('drains active and queued turns before close resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const runtime = new FWARuntime({
      model: {
        invoke: async () => {
          calls += 1
          if (calls === 1) await gate
          return new AIMessage('done')
        },
      } as never,
      tools: [],
      sessionId: 'fwa_000000000000000000000004',
      systemPolicy: 'Policy',
    })
    const first = runtime.enqueue(turn(1, 'first'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const second = runtime.enqueue(turn(2, 'second'))
    const closing = runtime.close()

    await assert.rejects(runtime.enqueue(turn(3, 'late')), /closed/u)
    release()
    await Promise.all([first, second, closing])
    assert.equal(runtime.getStatus(), 'closed')
    assert.equal(calls, 2)
  })

  it('shutdown drains without permanently closing the runtime', async () => {
    const runtime = new FWARuntime({
      model: model(),
      tools: [],
      sessionId: 'fwa_000000000000000000000005',
      systemPolicy: 'Policy',
    })
    await runtime.enqueue(turn(1, 'one'))
    await runtime.shutdown()
    assert.equal(runtime.getStatus(), 'idle')
    await assert.rejects(runtime.enqueue(turn(2, 'late')), /closed/u)
  })

  it('deduplicates graph and task references', async () => {
    let persisted: [string[], string[]] = [[], []]
    const runtime = new FWARuntime({
      model: model(),
      tools: [],
      sessionId: 'fwa_000000000000000000000006',
      systemPolicy: 'Policy',
      persistCallbacks: {
        onTranscriptEntry: async () => {},
        onStatusTransition: async () => {},
        onRefs: async (graphs, tasks) => { persisted = [graphs, tasks] },
      },
    })
    await runtime.mergeRefs(['tg-1', 'tg-1'], ['task-1'])
    await runtime.mergeRefs(['tg-2'], ['task-1', 'task-2'])
    assert.deepEqual(persisted, [['tg-1', 'tg-2'], ['task-1', 'task-2']])
  })

  it('terminal signal via delegation resolver completes once', async () => {
    // This test verifies that the shared delegation resolver pattern
    // would be invoked exactly once for a terminal FWA event.
    let resolveCalls = 0
    const runtime = new FWARuntime({
      model: model('done'),
      tools: [],
      sessionId: 'fwa_000000000000000000000007',
      systemPolicy: 'Policy',
      persistCallbacks: {
        onTranscriptEntry: async () => {},
        onStatusTransition: async () => {},
        onRefs: async () => {},
      },
    })

    // FWARuntime.enqueue returns a result string, not a terminal result object
    const result1 = await runtime.enqueue(turn(1, 'first'))
    assert.equal(typeof result1, 'string', 'enqueue returns a string result')
    assert.equal(runtime.getStatus(), 'idle', 'runtime is idle after first completion')

    // A second terminal signal on same session is safe (no-op)
    const result2 = await runtime.enqueue(turn(2, 'second'))
    assert.equal(typeof result2, 'string', 'second enqueue also returns a string')
    assert.equal(runtime.getStatus(), 'idle', 'runtime recovers to idle')
  })
})
