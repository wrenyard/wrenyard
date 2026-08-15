import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { AgentEventStore } from '../lib/core/agent/agent-event-store.mts'
import { AgentHandlerService } from '../lib/core/agent/agent-handler-service.mts'
import { closeDb, initDb } from '../lib/db/connection.mts'
import { bootstrapSchema } from '../lib/db/schema.mts'

describe('AgentHandlerService graph review', () => {
  let store: AgentEventStore
  let service: AgentHandlerService
  const work = 'foreman-work'
  const fwa = 'fwa-0123456789abcdef01234567'

  before(() => {
    const db = initDb(':memory:')
    bootstrapSchema(db)
    store = new AgentEventStore(db)
    store.createOrGetConversation({ address: work, kind: 'work', model: 'test' })
    store.createOrGetConversation({ address: fwa, kind: 'fwa', model: 'test' })
    service = new AgentHandlerService(store)
    service.setGraphReviewPort({
      async confirm() { return { type: 'applied' } },
      async reject() { return true },
    })
  })

  after(() => closeDb())

  it('confirms Work patches and rejects FWA patches through the same port', async () => {
    const confirmed = await service.graphReview({
      address: work,
      graph_id: 'tg-1',
      patch_id: 'patch-1',
      decision: 'confirm',
      client_action_id: 'action-1',
    })
    const rejected = await service.graphReview({
      address: fwa,
      graph_id: 'tg-2',
      patch_id: 'patch-2',
      decision: 'reject',
      client_action_id: 'action-2',
    })
    assert.deepEqual(confirmed, { status: 'confirmed' })
    assert.deepEqual(rejected, { status: 'rejected' })

    const workEvents = await store.sync({ address: work, after_seq: 0 })
    const fwaEvents = await store.sync({ address: fwa, after_seq: 0 })
    assert.equal(workEvents.events[0].kind, 'graph_patch_status')
    assert.equal((fwaEvents.events[0].payload as Record<string, unknown>).status, 'rejected')
  })

  it('rejects review for a conversation address that does not exist', async () => {
    const result = await service.graphReview({
      address: 'fwa-ffffffffffffffffffffffff',
      graph_id: 'tg-1',
      patch_id: 'patch-1',
      decision: 'confirm',
      client_action_id: 'action-3',
    })
    assert.deepEqual(result, { status: 'unknown_agent_address' })
  })
})

describe('AgentHandlerService model switching', () => {
  const work = 'foreman-work'

  function createService(port: {
    modelList: () => { current: string; available: string[] }
    modelSet: (address: string, model: string) => { current: string; available: string[] }
  }): AgentHandlerService {
    const db = initDb(':memory:')
    bootstrapSchema(db)
    const handler = new AgentHandlerService(new AgentEventStore(db))
    handler.setWorkPort({
      compact: () => ({ compact_seq: 0, covers_through_seq: 0 }),
      getStatus: () => 'idle',
      getQueueDepth: () => 0,
      modelList: port.modelList,
      modelSet: port.modelSet,
    })
    return handler
  }

  it('model.list returns current and available from the work port', async () => {
    const handler = createService({
      modelList: () => ({ current: 'a', available: ['a', 'b'] }),
      modelSet: () => ({ current: 'a', available: ['a', 'b'] }),
    })
    assert.deepEqual(await handler.modelList(), { current: 'a', available: ['a', 'b'] })
  })

  it('model.set delegates to the work port for foreman-work', async () => {
    const handler = createService({
      modelList: () => ({ current: 'a', available: ['a', 'b'] }),
      modelSet: (address, model) => {
        assert.equal(address, work)
        assert.equal(model, 'b')
        return { current: 'b', available: ['a', 'b'] }
      },
    })
    assert.deepEqual(await handler.modelSet({ address: work, model: 'b' }), {
      ok: true,
      current: 'b',
      available: ['a', 'b'],
    })
  })

  it('model.set rejects a model outside the available list with a clear error', async () => {
    const handler = createService({
      modelList: () => ({ current: 'a', available: ['a', 'b'] }),
      modelSet: () => {
        throw new Error("model 'zzz' is not available; available models: [a, b]")
      },
    })
    const result = await handler.modelSet({ address: work, model: 'zzz' })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /not available/)
    // The current model is unchanged and still reported to the caller.
    assert.equal(result.current, 'a')
    assert.deepEqual(result.available, ['a', 'b'])
  })

  it('model.set rejects addresses other than foreman-work', async () => {
    const handler = createService({
      modelList: () => ({ current: 'a', available: ['a', 'b'] }),
      modelSet: () => ({ current: 'a', available: ['a', 'b'] }),
    })
    const result = await handler.modelSet({ address: 'fwa-other', model: 'b' })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /foreman-work/)
  })

  it('model.list and model.set fail clearly when no work port is bound', async () => {
    const db = initDb(':memory:')
    bootstrapSchema(db)
    const handler = new AgentHandlerService(new AgentEventStore(db))
    await assert.rejects(() => handler.modelList(), /not running/)
    const setResult = await handler.modelSet({ address: work, model: 'b' })
    assert.equal(setResult.ok, false)
    assert.match(setResult.error ?? '', /not running/)
  })
})
