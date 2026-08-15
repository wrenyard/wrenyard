import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ForemanEventBus } from '../../lib/events/event-bus.mts'
import type { ForemanEvent } from '../../lib/events/event-types.mts'

describe('ForemanEventBus', () => {
  it('fan-outs internal events and isolates failing sinks', async () => {
    const bus = new ForemanEventBus()
    const seen: ForemanEvent[] = []
    bus.subscribe({
      handle: (event) => {
        seen.push(event)
      },
    })
    bus.subscribe({
      handle: () => {
        throw new Error('sink failed')
      },
    })

    await bus.publish(event())

    assert.equal(seen.length, 1)
    assert.equal(seen[0].kind, 'task.run.completed')
  })
})

function event(): ForemanEvent {
  return {
    id: 'evt_test',
    kind: 'task.run.completed',
    source: 'test',
    severity: 'success',
    refs: { taskId: 'task_1', project: 'workspace' },
    data: { taskName: 'demo', output: { result: 'ok' } },
    occurredAt: '2026-07-01T00:00:00.000Z',
  }
}
