import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { INVALID_PARAMS } from '../../lib/protocol/errors.mts'
import type { MessageService } from '../../lib/message/message-service.mts'

function makeJsonRpcRequest(method: string, params: Record<string, unknown>, id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id })
}

describe('message.send sender binding', () => {
  it('uses context sender when present, ignoring conflicting params.sender', async () => {
    const router = new RpcRouter()
    const sent: Array<{ from: string }> = []
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      messageService: {
        send(req: Parameters<MessageService['send']>[0]) {
          sent.push(req)
          return { message_id: 'mid-1', accepted: true }
        },
      } as unknown as MessageService,
    })

    const response = await router.handleMessage(
      makeJsonRpcRequest('message.send', { sender: 'operator', to: 'fwa-0123456789abcdef01234567', text: 'hi' }, 1),
      { sender: { role: 'codex' } },
    )

    const result = (response as { result: { message_id: string; accepted: boolean } }).result
    assert.equal(sent[0].from, 'codex')
    assert.equal(result.accepted, true)
  })

  it('rejects when context sender exists but has no role, even with params.sender', async () => {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      messageService: {
        send(_req: Parameters<MessageService['send']>[0]) {
          return { message_id: 'mid-2', accepted: true }
        },
      } as unknown as MessageService,
    })

    const response = await router.handleMessage(
      makeJsonRpcRequest('message.send', { sender: 'operator', to: 'fwa-0123456789abcdef01234567', text: 'hi' }, 2),
      { sender: {} },
    )

    const err = (response as { error: { code: number; message?: string } }).error
    assert.equal(err.code, INVALID_PARAMS.code)
  })

  it('falls back to params.sender when context has no sender', async () => {
    const router = new RpcRouter()
    const sent: Array<{ from: string }> = []
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      messageService: {
        send(req: Parameters<MessageService['send']>[0]) {
          sent.push(req)
          return { message_id: 'mid-3', accepted: true }
        },
      } as unknown as MessageService,
    })

    const response = await router.handleMessage(
      makeJsonRpcRequest('message.send', { sender: 'relay', to: 'fwa-0123456789abcdef01234567', text: 'hello' }, 3),
      {},
    )

    const result = (response as { result: { message_id: string; accepted: boolean } }).result
    assert.equal(sent[0].from, 'relay')
    assert.equal(result.accepted, true)
  })

  it('rejects when neither context nor params provide a sender', async () => {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      messageService: {
        send(_req: Parameters<MessageService['send']>[0]) {
          return { message_id: 'mid-4', accepted: true }
        },
      } as unknown as MessageService,
    })

    const response = await router.handleMessage(
      makeJsonRpcRequest('message.send', { to: 'fwa-0123456789abcdef01234567', text: 'hi' }, 4),
      {},
    )

    const err = (response as { error: { code: number; message?: string } }).error
    assert.equal(err.code, INVALID_PARAMS.code)
  })

  it('forwards attachments to messageService.send', async () => {
    const router = new RpcRouter()
    const sent: Array<Record<string, unknown>> = []
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      messageService: {
        send(req: Parameters<MessageService['send']>[0]) {
          sent.push(req as unknown as Record<string, unknown>)
          return { message_id: 'mid-5', accepted: true, attachments: [{ path: '/tmp/test.png', status: 'accepted', mime_type: 'image/png' }] }
        },
      } as unknown as MessageService,
    })

    const response = await router.handleMessage(
      makeJsonRpcRequest('message.send', {
        sender: 'codex',
        to: 'foreman-work',
        text: 'check this image',
        attachments: [{ path: '/tmp/test.png' }],
      }, 5),
      {},
    )

    const result = (response as { result: { message_id: string; accepted: boolean; attachments?: Array<unknown> } }).result
    assert.equal(result.accepted, true)
    assert.ok(result.attachments)
    assert.equal((result.attachments as Array<{ path: string }>)[0].path, '/tmp/test.png')
  })

  it('rejects malformed attachment descriptors with INVALID_PARAMS', async () => {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      messageService: {
        send(_req: Parameters<MessageService['send']>[0]) {
          return { message_id: 'mid-6', accepted: true }
        },
      } as unknown as MessageService,
    })

    // Attachment without path should be caught by JSON schema
    const response = await router.handleMessage(
      makeJsonRpcRequest('message.send', {
        sender: 'codex',
        to: 'foreman-work',
        text: 'bad attachment',
        attachments: [{ not_path: '/tmp/test.png' }],
      }, 6),
      {},
    )

    const err = (response as { error: { code: number; message?: string } }).error
    assert.equal(err.code, INVALID_PARAMS.code)
  })
})
