import assert from 'node:assert/strict'
import { realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { JsonRpcClient, WRENYARD_PROTOCOL_VERSION } from '@wrenyard/control-client/transport'
import {
  INVALID_PARAMS,
  ProtocolError,
} from '../../lib/protocol/errors.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import {
  connectIpcClientTransport,
  type IpcClientTransport,
} from '@wrenyard/control-client/transport'
import {
  createIpcServer,
  resolveForemanServiceIpcPath,
  type IpcServer,
} from '../../lib/control/ipc-server.mts'
import { createTestIpcEndpoint } from '../helpers/ipc-endpoint.mts'

const PING = { ok: true as const, protocolVersion: WRENYARD_PROTOCOL_VERSION }

interface IpcHarness {
  client: JsonRpcClient
  transport: IpcClientTransport
  server: IpcServer
  dir: string
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function createHarness(
  testName: string,
  router: RpcRouter,
): Promise<IpcHarness> {
  const endpoint = createTestIpcEndpoint(testName)
  const server = await createIpcServer({
    path: endpoint.path,
    onMessage: (message) => router.handleMessage(message),
  })

  const pendingChunks: Buffer[] = []
  let client: JsonRpcClient | undefined
  const transport = await connectIpcClientTransport({
    path: endpoint.path,
    timeoutMs: 1_000,
    onChunk: (chunk) => {
      if (client) {
        client.handleIncoming(chunk)
        return
      }
      pendingChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    },
  })

  client = new JsonRpcClient({
    handshake: false,
    transport,
    timeoutMs: 1_000,
  })
  for (const chunk of pendingChunks) {
    client.handleIncoming(chunk)
  }

  return {
    client,
    transport,
    server,
    dir: endpoint.dir,
  }
}

async function closeHarness(harness: IpcHarness): Promise<void> {
  harness.client.close()
  harness.transport.close()
  await harness.server.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

describe('IPC transport', () => {
  it('resolves one Wrenyard daemon IPC path by default instead of deriving identity from HTTP port', () => {
    const defaultPath = resolveForemanServiceIpcPath({})
    if (process.platform === 'win32') {
      assert.equal(defaultPath, '\\\\.\\pipe\\wrenyard')
    } else {
      assert.equal(defaultPath, join(shortTmpDir(), 'wrenyard.sock'))
    }
  })

  it('connects JsonRpcClient to RpcRouter over IPC and resolves requests', async () => {
    const router = new RpcRouter()
    router.register('health.ping', async () => PING)
    const harness = await createHarness('health', router)

    try {
      assert.deepEqual(await harness.client.request('health.ping', {}), PING)
    } finally {
      await closeHarness(harness)
    }
  })

  it('delivers notifications without creating client pending state', async () => {
    const router = new RpcRouter()
    const calls: unknown[] = []
    router.register('health.ping' as string, async (params: unknown) => {
      calls.push(params)
      return undefined
    })
    const harness = await createHarness('notification', router)

    try {
      await harness.client.notify('health.ping', {})
      await waitFor(() => calls.length === 1)

      assert.deepEqual(calls, [{}])
      assert.equal(harness.client.pendingCount, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('handles multiple requests on the same connection', async () => {
    const router = new RpcRouter()
    router.register('health.ping', async () => PING)
    const harness = await createHarness('multi', router)

    try {
      const results = await Promise.all([
        harness.client.request('health.ping', {}),
        harness.client.request('health.ping', {}),
        harness.client.request('health.ping', {}),
      ])

      assert.deepEqual(results, [PING, PING, PING])
      assert.equal(harness.client.pendingCount, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects client requests when the server returns an error response', async () => {
    const router = new RpcRouter()
    router.register('task.run.create', async () => ({
      id: 'task-1',
      task_run_id: 'task-1',
      hint: 'Use task.run.status with the same task_run_id.',
    }))
    router.register('health.ping', async () => PING)
    const harness = await createHarness('error-response', router)

    try {
      await harness.client.request('health.ping', { protocolVersion: WRENYARD_PROTOCOL_VERSION })
      await assert.rejects(
        harness.client.request('task.run.create', {}),
        (error) => {
          assert(error instanceof ProtocolError, String(error))
          assert.equal(error.code, INVALID_PARAMS.code)
          return true
        },
      )
      assert.equal(harness.client.pendingCount, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects when connecting to a missing IPC endpoint', async () => {
    const endpoint = createTestIpcEndpoint('missing')

    try {
      await assert.rejects(
        connectIpcClientTransport({
          path: endpoint.path,
          timeoutMs: 100,
          onChunk: () => {},
        }),
        /Daemon unavailable|Unable to connect|Timed out/,
      )
    } finally {
      rmSync(endpoint.dir, { recursive: true, force: true })
    }
  })

  it('removes stale Unix socket files before binding', async () => {
    if (process.platform === 'win32') return

    const endpoint = createTestIpcEndpoint('stale')
    writeFileSync(endpoint.path, 'stale socket placeholder', 'utf-8')

    const server = await createIpcServer({
      path: endpoint.path,
      onMessage: () => ({ ok: true }),
    })

    try {
      const transport = await connectIpcClientTransport({
        path: endpoint.path,
        timeoutMs: 500,
        onChunk: () => {},
      })
      transport.close()
    } finally {
      await server.close()
      rmSync(endpoint.dir, { recursive: true, force: true })
    }
  })

  it('binds Unix socket with owner-only permissions (mode 0600)', async () => {
    if (process.platform === 'win32') return

    const endpoint = createTestIpcEndpoint('perm')
    const server = await createIpcServer({
      path: endpoint.path,
      onMessage: () => ({ ok: true }),
    })

    try {
      const mode = statSync(endpoint.path).mode
      // Mask out file type bits, keep only permission bits
      const perm = mode & 0o777
      assert.equal(perm, 0o600, `expected 0600 got ${perm.toString(8)}`)
    } finally {
      await server.close()
      rmSync(endpoint.dir, { recursive: true, force: true })
    }
  })

  it('closes and disposes client/server transports without leaving pending requests', async () => {
    const router = new RpcRouter()
    router.register('health.ping', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return PING
    })
    const harness = await createHarness('close-dispose', router)

    const pending = harness.client.request('health.ping', {})
    assert.equal(harness.client.pendingCount, 1)

    harness.client.dispose()
    harness.transport.dispose()
    await harness.server.dispose()
    rmSync(harness.dir, { recursive: true, force: true })

    await assert.rejects(pending, /JsonRpcClient disposed/)
    assert.equal(harness.client.pendingCount, 0)
  })

  it('recovers from client disconnect during async handler', async () => {
    let resolveHandler!: () => void
    const handlerPending = new Promise<void>((resolve) => { resolveHandler = resolve })
    let handlerCalled = false

    const router = new RpcRouter()
    router.register('health.ping', async () => {
      handlerCalled = true
      await handlerPending
      return PING
    })

    const endpoint = createTestIpcEndpoint('async-disconnect')
    const server = await createIpcServer({
      path: endpoint.path,
      onMessage: (message) => router.handleMessage(message),
    })

    try {
      // First client: send a request, then disconnect before handler resolves
      const transport1 = await connectIpcClientTransport({
        path: endpoint.path,
        timeoutMs: 1_000,
        onChunk: () => {},
      })
      const client1 = new JsonRpcClient({ handshake: false, transport: transport1, timeoutMs: 5_000 })
      const request1 = client1.request('health.ping', {})

      await waitFor(() => handlerCalled)

      // Disconnect client1 while handler is still pending
      client1.close()
      transport1.close()

      // Release the handler — the server will attempt to write to a dead socket
      resolveHandler()

      // Let the in-flight request settle
      await request1.catch(() => {})

      // Second client must connect and succeed on the same server
      const pendingChunks2: Buffer[] = []
      let client2: JsonRpcClient | undefined
      const transport2 = await connectIpcClientTransport({
        path: endpoint.path,
        timeoutMs: 1_000,
        onChunk: (chunk) => {
          if (client2) {
            client2.handleIncoming(chunk)
            return
          }
          pendingChunks2.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        },
      })

      client2 = new JsonRpcClient({ handshake: false, transport: transport2, timeoutMs: 1_000 })
      for (const chunk of pendingChunks2) {
        client2.handleIncoming(chunk)
      }

      const result = await client2.request('health.ping', {})
      assert.deepEqual(result, PING)

      client2.close()
      transport2.close()
    } finally {
      await server.close()
      rmSync(endpoint.dir, { recursive: true, force: true })
    }
  })
})

function shortTmpDir(): string {
  if (process.platform === 'win32') return tmpdir()

  try {
    return realpathSync('/tmp')
  } catch {
    return realpathSync(tmpdir())
  }
}
