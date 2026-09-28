import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RpcRouter } from '../../lib/server/rpc-router.mts'

describe('RpcRouter', () => {
  it('calls notification handlers without returning a response', async () => {
    const router = new RpcRouter()
    const calls: unknown[] = []
    router.register('health.ping' as string, async (params: unknown) => {
      calls.push(params)
      return undefined
    })

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
    })

    assert.equal(response, undefined)
    assert.deepEqual(calls, [{}])
  })
})
