import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INVALID_PARAMS } from '../../lib/protocol/errors.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'

function request(id: number, method = 'client.configuration.snapshot', params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id })
}

test('client configuration handlers are available only over local IPC', async () => {
  const router = new RpcRouter()
  let calls = 0
  registerCoreHandlers(router, {
    startedAt: Date.now(),
    workspaceRoot: '/tmp',
    clientConfiguration: {
      snapshot: async () => {
        calls += 1
        return { surfaces: [], configurations: [], models: [] }
      },
      plan: async () => { throw new Error('model is not compatible with this client') },
      apply: async () => { throw new Error('unused') },
      planRestore: async () => { throw new Error('unused') },
      restore: async () => { throw new Error('unused') },
    },
  })

  const ipc = await router.handleMessage(request(1), { transport: 'ipc' })
  assert.deepEqual((ipc as { result: unknown }).result, { surfaces: [], configurations: [], models: [] })
  assert.equal(calls, 1)

  const http = await router.handleMessage(request(2), { transport: 'http' })
  assert.equal((http as { error: { code: number } }).error.code, INVALID_PARAMS.code)
  assert.equal(calls, 1)

  const rejected = await router.handleMessage(request(3, 'client.configuration.plan', {
    clientId: 'codex-shared',
    selection: { models: ['provider/model'], defaultModel: 'provider/model' },
  }), { transport: 'ipc' })
  const error = (rejected as { error: { code: number, message: string } }).error
  assert.equal(error.code, INVALID_PARAMS.code)
  assert.equal(error.message, 'model is not compatible with this client')
})
