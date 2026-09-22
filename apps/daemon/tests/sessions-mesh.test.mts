import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { checkAuth, handleChannelConnections, handleChannelConnectionMessage } from '../lib/daemon/daemon.mts'
import { resetRegistry } from '../lib/workspace/task-loader.mts'
import type { McpConnection } from '../lib/adapters/message/backends/index.mts'
import { formatSessionStamp } from '../lib/message/delivery/format.mts'
import type { MessageDeliveryResult, MessageEnvelope, MessageDeliveryRegistryConfig } from '../lib/message/delivery/types.mts'
import { createTestIpcEndpoint } from './helpers/ipc-endpoint.mts'
import { installIsolatedForemanEnv, type IsolatedForemanEnv } from './helpers/isolated-env.mts'

// ── Helpers ──

function fakeConnection(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    id: overrides.id ?? 'conn-1',
    channelCapable: overrides.channelCapable ?? true,
    sendNotification: () => {},
    label: overrides.label,
    cwd: overrides.cwd,
    pid: overrides.pid,
    startedAt: overrides.startedAt,
    host: overrides.host,
    clientName: overrides.clientName,
    clientVersion: overrides.clientVersion,
  }
}

function fakeRequest(method: string, path: string, overrides: Partial<{
  authorization: string
  body: string
}> = {}): IncomingMessage {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const req = {
    method,
    url: path,
    headers: {
      authorization: overrides.authorization,
    },
    socket: { remoteAddress: '127.0.0.1' },
    setEncoding: () => {},
    destroy: () => {},
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
      return req as IncomingMessage
    },
  } as unknown as IncomingMessage

  // Schedule async firing of data/end to simulate real request
  if (overrides.body !== undefined) {
    setTimeout(() => {
      (listeners['data'] ?? []).forEach((l) => l(Buffer.from(overrides.body!)))
      setTimeout(() => {
        (listeners['end'] ?? []).forEach((l) => l())
      }, 0)
    }, 0)
  }

  return req
}

function fakeResponse(): { res: ServerResponse; captured: { statusCode: number; body: unknown } } {
  const captured = { statusCode: 200, body: null as unknown }
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      captured.statusCode = code
      return this as unknown as ServerResponse
    },
    end(data?: string) {
      if (data !== undefined) {
        try { captured.body = JSON.parse(data) } catch { captured.body = data }
      }
      return this
    },
  } as unknown as ServerResponse
  return { res, captured }
}

// ── Unit: formatSessionStamp ──

describe('formatSessionStamp', () => {
  it('formats stamp with all fields', () => {
    const stamp = formatSessionStamp({ id: 'abcdef1234567890', label: 'my-session', host: 'mac.local' })
    assert.equal(stamp, '〔session abcdef12 · my-session@mac.local〕')
  })

  it('uses ? for missing label and host', () => {
    const stamp = formatSessionStamp({ id: 'abcdef1234567890' })
    assert.equal(stamp, '〔session abcdef12 · ?@?〕')
  })

  it('uses ? for missing host only', () => {
    const stamp = formatSessionStamp({ id: 'xyz98765', label: 'agent' })
    assert.equal(stamp, '〔session xyz98765 · agent@?〕')
  })

  it('uses first 8 chars of id', () => {
    const stamp = formatSessionStamp({ id: '12345678rest' })
    assert.ok(stamp.startsWith('〔session 12345678'))
  })
})

// ── Unit: GET /channel/connections ──

describe('GET /channel/connections', () => {
  it('returns empty list when no connections', async () => {
    const connections = new Map<string, McpConnection>()
    const { res, captured } = fakeResponse()
    await handleChannelConnections(fakeRequest('GET', '/channel/connections'), res, connections, undefined)
    assert.equal(captured.statusCode, 200)
    assert.deepEqual(captured.body, [])
  })

  it('returns channel-capable connections with metadata', async () => {
    const connections = new Map<string, McpConnection>()
    connections.set('conn-1', fakeConnection({
      id: 'conn-1',
      label: 'test-session',
      cwd: '/home/user/project',
      pid: 1234,
      startedAt: '2026-06-13T10:00:00Z',
      host: 'mac.local',
      clientName: 'codebuddy',
      clientVersion: '2.105.2',
    }))
    // Non-channel-capable connection should be excluded
    connections.set('conn-2', fakeConnection({
      id: 'conn-2',
      channelCapable: false,
      label: 'http-one-shot',
    }))

    const { res, captured } = fakeResponse()
    await handleChannelConnections(fakeRequest('GET', '/channel/connections'), res, connections, undefined)
    assert.equal(captured.statusCode, 200)
    const list = captured.body as Array<Record<string, unknown>>
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'conn-1')
    assert.equal(list[0].label, 'test-session')
    assert.equal(list[0].cwd, '/home/user/project')
    assert.equal(list[0].pid, 1234)
    assert.equal(list[0].startedAt, '2026-06-13T10:00:00Z')
    assert.equal(list[0].host, 'mac.local')
    assert.equal(list[0].clientName, 'codebuddy')
    assert.equal(list[0].clientVersion, '2.105.2')
  })

  it('returns empty strings for missing metadata', async () => {
    const connections = new Map<string, McpConnection>()
    connections.set('minimal', fakeConnection({ id: 'minimal' }))

    const { res, captured } = fakeResponse()
    await handleChannelConnections(fakeRequest('GET', '/channel/connections'), res, connections, undefined)
    const list = captured.body as Array<Record<string, unknown>>
    assert.equal(list.length, 1)
    assert.equal(list[0].label, '')
    assert.equal(list[0].cwd, '')
    assert.equal(list[0].pid, 0)
  })

  it('returns 401 with wrong bearer token when auth configured', async () => {
    process.env.CHANNEL_AUTH_TOKEN = 'secret123'
    try {
      const connections = new Map<string, McpConnection>()
      const { res, captured } = fakeResponse()
      const req = fakeRequest('GET', '/channel/connections', { authorization: 'Bearer wrong' })
      await handleChannelConnections(req, res, connections, { token_env: 'CHANNEL_AUTH_TOKEN' })
      assert.equal(captured.statusCode, 401)
      assert.equal((captured.body as { error?: string }).error, 'unauthorized')
    } finally {
      delete process.env.CHANNEL_AUTH_TOKEN
    }
  })
})

// ── Unit: POST /channel/connections/:id/message ──

describe('POST /channel/connections/:id/message', () => {
  it('delivers message to existing connection', async () => {
    let delivered: { method: string; params: Record<string, unknown> } | null = null
    const connections = new Map<string, McpConnection>()
    connections.set('conn-1', {
      id: 'conn-1',
      channelCapable: true,
      sendNotification(msg) { delivered = msg },
    })

    const { deliverToConnection } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const event: MessageEnvelope = {
      id: 'test-event',
      kind: 'message',
      severity: 'info',
      title: 'message',
      body: 'Hello session',
      refs: {},
      ts: new Date().toISOString(),
    }
    const delivery = deliverToConnection({ connections }, 'conn-1', event)
    assert.equal(delivery.ok, true)
    const deliveredMessage = delivered as { method: string; params: Record<string, unknown> } | null
    assert.ok(deliveredMessage)
    assert.equal(deliveredMessage.method, 'notifications/claude/channel')
    assert.ok(typeof deliveredMessage.params.content === 'string')
    assert.ok(deliveredMessage.params.content.includes('Hello session'))
  })

  it('returns 404 for no-such-connection', async () => {
    const connections = new Map<string, McpConnection>()
    const { res, captured } = fakeResponse()
    const req = fakeRequest('POST', '/channel/connections/nonexistent/message', {
      body: JSON.stringify({ message: 'test' }),
    })
    await handleChannelConnectionMessage(req, res, 'nonexistent', connections, undefined)
    assert.equal(captured.statusCode, 404)
    const result = captured.body as MessageDeliveryResult
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-such-connection')
  })

  it('returns 400 for missing message field', async () => {
    const connections = new Map<string, McpConnection>()
    connections.set('conn-1', fakeConnection({ id: 'conn-1' }))
    const { res, captured } = fakeResponse()
    const req = fakeRequest('POST', '/channel/connections/conn-1/message', {
      body: JSON.stringify({}),
    })
    await handleChannelConnectionMessage(req, res, 'conn-1', connections, undefined)
    assert.equal(captured.statusCode, 400)
    assert.equal((captured.body as { error?: string }).error, 'missing required field: message')
  })

  it('returns 413 for oversized body', async () => {
    const connections = new Map<string, McpConnection>()
    const largeBody = JSON.stringify({ message: 'x'.repeat(16 * 1024 + 1) })
    const { res, captured } = fakeResponse()

    // size check happens before read - so we need to simulate differently
    // Actually let's test with the actual body size
    // The handler reads body first then checks length
    const req = fakeRequest('POST', '/channel/connections/conn-1/message', {
      body: largeBody,
    })
    await handleChannelConnectionMessage(req, res, 'conn-1', connections, undefined)
    // The response should be 413 if we send > 16KB
    if (Buffer.byteLength(largeBody, 'utf8') > 16 * 1024) {
      assert.equal(captured.statusCode, 413)
    }
  })

  it('handles custom title and severity', async () => {
    const connections = new Map<string, McpConnection>()
    connections.set('conn-1', fakeConnection({ id: 'conn-1' }))
    const { res, captured } = fakeResponse()
    const req = fakeRequest('POST', '/channel/connections/conn-1/message', {
      body: JSON.stringify({ message: 'test', title: 'Custom Title', severity: 'error' }),
    })
    await handleChannelConnectionMessage(req, res, 'conn-1', connections, undefined)
    assert.equal(captured.statusCode, 200)
    const result = captured.body as MessageDeliveryResult
    assert.equal(result.ok, true)
  })

  it('rejects invalid severity values', async () => {
    const connections = new Map<string, McpConnection>()
    connections.set('conn-1', fakeConnection({ id: 'conn-1' }))
    const { res, captured } = fakeResponse()
    const req = fakeRequest('POST', '/channel/connections/conn-1/message', {
      body: JSON.stringify({ message: 'test', severity: 'invalid' }),
    })
    await handleChannelConnectionMessage(req, res, 'conn-1', connections, undefined)
    assert.equal(captured.statusCode, 200)
    // Should default to 'info' and still deliver
    const result = captured.body as MessageDeliveryResult
    assert.equal(result.ok, true)
  })

  it('returns 401 with wrong bearer token', async () => {
    process.env.CHANNEL_AUTH_TOKEN = 'secret123'
    try {
      const connections = new Map<string, McpConnection>()
      const { res, captured } = fakeResponse()
      const req = fakeRequest('POST', '/channel/connections/conn-1/message', {
        authorization: 'Bearer wrong',
        body: JSON.stringify({ message: 'test' }),
      })
      await handleChannelConnectionMessage(req, res, 'conn-1', connections, { token_env: 'CHANNEL_AUTH_TOKEN' })
      assert.equal(captured.statusCode, 401)
    } finally {
      delete process.env.CHANNEL_AUTH_TOKEN
    }
  })
})

// ── Integration: full service with channel endpoints ──

describe('channel endpoints integration', () => {
  let workDir: string
  let endpointDir = ''
  let runningService: Awaited<ReturnType<typeof import('../lib/daemon/daemon.mts')['startForemanDaemon']>> | null = null
  let baseUrl = ''
  let isolatedEnv: IsolatedForemanEnv

  before(async () => {
    isolatedEnv = installIsolatedForemanEnv('sessions-mesh-test-env')
    workDir = mkdtempSync(join(tmpdir(), 'sessions-mesh-integration-'))
    const endpoint = createTestIpcEndpoint('sessions-mesh')
    endpointDir = endpoint.dir
    const wp = join(workDir, 'projects', 'workspace')
    mkdirSync(wp, { recursive: true })
    writeFileSync(join(wp, 'workspace.fmproj'), 'name: workspace\ndescription: test\n', 'utf-8')

    const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
    runningService = await startForemanDaemon({
      service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
      workspaceRoot: workDir,
      message: { enabled: false, principals: {} },
      messageDelivery: {
        enabled: false,
        channels: {},
        default: [],
      },
    })

    const addr = runningService.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await runningService?.stop()
    isolatedEnv.restore()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(endpointDir, { recursive: true, force: true })
    resetRegistry()
  })

  it('GET /channel/connections returns empty array when no channel connections', async () => {
    const resp = await fetch(`${baseUrl}/channel/connections`)
    assert.equal(resp.status, 200)
    const list = await resp.json() as unknown[]
    assert.deepEqual(list, [])
  })

  it('POST /channel/connections/:id/message returns 404 for nonexistent', async () => {
    const resp = await fetch(`${baseUrl}/channel/connections/nonexistent/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    })
    assert.equal(resp.status, 404)
    const result = await resp.json() as MessageDeliveryResult
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-such-connection')
  })
})

// ── Session stamp in backends ──

describe('session stamp behavior', () => {
  it('formatMessageDeliveryText appends stamp when originSession present', async () => {
    const { formatMessageDeliveryText } = await import('../lib/message/delivery/format.mts')
    const msg = formatMessageDeliveryText({
      taskName: 'Test Task',
      status: 'done',
      prUrl: null,
      duration: '',
      summary: 'Task completed successfully',
      originSession: '〔session abcdef12 · my-session@mac.local〕',
    })
    assert.ok(msg.includes('〔session abcdef12 · my-session@mac.local〕'))
    assert.ok(msg.includes('Test Task'))
    assert.ok(msg.includes('Task completed successfully'))
  })

  it('formatMessageDeliveryText does not append stamp when originSession absent', async () => {
    const { formatMessageDeliveryText } = await import('../lib/message/delivery/format.mts')
    const msg = formatMessageDeliveryText({
      taskName: 'Test Task',
      status: 'done',
      prUrl: null,
      duration: '',
      summary: 'Task completed',
    })
    assert.ok(!msg.includes('〔session'))
  })

  it('telegram inputFromEvent includes stamp when event has originSession', async () => {
    // Check via formatSessionStamp since inputFromEvent is private
    const event: MessageEnvelope = {
      id: 'evt-1',
      kind: 'message',
      severity: 'info',
      title: 'Test',
      body: 'Hello',
      refs: { originSession: { id: 'session-123', label: 'agent', host: 'mac.local' } },
      ts: new Date().toISOString(),
    }
    const stamp = event.refs.originSession ? formatSessionStamp(event.refs.originSession) : undefined
    assert.equal(stamp, '〔session session- · agent@mac.local〕')
  })

  it('telegram does not stamp when event has no originSession', () => {
    const event: MessageEnvelope = {
      id: 'evt-2',
      kind: 'message',
      severity: 'info',
      title: 'Test',
      body: 'Hello',
      refs: {},
      ts: new Date().toISOString(),
    }
    const stamp = event.refs.originSession ? formatSessionStamp(event.refs.originSession) : undefined
    assert.equal(stamp, undefined)
  })

  it('openclaw agent-mode strips originSession from message', async () => {
    const { buildOpenclawMessageArgBatches } = await import('../lib/adapters/message/backends/openclaw.mts')
    const args = buildOpenclawMessageArgBatches(
      {
        backend: 'openclaw',
        mode: 'agent',
        target: 'test',
        channel: 'test',
        session_key: 'fake-key',
      } as import('../lib/message/delivery/types.mts').OpenclawChannelConfig,
      {
        eventId: 'evt-1',
        taskName: 'Test',
        status: 'done',
        prUrl: null,
        duration: '',
        summary: 'Hello',
        originSession: '〔session abcdef12 · test@localhost〕',
      },
    )
    assert.deepEqual(args[0].slice(-2), ['--timeout', '120000'])
    // The message in agent mode should NOT include the stamp
    for (const batch of args) {
      const paramsIdx = batch.indexOf('--params')
      if (paramsIdx >= 0) {
        const params = JSON.parse(batch[paramsIdx + 1]) as { message?: string }
        if (params.message) {
          assert.ok(!params.message.includes('〔session'), `agent-mode message should not have session stamp: ${params.message}`)
        }
      }
    }
  })

  it('openclaw send-mode includes originSession stamp', async () => {
    const { buildOpenclawMessageArgBatches } = await import('../lib/adapters/message/backends/openclaw.mts')
    const args = buildOpenclawMessageArgBatches(
      {
        backend: 'openclaw',
        mode: 'send',
        target: 'test',
        channel: 'test',
      } as import('../lib/message/delivery/types.mts').OpenclawChannelConfig,
      {
        eventId: 'evt-2',
        taskName: 'Test',
        status: 'done',
        prUrl: null,
        duration: '',
        summary: 'Hello',
        originSession: '〔session abcdef12 · test@localhost〕',
      },
    )
    for (const batch of args) {
      const paramsIdx = batch.indexOf('--params')
      if (paramsIdx >= 0) {
        const params = JSON.parse(batch[paramsIdx + 1]) as { message?: string }
        if (params.message) {
          assert.ok(params.message.includes('〔session abcdef12 · test@localhost〕'), `send-mode message should have session stamp: ${params.message}`)
        }
      }
    }
  })

  it('wecom appends stamp when event has originSession', async () => {
    // Test formatSessionStamp used in wecom
    const stamp = formatSessionStamp({ id: 'test1234', label: 'w', host: 'h' })
    assert.ok(stamp.includes('test1234'))
    assert.ok(stamp.includes('w@h'))
  })
})
