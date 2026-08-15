import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { normalizeMessageConfig } from '../lib/config/index.mts'
import { MessageStore } from '../lib/db/stores/message-store.mts'
import { MessageService } from '../lib/message/message-service.mts'
import { closeTestDb, initTestDb } from './helpers/test-db.mts'

afterEach(() => closeTestDb())

describe('message routing', () => {
  it('normalizes canonical principals and external routes', () => {
    const config = normalizeMessageConfig({
      principals: {
        operator: {
          name: 'operator',
          delivery_route: 'operator.telegram',
          can_send: true,
          can_receive: true,
          grants: ['message.send', 'work.read'],
        },
      },
      routes: {
        'operator.telegram': { transport: 'telegram', address: { chat_id: '123' } },
      },
    })
    assert.equal(config.principals.codex.canSend, true)
    assert.equal(config.principals.codex.canReceive, false)
    assert.equal(config.principals['foreman-work'].canReceive, true)
    assert.equal(config.routes?.['operator.telegram'].transport, 'telegram')
  })

  it('persists and delivers a principal-addressed message once', async () => {
    const db = initTestDb()
    const store = new MessageStore(db)
    let calls = 0
    const service = new MessageService({
      registry: normalizeMessageConfig({
        principals: {
          operator: {
            name: 'operator',
            delivery_route: 'operator.telegram',
            can_send: true,
            can_receive: true,
            grants: ['message.send', 'work.read'],
          },
        },
        routes: { 'operator.telegram': { transport: 'telegram' } },
      }),
      store,
      externalDelivery: {
        async deliver(deliveryId) {
          calls++
          store.markDelivered(deliveryId, new Date().toISOString())
          return { deliveryId, status: 'delivered', ok: true }
        },
      },
    })

    const first = await service.send({
      from: 'codex',
      to: 'operator',
      text: 'finished',
      client_message_id: 'once',
    })
    const replay = await service.send({
      from: 'codex',
      to: 'operator',
      text: 'finished',
      client_message_id: 'once',
    })

    assert.equal(calls, 1)
    assert.equal('message_id' in first && 'message_id' in replay ? first.message_id : undefined, 'message_id' in replay ? replay.message_id : undefined)
    assert.equal('delivery' in first && first.delivery?.status, 'delivered')
  })

  it('records external delivery failure without deleting the message', async () => {
    const db = initTestDb()
    const store = new MessageStore(db)
    const service = new MessageService({
      registry: normalizeMessageConfig({
        principals: {
          operator: {
            name: 'operator',
            delivery_route: 'operator.telegram',
            can_send: true,
            can_receive: true,
            grants: ['message.send', 'work.read'],
          },
        },
        routes: { 'operator.telegram': { transport: 'telegram' } },
      }),
      store,
      externalDelivery: {
        async deliver(deliveryId) {
          store.markFailed(deliveryId, 'gateway down', new Date().toISOString())
          return { deliveryId, status: 'failed', ok: false, error: 'gateway down' }
        },
      },
    })

    const result = await service.send({ from: 'codex', to: 'operator', text: 'notify me' })
    assert.equal('delivery' in result && result.delivery?.status, 'failed')
    assert.equal('message_id' in result && store.getMessage(result.message_id)?.body, 'notify me')
  })
})
