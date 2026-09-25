import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { readProcessIdentity, registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { DispatchControl } from '../../lib/daemon/dispatch-control.mts'
import { PlannedRestartStore } from '../../lib/daemon/planned-restart-store.mts'
import { INVALID_PARAMS } from '../../lib/protocol/errors.mts'
import type { MessageService } from '../../lib/message/message-service.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

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

describe('health.ping process identity', () => {
  it('reports installed by default and source fields from the source-dev env', () => {
    assert.equal(readProcessIdentity({}).mode, 'installed')
    assert.deepEqual(readProcessIdentity({
      WRENYARD_SOURCE_DEV: '1',
      WRENYARD_SOURCE_CHECKOUT: '/src',
    }), {
      mode: 'source',
      checkout: '/src',
      node: process.execPath,
    })
  })

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

describe('daemon.status idle reporting', () => {
  it('daemon.status reports idle only when an isIdle option is provided', async () => {
    initTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'wy-daemon-status-'))
    try {
      const control = new DispatchControl(new PlannedRestartStore(dir))

      const withIdle = new RpcRouter()
      registerCoreHandlers(withIdle, {
        startedAt: Date.now(),
        workspaceRoot: '/tmp',
        dispatchControl: control,
        isIdle: async () => false,
      })
      const idleResponse = await withIdle.handleMessage(makeJsonRpcRequest('daemon.status', {}, 11), {})
      const idleResult = (idleResponse as { result: { idle?: boolean } }).result
      assert.equal(idleResult.idle, false)

      const withoutIdle = new RpcRouter()
      registerCoreHandlers(withoutIdle, {
        startedAt: Date.now(),
        workspaceRoot: '/tmp',
        dispatchControl: control,
      })
      const plainResponse = await withoutIdle.handleMessage(makeJsonRpcRequest('daemon.status', {}, 12), {})
      const plainResult = (plainResponse as { result: Record<string, unknown> }).result
      assert.equal('idle' in plainResult, false)
    } finally {
      closeTestDb()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
