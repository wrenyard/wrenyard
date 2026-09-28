import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  JsonRpcClient,
  WRENYARD_PROTOCOL_VERSION,
  type JsonRpcClientTransport,
} from '@wrenyard/control-client/transport'
import {
  INVALID_PARAMS,
  OPERATION_TIMEOUT,
  ProtocolError,
} from '../../lib/protocol/errors.mts'
import {
  createErrorResponse,
  createSuccessResponse,
} from '../../lib/protocol/validate.mts'
import { decodeFrame, encodeFrame } from '@wrenyard/control-client/transport'

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
      handshake: false,
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
      handshake: false,
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
      handshake: false,
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
    const client = new JsonRpcClient({ handshake: false, transport })

    await client.notify('health.ping', {})

    assert.deepEqual(transport.lastMessage(), {
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
    })
    assert.equal(client.pendingCount, 0)
  })

  it('ignores responses with unknown ids', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      handshake: false,
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
      handshake: false,
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
      handshake: false,
      transport,
      timeoutMs: 5,
      idFactory: () => 'late',
    })

    await assert.rejects(client.request('health.ping', {}))
    client.handleIncoming(encodeFrame(createSuccessResponse('late', { ok: true })))
    await delay(1)

    assert.equal(client.pendingCount, 0)
  })

  it('request() honors timeoutMs:null and stays pending past the default boundary', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      handshake: false,
      transport,
      timeoutMs: 10,
      idFactory: () => 'no-deadline',
    })

    const promise = client.request('task.run.wait', {}, { timeoutMs: null })
    assert.equal(client.pendingCount, 1)

    // The client's short default boundary (10ms) elapses without a timer
    // rejecting the request because timeoutMs:null disables the client timer.
    await delay(25)
    assert.equal(client.pendingCount, 1)

    client.handleIncoming(encodeFrame(createSuccessResponse('no-deadline', { ok: true })))
    assert.deepEqual(await promise, { ok: true })
    assert.equal(client.pendingCount, 0)
  })

  it('close() rejects pending requests and clears state', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({
      handshake: false,
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
      handshake: false,
      transport,
      idFactory: () => 'disposing',
    })

    const promise = client.request('health.ping', {})
    assert.equal(client.pendingCount, 1)

    client.dispose()

    await assert.rejects(promise, /JsonRpcClient disposed/)
    assert.equal(client.pendingCount, 0)
  })

  it('completes the version-tagged handshake once before the first business request', async () => {
    const transport = new FakeTransport()
    let nextId = 0
    const client = new JsonRpcClient({ transport, idFactory: () => `id-${nextId++}` })

    const first = client.request('task.run.list', {})
    await delay(0)
    assert.deepEqual(transport.lastMessage(), {
      jsonrpc: '2.0',
      method: 'health.ping',
      params: { protocolVersion: WRENYARD_PROTOCOL_VERSION },
      id: 'id-0',
    })
    client.handleIncoming(encodeFrame(createSuccessResponse('id-0', { ok: true, protocolVersion: WRENYARD_PROTOCOL_VERSION })))
    await delay(0)
    assert.equal((transport.lastMessage() as { method: string }).method, 'task.run.list')
    client.handleIncoming(encodeFrame(createSuccessResponse('id-1', { items: [] })))
    assert.deepEqual(await first, { items: [] })

    const second = client.request('task.run.list', {})
    await delay(0)
    assert.equal(transport.frames.length, 3, 'the handshake is not repeated')
    client.handleIncoming(encodeFrame(createSuccessResponse('id-2', { items: [] })))
    await second
  })

  it('fails closed on a daemon without a matching protocolVersion', async () => {
    const transport = new FakeTransport()
    const client = new JsonRpcClient({ transport, idFactory: () => 'handshake' })

    const request = client.request('task.run.list', {})
    await delay(0)
    client.handleIncoming(encodeFrame(createSuccessResponse('handshake', { ok: true })))

    await assert.rejects(request, /daemon/)
    assert.equal(transport.frames.length, 1, 'no business request reaches an incompatible daemon')
    await assert.rejects(client.request('task.run.list', {}), /daemon/)
  })
})
