import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MessageService } from '../lib/message/message-service.mts'
import type { SendResult, SendError } from '../lib/message/message-service.mts'
import type { PrincipalRegistry } from '../lib/message/principal.mts'
import { CANONICAL_PRINCIPALS } from '../lib/message/principal.mts'
import type { MessageStore, IdempotencyKey } from '../lib/db/stores/message-store.mts'

function isError(r: SendResult | SendError): r is SendError {
  return 'ok' in r && r.ok === false
}

// In-memory stub matching the real MessageStore contracts
function createTestStore(): MessageStore {
  const idempotencyMap = new Map<string, IdempotencyKey>()
  const deliveries: Array<{ id: string; status: string; last_error: string | null }> = []
  const store = {
    createMessage(_write: Parameters<MessageStore['createMessage']>[0]): void {},
    createDelivery(_write: Parameters<MessageStore['createDelivery']>[0]): void {},
    markDelivered(_id: string, _at: string): void {},
    markFailed(_id: string, _error: string, _at: string): void {},
    getMessage(messageId: string) {
      return { id: messageId, from_role: 'test', to_role: 'test', conversation_id: null, body: 'test', format: null, created_at: new Date().toISOString() }
    },
    listDeliveries(_messageId: string) {
      return deliveries as any
    },
    findByClientMessageId(fromRole: string, clientMessageId: string): IdempotencyKey | null {
      const key = `${fromRole}:${clientMessageId}`
      return idempotencyMap.get(key) ?? null
    },
    createClientMessageId(fromRole: string, clientMessageId: string, messageId: string, _createdAt: string): boolean {
      const key = `${fromRole}:${clientMessageId}`
      if (idempotencyMap.has(key)) return false
      idempotencyMap.set(key, { from_role: fromRole, client_message_id: clientMessageId, message_id: messageId, result_json: null, created_at: new Date().toISOString() })
      return true
    },
    storeClientMessageResult(fromRole: string, clientMessageId: string, result: unknown): void {
      const item = idempotencyMap.get(`${fromRole}:${clientMessageId}`)
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
      grants: [{ name: 'message.send' }, { name: 'work.read' }],
    },
  },
}

describe('MessageService routing', () => {
  it('rejects sender without message.send grant', async () => {
    const store = createTestStore()
    const svc = new MessageService({ registry, store })
    const result = await svc.send({ from: 'pet', to: 'operator', text: 'hello' })
    assert.ok(isError(result))
    assert.equal(result.error, 'forbidden')
  })

  it('rejects unknown sender', async () => {
    const store = createTestStore()
    const svc = new MessageService({ registry, store })
    const result = await svc.send({ from: 'nonexistent', to: 'operator', text: 'hello' })
    assert.ok(isError(result))
    assert.equal(result.error, 'unknown_principal')
  })

  it('rejects sending to non-addressable principal (codex)', async () => {
    const store = createTestStore()
    const svc = new MessageService({ registry, store })
    const result = await svc.send({ from: 'operator', to: 'codex', text: 'hello' })
    assert.ok(isError(result))
    assert.equal(result.error, 'not_addressable')
  })

  it('rejects sending to unknown FWA address when no FWA service', async () => {
    const store = createTestStore()
    const svc = new MessageService({ registry, store })
    const result = await svc.send({ from: 'operator', to: 'fwa-0123456789abcdef01234567', text: 'hello' })
    assert.ok(isError(result))
    assert.equal(result.error, 'unknown_agent_address')
  })

  it('rejects sending to foreman-work when no work service', async () => {
    const store = createTestStore()
    const svc = new MessageService({ registry, store })
    const result = await svc.send({ from: 'operator', to: 'foreman-work', text: 'hello' })
    assert.ok(isError(result))
    assert.equal(result.error, 'work_unavailable')
  })

  it('returns idempotent result for duplicate (from, client_message_id)', async () => {
    const store = createTestStore()
    let calls = 0
    const svc = new MessageService({
      registry,
      store,
      work: {
        async send() {
          calls++
          return { accepted: true, target_seq: 7, queue_depth: 2 }
        },
      },
    })
    const request = { from: 'operator', to: 'foreman-work', text: 'hello', client_message_id: 'test-id-123' }
    const first = await svc.send(request)
    const replay = await svc.send(request)
    assert.deepEqual(replay, first)
    assert.equal(calls, 1)
  })

  it('resolves valid FWA target when FWA service is injected', async () => {
    const store = createTestStore()
    let sentTo = ''
    const fwa = {
      hasLiveSession(_id: string) { return true },
      async sendToSession(sessionId: string, text: string, _from: string) {
        sentTo = sessionId
        return { accepted: true, target_seq: 1, queue_depth: 0 }
      },
    }

    const svc = new MessageService({ registry, store, fwa })
    const result = await svc.send({ from: 'operator', to: 'fwa-0123456789abcdef01234567', text: 'hello' })
    assert.equal(sentTo, 'fwa_0123456789abcdef01234567')
    assert.ok(!isError(result))
    assert.equal(result.accepted, true)
  })

  it('accepts a live FWA address as a sender', async () => {
    const store = createTestStore()
    let workSender = ''
    const svc = new MessageService({
      registry,
      store,
      fwa: {
        hasLiveSession: (id) => id === 'fwa_0123456789abcdef01234567',
        async sendToSession() { return { accepted: true } },
      },
      work: {
        async send(_text, from) {
          workSender = from
          return { accepted: true, target_seq: 1, queue_depth: 0 }
        },
      },
    })

    const result = await svc.send({
      from: 'fwa-0123456789abcdef01234567',
      to: 'foreman-work',
      text: 'handoff',
    })
    assert.ok(!isError(result))
    assert.equal(workSender, 'fwa-0123456789abcdef01234567')
  })

  it('rejects a closed FWA address as a sender', async () => {
    const store = createTestStore()
    const svc = new MessageService({
      registry,
      store,
      fwa: {
        hasLiveSession: () => false,
        async sendToSession() { return { accepted: true } },
      },
    })
    const result = await svc.send({
      from: 'fwa-0123456789abcdef01234567',
      to: 'foreman-work',
      text: 'stale',
    })
    assert.ok(isError(result))
    assert.equal(result.error, 'unknown_agent_address')
  })

  it('rejects FWA address with no live session', async () => {
    const store = createTestStore()
    const fwa = {
      hasLiveSession(_id: string) { return false },
      async sendToSession() { return { accepted: true } },
    }

    const svc = new MessageService({ registry, store, fwa })
    const result = await svc.send({ from: 'operator', to: 'fwa-0123456789abcdef01234567', text: 'hello' })
    assert.ok(isError(result))
    assert.equal(result.error, 'unknown_agent_address')
  })

  it('resolves foreman-work when work service is injected', async () => {
    const store = createTestStore()
    const work = {
      async send(text: string, from: string, _cid?: string) {
        return { accepted: true, target_seq: 5, queue_depth: 2 }
      },
    }

    const svc = new MessageService({ registry, store, work })
    const result = await svc.send({ from: 'operator', to: 'foreman-work', text: 'hello' })
    assert.ok(!isError(result))
    assert.equal(result.accepted, true)
  })

  it('forwards attachments to Work send port', async () => {
    const store = createTestStore()
    let receivedAttachments: unknown
    const work = {
      async send(text: string, from: string, messageId: string, attachments?: Array<{ path: string }>) {
        receivedAttachments = attachments
        return { accepted: true, target_seq: 6, queue_depth: 0, attachment_results: [{ path: '/tmp/test.png', status: 'accepted' as const, mime_type: 'image/png' }] }
      },
    }

    const svc = new MessageService({ registry, store, work })
    const result = await svc.send({ from: 'operator', to: 'foreman-work', text: 'with attachment', attachments: [{ path: '/tmp/test.png' }] })
    assert.ok(!isError(result))
    assert.deepEqual(receivedAttachments, [{ path: '/tmp/test.png' }])
    assert.ok(result.attachments)
    assert.equal((result.attachments as Array<{ path: string }>)[0].path, '/tmp/test.png')
  })

  it('rejects attachments for non-work targets', async () => {
    const store = createTestStore()
    const svc = new MessageService({ registry, store })
    const result = await svc.send({ from: 'operator', to: 'operator', text: 'attachment to non-work', attachments: [{ path: '/tmp/test.png' }] })
    assert.ok(isError(result))
    assert.equal(result.error, 'attachments_not_supported')
  })

  it('returns mixed attachment outcomes per item', async () => {
    const store = createTestStore()
    const work = {
      async send(text: string, from: string, messageId: string, _attachments?: Array<{ path: string }>) {
        return {
          accepted: true,
          target_seq: 7,
          queue_depth: 0,
          attachment_results: [
            { path: '/tmp/valid.png', status: 'accepted' as const, mime_type: 'image/png' },
            { path: '/tmp/missing.png', status: 'rejected' as const, error: 'file_not_found' as const },
          ],
        }
      },
    }

    const svc = new MessageService({ registry, store, work })
    const result = await svc.send({
      from: 'operator',
      to: 'foreman-work',
      text: 'mixed batch',
      attachments: [{ path: '/tmp/valid.png' }, { path: '/tmp/missing.png' }],
    })
    assert.ok(!isError(result))
    assert.ok(result.attachments)
    assert.equal((result.attachments as Array<{ status: string }>)[0].status, 'accepted')
    assert.equal((result.attachments as Array<{ status: string }>)[1].status, 'rejected')
  })

  it('idempotent replay returns identical attachment metadata without second Work call', async () => {
    const store = createTestStore()
    let callCount = 0
    const work = {
      async send(text: string, from: string, messageId: string, _attachments?: Array<{ path: string }>) {
        callCount++
        return {
          accepted: true,
          target_seq: 8,
          queue_depth: 0,
          attachment_results: [{ path: '/tmp/test.png', status: 'accepted' as const, mime_type: 'image/png' }],
        }
      },
    }

    const svc = new MessageService({ registry, store, work })
    const request = { from: 'operator', to: 'foreman-work', text: 'replay test', client_message_id: 'idem-attach-1', attachments: [{ path: '/tmp/test.png' }] }
    const first = await svc.send(request)
    const replay = await svc.send(request)
    assert.equal(callCount, 1)
    assert.deepEqual(replay, first)
    assert.ok((replay as SendResult).attachments)
    assert.equal((replay as SendResult).attachments![0].status, 'accepted')
  })
})
