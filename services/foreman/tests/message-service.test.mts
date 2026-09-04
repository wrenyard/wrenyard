import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MessageService } from '../lib/message/message-service.mts'
import type { SendResult, SendError } from '../lib/message/message-service.mts'
import type { PrincipalRegistry } from '../lib/message/principal.mts'
import { CANONICAL_PRINCIPALS } from '../lib/message/principal.mts'
import type { MessageStore, IdempotencyKey } from '../lib/db/stores/message-store.mts'

function isError(result: SendResult | SendError): result is SendError {
  return 'ok' in result && result.ok === false
}

function createTestStore(): MessageStore {
  const idempotency = new Map<string, IdempotencyKey>()
  const messages = new Map<string, { id: string; from_role: string; to_role: string; conversation_id: null; body: string; format: null; created_at: string }>()
  const store = {
    createMessage(write: Parameters<MessageStore['createMessage']>[0]): void {
      messages.set(write.messageId, {
        id: write.messageId,
        from_role: write.fromRole,
        to_role: write.toRole,
        conversation_id: null,
        body: write.body,
        format: null,
        created_at: write.createdAt,
      })
    },
    createDelivery(): void {},
    markDelivered(): void {},
    markFailed(): void {},
    getMessage(messageId: string) { return messages.get(messageId) },
    listDeliveries() { return [] },
    findByClientMessageId(fromRole: string, clientMessageId: string): IdempotencyKey | null {
      return idempotency.get(`${fromRole}:${clientMessageId}`) ?? null
    },
    createClientMessageId(fromRole: string, clientMessageId: string, messageId: string, createdAt: string): boolean {
      const key = `${fromRole}:${clientMessageId}`
      if (idempotency.has(key)) return false
      idempotency.set(key, { from_role: fromRole, client_message_id: clientMessageId, message_id: messageId, result_json: null, created_at: createdAt })
      return true
    },
    storeClientMessageResult(fromRole: string, clientMessageId: string, result: unknown): void {
      const item = idempotency.get(`${fromRole}:${clientMessageId}`)
      if (item) item.result_json = JSON.stringify(result)
    },
    listPendingDeliveries() { return [] },
  }
  return store as unknown as MessageStore
}

const registry: PrincipalRegistry = {
  principals: {
    ...CANONICAL_PRINCIPALS,
    operator: {
      id: 'operator',
      kind: 'human',
      canSend: true,
      canReceive: true,
      grants: [{ name: 'message.send' }],
    },
    recipient: {
      id: 'recipient',
      kind: 'human',
      canSend: false,
      canReceive: true,
      grants: [],
      deliveryRoute: 'recipient.test',
    },
  },
  routes: {
    'recipient.test': { transport: 'system' },
  },
}

describe('MessageService routing', () => {
  it('rejects unknown and unauthorized senders', async () => {
    const service = new MessageService({ registry, store: createTestStore() })
    const unknown = await service.send({ from: 'nonexistent', to: 'recipient', text: 'hello' })
    const forbidden = await service.send({ from: 'pet', to: 'recipient', text: 'hello' })
    assert.ok(isError(unknown))
    assert.equal(unknown.error, 'unknown_principal')
    assert.ok(isError(forbidden))
    assert.equal(forbidden.error, 'forbidden')
  })

  it('delivers to configured principals exactly once for an idempotency key', async () => {
    let calls = 0
    const service = new MessageService({
      registry,
      store: createTestStore(),
      externalDelivery: {
        async deliver(deliveryId) {
          calls += 1
          return { deliveryId, status: 'delivered', ok: true }
        },
      },
    })
    const request = { from: 'operator', to: 'recipient', text: 'hello', client_message_id: 'same' }
    const first = await service.send(request)
    const replay = await service.send(request)
    assert.ok(!isError(first))
    assert.deepEqual(replay, first)
    assert.equal(calls, 1)
  })
})
