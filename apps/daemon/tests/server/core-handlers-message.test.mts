import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
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
})

describe('health.ping process identity', () => {
  it('includes identity on health.ping', async () => {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now() - 25,
      workspaceRoot: '/tmp',
    })
    const previousFlag = process.env.WRENYARD_SOURCE_DEV
    process.env.WRENYARD_SOURCE_DEV = '1'
    try {
      const response = await router.handleMessage(makeJsonRpcRequest('health.ping', {}, 9), {})
      const result = (response as { result: { identity: { mode: string } } }).result
      assert.equal(result.identity.mode, 'source')
    } finally {
      if (previousFlag === undefined) delete process.env.WRENYARD_SOURCE_DEV
      else process.env.WRENYARD_SOURCE_DEV = previousFlag
    }
  })
})

describe('daemon.status lifecycle reporting', () => {
  it('daemon.status projects shutting_down, idle and the active counts', async () => {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: '/tmp',
      isIdle: async () => false,
      isShuttingDown: () => true,
      daemonActiveWork: () => ({ activeTaskCount: 2, activeWorkflowCount: 1, activeExecutionCount: 3 }),
    })
    const response = await router.handleMessage(makeJsonRpcRequest('daemon.status', {}, 11), {})
    const result = (response as { result: Record<string, unknown> }).result
    assert.equal(result.ok, true)
    assert.equal(result.shutting_down, true)
    assert.equal(result.idle, false)
    assert.equal(result.activeTaskCount, 2)
    assert.equal(result.activeWorkflowCount, 1)
    assert.equal(result.activeExecutionCount, 3)
  })
})
