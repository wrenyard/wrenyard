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
      makeJsonRpcRequest('message.send', { sender: 'operator', to: 'pet', text: 'hi' }, 1),
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
      makeJsonRpcRequest('message.send', { sender: 'operator', to: 'pet', text: 'hi' }, 2),
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
      makeJsonRpcRequest('message.send', { sender: 'relay', to: 'pet', text: 'hello' }, 3),
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
      makeJsonRpcRequest('message.send', { to: 'pet', text: 'hi' }, 4),
      {},
    )

    const err = (response as { error: { code: number; message?: string } }).error
    assert.equal(err.code, INVALID_PARAMS.code)
  })

})
