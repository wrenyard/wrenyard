import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JsonRpcClient, type JsonRpcClientTransport } from '../../lib/client/jsonrpc-client.mts'
import {
  INVALID_PARAMS,
  OPERATION_TIMEOUT,
  ProtocolError,
} from '../../lib/protocol/errors.mts'
import {
  createErrorResponse,
  createSuccessResponse,
} from '../../lib/protocol/validate.mts'
import { decodeFrame, encodeFrame } from '../../lib/transport/ndjson.mts'

class FakeTransport implements JsonRpcClientTransport {
  readonly frames: string[] = []

  send(frame: string): void {
    this.frames.push(frame)
  }

  lastMessage(): unknown {
    const frame = this.frames.at(-1)
    assert(frame)
    return decodeFrame(frame.trimEnd())
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('JsonRpcClient', () => {
  it('request() sends a JSON-RPC 2.0 request', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      idFactory: () => 'request-1',
    })

    const promise = client.request('task.create', { prompt: 'hello' })

    assert.deepEqual(transport.lastMessage(), {
      jsonrpc: '2.0',
      method: 'task.create',
      params: { prompt: 'hello' },
      id: 'request-1',
    })
    assert.equal(client.pendingCount, 1)

    client.handleIncoming(encodeFrame(createSuccessResponse('request-1', { taskId: 'task-1' })))
    assert.deepEqual(await promise, { taskId: 'task-1' })
    assert.equal(client.pendingCount, 0)
  })

  it('request() resolves when a matching success response arrives', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      idFactory: () => 7,
    })

    const promise = client.request('health.ping', {})

    client.handleIncoming(encodeFrame(createSuccessResponse(7, { ok: true })))

    assert.deepEqual(await promise, { ok: true })
    assert.equal(client.pendingCount, 0)
  })

  it('request() rejects when a matching error response arrives', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      idFactory: () => 'bad-request',
    })

    const promise = client.request('task.create', {})

    client.handleIncoming(encodeFrame(createErrorResponse('bad-request', INVALID_PARAMS)))

    await assert.rejects(
      promise,
      (error) => {
        assert(error instanceof ProtocolError)
        assert.equal(error.code, INVALID_PARAMS.code)
        assert.equal(error.message, INVALID_PARAMS.message)
        return true
      },
    )
    assert.equal(client.pendingCount, 0)
  })

  it('notify() sends a JSON-RPC notification without creating pending state', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({ transport })

    await client.notify('message.send', { to: 'relay', text: 'hello' })

    assert.deepEqual(transport.lastMessage(), {
      jsonrpc: '2.0',
      method: 'message.send',
      params: { to: 'relay', text: 'hello' },
    })
    assert.equal(client.pendingCount, 0)
  })

  it('ignores responses with unknown ids', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      idFactory: () => 'known',
    })

    const promise = client.request('health.ping', {})

    client.handleIncoming(encodeFrame(createSuccessResponse('unknown', { ok: false })))
    assert.equal(client.pendingCount, 1)

    client.handleIncoming(encodeFrame(createSuccessResponse('known', { ok: true })))
    assert.deepEqual(await promise, { ok: true })
    assert.equal(client.pendingCount, 0)
  })

  it('times out pending requests and cleans up state', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      timeoutMs: 5,
      idFactory: () => 'slow',
    })

    const promise = client.request('health.ping', {})
    assert.equal(client.pendingCount, 1)

    await assert.rejects(
      promise,
      (error) => {
        assert(error instanceof ProtocolError)
        assert.equal(error.code, OPERATION_TIMEOUT.code)
        return true
      },
    )
    assert.equal(client.pendingCount, 0)
  })

  it('does not resolve a timed-out request from a late response', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      timeoutMs: 5,
      idFactory: () => 'late',
    })

    await assert.rejects(client.request('health.ping', {}))
    client.handleIncoming(encodeFrame(createSuccessResponse('late', { ok: true })))
    await delay(1)

    assert.equal(client.pendingCount, 0)
  })

  it('close() rejects pending requests and clears state', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      idFactory: () => 'closing',
    })

    const promise = client.request('health.ping', {})
    assert.equal(client.pendingCount, 1)

    client.close()

    await assert.rejects(promise, /JsonRpcClient closed/)
    assert.equal(client.pendingCount, 0)
  })

  it('dispose() rejects pending requests and clears state', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      transport,
      idFactory: () => 'disposing',
    })

    const promise = client.request('health.ping', {})
    assert.equal(client.pendingCount, 1)

    client.dispose()

    await assert.rejects(promise, /JsonRpcClient disposed/)
    assert.equal(client.pendingCount, 0)
  })
})
