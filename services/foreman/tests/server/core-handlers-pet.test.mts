import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { INVALID_PARAMS, METHOD_NOT_FOUND } from '../../lib/protocol/errors.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'

describe('core RPC pet handlers', () => {
  it('allows daemon.shutdown only from IPC context', async () => {
    const router = new RpcRouter()
    const reasons: string[] = []
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: process.cwd(),
      shutdown: (reason) => {
        reasons.push(reason)
      },
    })

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'daemon.shutdown',
      params: { reason: 'test shutdown' },
      id: 'daemon-shutdown',
    }, { transport: 'ipc' })

    assert.deepEqual((response as { result?: unknown }).result, {
      ok: true,
      shutting_down: true,
      reason: 'test shutdown',
    })
    assert.deepEqual(reasons, [])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(reasons, ['test shutdown'])
  })

  it('rejects daemon.shutdown from non-IPC transports', async () => {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: process.cwd(),
      shutdown: () => {},
    })

    for (const transport of ['http', 'mcp'] as const) {
      const response = await router.handleMessage({
        jsonrpc: '2.0',
        method: 'daemon.shutdown',
        params: {},
        id: `daemon-shutdown-${transport}`,
      }, { transport })

      assert.equal((response as { error?: { code?: number } }).error?.code, INVALID_PARAMS.code)
    }
  })

  it('routes pet lifecycle control to daemon-owned pet service', async () => {
    const router = new RpcRouter()
    const calls: string[] = []
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: process.cwd(),
      petService: {
        async start() {
          calls.push('start')
        },
        async stop() {
          calls.push('stop')
        },
        async restart() {
          calls.push('restart')
        },
        status() {
          return {
            state: calls.length > 0 ? 'running' : 'stopped',
            enabled: calls.length > 0,
            running: calls.length > 0,
            transport: 'ipc-jsonrpc',
            command: 'npm',
            args: ['start'],
            cwd: process.cwd(),
          }
        },
      } as any,
    })

    const start = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'pet.start',
      params: {},
      id: 'pet-start',
    })
    const status = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'pet.status',
      params: {},
      id: 'pet-status',
    })

    assert.deepEqual(calls, ['start'])
    assert.deepEqual((start as { result?: unknown }).result, {
      ok: true,
      status: {
        state: 'running',
        enabled: true,
        running: true,
        transport: 'ipc-jsonrpc',
        command: 'npm',
        args: ['start'],
        cwd: process.cwd(),
      },
    })
    assert.deepEqual((status as { result?: unknown }).result, {
      state: 'running',
      enabled: true,
      running: true,
      transport: 'ipc-jsonrpc',
      command: 'npm',
      args: ['start'],
      cwd: process.cwd(),
    })
  })

  it('does not register pet control methods without daemon pet service', async () => {
    const router = new RpcRouter()
    registerCoreHandlers(router, {
      startedAt: Date.now(),
      workspaceRoot: process.cwd(),
    })

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'pet.status',
      params: {},
      id: 'pet-status',
    })

    assert.equal((response as { error?: { code?: number } }).error?.code, METHOD_NOT_FOUND.code)
  })
})
