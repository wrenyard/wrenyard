import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { AgentEventStore } from '../lib/core/agent/agent-event-store.mts'
import { AgentGraphProjector } from '../lib/core/agent/agent-graph-projector.mts'
import { closeDb, initDb } from '../lib/db/connection.mts'
import { bootstrapSchema } from '../lib/db/schema.mts'

describe('AgentGraphProjector', () => {
  const address = 'foreman-work'
  let store: AgentEventStore
  let projector: AgentGraphProjector

  before(() => {
    const db = initDb(':memory:')
    bootstrapSchema(db)
    store = new AgentEventStore(db)
    store.createOrGetConversation({ address, kind: 'work', model: 'test' })
    projector = new AgentGraphProjector(store)
  })

  after(() => closeDb())

  it('persists snapshot and patch proposal projections beside raw tool events', async () => {
    const inspectCall = store.appendEvent({
      address,
      kind: 'tool_call',
      payload: { tool_call_id: 'inspect-1', tool_name: 'taskgraph_inspect', args: { taskgraph_id: 'tg-1' } },
    })
    projector.observe({
      address,
      kind: 'tool_call',
      payload: { tool_call_id: 'inspect-1', tool_name: 'taskgraph_inspect', args: { taskgraph_id: 'tg-1' } },
      rawSeq: inspectCall,
    })
    const inspectResult = store.appendEvent({
      address,
      kind: 'tool_result',
      payload: { tool_call_id: 'inspect-1', content: JSON.stringify({ graph: { id: 'tg-1', revision: 1, nodes: {} } }) },
    })
    projector.observe({
      address,
      kind: 'tool_result',
      payload: { tool_call_id: 'inspect-1', content: JSON.stringify({ graph: { id: 'tg-1', revision: 1, nodes: {} } }) },
      rawSeq: inspectResult,
    })

    const patchPayload = {
      tool_call_id: 'patch-1',
      tool_name: 'taskgraph_patch',
      args: { taskgraph_id: 'tg-1', operation: { type: 'request_patch', patch: { base_revision: 1 } } },
    }
    const patchCall = store.appendEvent({ address, kind: 'tool_call', payload: patchPayload })
    projector.observe({ address, kind: 'tool_call', payload: patchPayload, rawSeq: patchCall })
    const patchResultPayload = {
      tool_call_id: 'patch-1',
      content: JSON.stringify({ type: 'preview', patch_id: 'preview-1', graph: { id: 'tg-1', revision: 2, nodes: {} } }),
    }
    const patchResult = store.appendEvent({ address, kind: 'tool_result', payload: patchResultPayload })
    projector.observe({ address, kind: 'tool_result', payload: patchResultPayload, rawSeq: patchResult })
    projector.appendStatus({
      address,
      graphId: 'tg-1',
      patchId: 'preview-1',
      decision: 'reject',
      status: 'rejected',
      clientActionId: 'review-1',
    })

    const events = await store.sync({ address, after_seq: 0, wait_ms: 0 })
    assert.deepEqual(
      events.events.filter((event) => event.kind.startsWith('graph_')).map((event) => event.kind),
      ['graph_snapshot', 'graph_patch_proposal', 'graph_patch_status'],
    )
    const status = events.events.find((event) => event.kind === 'graph_patch_status')
    assert.equal((status?.payload as Record<string, unknown>).decision, 'reject')
  })
})
