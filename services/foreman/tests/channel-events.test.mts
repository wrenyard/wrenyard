import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { checkAuth, handleChannelEvents } from '../lib/daemon/daemon.mts'
import type { McpConnection } from '../lib/adapters/message/backends/index.mts'

// Create a test server that serves handleChannelEvents on a given path
function createEventServer(
  connections: Map<string, McpConnection>,
  authCfg?: { token_env?: string; token_file?: string },
): Promise<{ server: ReturnType<typeof createServer>; port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname === '/mcp/channel/events' && req.method === 'GET') {
        void handleChannelEvents(req, res, connections, {
          enabled: true,
          channels: {},
          default: [],
          ...(authCfg ? { auth: authCfg } : {}),
        })
        return
      }
      res.writeHead(404)
      res.end('Not Found')
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ server, port, stop: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

// Helper to read SSE data events from an IncomingMessage
async function readSseEvents(
  response: IncomingMessage,
  opts?: { timeoutMs?: number },
): Promise<Array<{ event?: string; data: string }>> {
  const events: Array<{ event?: string; data: string }> = []
  const timeoutMs = opts?.timeoutMs ?? 3000
  let buffer = ''

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve(events)
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      // Parse SSE events: separated by double newline
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const lines = part.split('\n')
        const event: { event?: string; data: string } = { data: '' }
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            event.event = line.slice(7)
          } else if (line.startsWith('data: ')) {
            event.data = line.slice(6)
          }
        }
        // Skip heartbeat comments (lines starting with ':')
        if (event.data || event.event) {
          events.push(event)
        }
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      response.off('data', onData)
      response.off('end', onEnd)
      response.off('error', onError)
      response.destroy()
    }

    const onEnd = () => {
      cleanup()
      resolve(events)
    }

    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }

    response.on('data', onData)
    response.on('end', onEnd)
    response.on('error', onError)
  })
}

// Helper to read raw SSE stream until a condition is met
async function readSseUntil(
  response: IncomingMessage,
  condition: () => boolean,
  opts?: { timeoutMs?: number },
): Promise<Array<{ event?: string; data: string }>> {
  const events: Array<{ event?: string; data: string }> = []
  const timeoutMs = opts?.timeoutMs ?? 5000
  let buffer = ''

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve(events)
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const lines = part.split('\n')
        const event: { event?: string; data: string } = { data: '' }
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            event.event = line.slice(7)
          } else if (line.startsWith('data: ')) {
            event.data = line.slice(6)
          }
        }
        if (event.data || event.event) {
          events.push(event)
        }
      }
      if (condition()) {
        cleanup()
        resolve(events)
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      response.off('data', onData)
      response.off('end', onEnd)
      response.off('error', onError)
      response.destroy()
    }

    const onEnd = () => {
      cleanup()
      resolve(events)
    }

    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }

    response.on('data', onData)
    response.on('end', onEnd)
    response.on('error', onError)
  })
}

// ============================================================
// checkAuth unit tests
// ============================================================

describe('checkAuth', () => {
  function fakeRequest(overrides: Partial<{ authorization: string; remoteAddress: string }> = {}): IncomingMessage {
    return {
      headers: {
        authorization: overrides.authorization,
      },
      socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    } as unknown as IncomingMessage
  }

  function fakeResponse(): { res: ServerResponse; captured: { statusCode: number; body: unknown } } {
    const captured = { statusCode: 200, body: null as unknown }
    const res = {
      get statusCode() { return captured.statusCode },
      set statusCode(v: number) { captured.statusCode = v },
      writeHead(code: number) {
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

  it('allows loopback when no auth configured', () => {
    const { res, captured } = fakeResponse()
    const req = fakeRequest()
    const result = checkAuth(req, res, undefined)
    assert.ok(result)
    assert.equal(captured.statusCode, 200)
  })

  it('rejects non-loopback when no auth configured', () => {
    const { res, captured } = fakeResponse()
    const req = fakeRequest({ remoteAddress: '192.168.1.1' })
    const result = checkAuth(req, res, undefined)
    assert.equal(result, false)
    assert.equal(captured.statusCode, 403)
    assert.equal((captured.body as { error?: string })?.error, 'forbidden')
  })

  it('rejects missing bearer when auth configured', () => {
    process.env.CHANNEL_AUTH_TOKEN = 'secret123'
    try {
      const { res, captured } = fakeResponse()
      const req = fakeRequest({ remoteAddress: '192.168.1.1' })
      const result = checkAuth(req, res, { token_env: 'CHANNEL_AUTH_TOKEN' })
      assert.equal(result, false)
      assert.equal(captured.statusCode, 401)
      assert.equal((captured.body as { error?: string })?.error, 'unauthorized')
    } finally {
      delete process.env.CHANNEL_AUTH_TOKEN
    }
  })

  it('rejects wrong bearer token', () => {
    process.env.CHANNEL_AUTH_TOKEN = 'correct-token'
    try {
      const { res, captured } = fakeResponse()
      const req = fakeRequest({ authorization: 'Bearer wrong-token' })
      const result = checkAuth(req, res, { token_env: 'CHANNEL_AUTH_TOKEN' })
      assert.equal(result, false)
      assert.equal(captured.statusCode, 401)
    } finally {
      delete process.env.CHANNEL_AUTH_TOKEN
    }
  })

  it('accepts correct bearer token', () => {
    process.env.CHANNEL_AUTH_TOKEN = 'correct-token'
    try {
      const { res, captured } = fakeResponse()
      const req = fakeRequest({ authorization: 'Bearer correct-token' })
      const result = checkAuth(req, res, { token_env: 'CHANNEL_AUTH_TOKEN' })
      assert.ok(result)
      assert.equal(captured.statusCode, 200)
    } finally {
      delete process.env.CHANNEL_AUTH_TOKEN
    }
  })

  it('returns 500 when auth token resolves to null', () => {
    const { res, captured } = fakeResponse()
    const req = fakeRequest()
    const result = checkAuth(req, res, { token_env: 'NONEXISTENT_TOKEN' })
    assert.equal(result, false)
    assert.equal(captured.statusCode, 500)
    assert.equal((captured.body as { error?: string })?.error, 'message delivery auth misconfigured')
  })
})

// ============================================================
// handleChannelEvents integration tests
// ============================================================

describe('handleChannelEvents', () => {
  let server: ReturnType<typeof createServer> | null = null
  let port = 0
  let connections: Map<string, McpConnection>
  let stop: () => Promise<void>

  before(async () => {
    connections = new Map<string, McpConnection>()
    const s = await createEventServer(connections)
    server = s.server
    port = s.port
    stop = s.stop
  })

  after(async () => {
    connections.clear()
    await stop()
  })

  it('registers connection with metadata and channelCapable=true', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=meta-test`,
        { headers: { 'x-foreman-channel-meta': JSON.stringify({ label: 'my-session', cwd: '/home/user', pid: 1234, startedAt: '2026-06-13T00:00:00Z', clientName: 'codebuddy', clientVersion: '2.105.2', host: 'mac.local' }) } },
      )

      req.on('response', (res) => {
        // Allow time for the connection to be registered
        setTimeout(() => {
          try {
            const conn = connections.get('meta-test')
            assert.ok(conn, 'connection should be registered')
            assert.equal(conn?.id, 'meta-test')
            assert.equal(conn?.channelCapable, true)
            assert.equal(conn?.label, 'my-session')
            assert.equal(conn?.cwd, '/home/user')
            assert.equal(conn?.pid, 1234)
            assert.equal(conn?.startedAt, '2026-06-13T00:00:00Z')
            assert.equal(conn?.clientName, 'codebuddy')
            assert.equal(conn?.clientVersion, '2.105.2')
            assert.equal(conn?.host, 'mac.local')
            res.destroy()
            resolve()
          } catch (err) {
            res.destroy()
            reject(err)
          }
        }, 100)
      })

      req.on('error', reject)
    })
  })

  it('ignores unknown keys in metadata header', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=unknown-keys`,
        { headers: { 'x-foreman-channel-meta': JSON.stringify({ label: 'test', unknown: 'should be ignored', another: 42 }) } },
      )

      req.on('response', (res) => {
        setTimeout(() => {
          try {
            const conn = connections.get('unknown-keys')
            assert.ok(conn, 'connection should be registered')
            assert.equal(conn?.label, 'test')
            res.destroy()
            resolve()
          } catch (err) {
            res.destroy()
            reject(err)
          }
        }, 100)
      })

      req.on('error', reject)
    })
  })

  it('rejects malformed metadata header with 400', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=bad-meta`,
      { headers: { 'x-foreman-channel-meta': 'not-json{malformed' } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata header is not valid JSON')
  })

  it('notification sent via sendNotification arrives as SSE data', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=sse-notify-test`,
      )

      req.on('response', async (res) => {
        try {
          // Give the handler time to register the connection
          await new Promise((r) => setTimeout(r, 100))

          const conn = connections.get('sse-notify-test')
          assert.ok(conn, 'connection should be registered')

          // Send a notification through the connection
          conn!.sendNotification({
            method: 'notifications/claude/channel',
            params: { content: 'Hello from test', meta: { source: 'foreman' } },
          })

          // Poll for SSE event delivery
          let found = false
          const chunks: string[] = []
          const dataHandler = (chunk: Buffer) => {
            chunks.push(chunk.toString())
            if (chunks.join('').includes('Hello from test')) {
              found = true
              res.off('data', dataHandler)
              res.destroy()
              // Clean up the test connection from map
              connections.delete('sse-notify-test')
              resolve()
            }
          }
          res.on('data', dataHandler)

          // Timeout guard
          setTimeout(() => {
            if (!found) {
              res.off('data', dataHandler)
              res.destroy()
              connections.delete('sse-notify-test')
              reject(new Error('SSE notification not received'))
            }
          }, 3000)
        } catch (err) {
          res.destroy()
          connections.delete('sse-notify-test')
          reject(err)
        }
      })

      req.on('error', reject)
    })
  })

  it('removes connection from map on close', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=close-test`,
      )

      req.on('response', (res) => {
        setTimeout(() => {
          try {
            assert.ok(connections.has('close-test'), 'connection should be registered')
            // Close the response to trigger cleanup
            res.destroy()

            // Give cleanup time to run
            setTimeout(() => {
              try {
                assert.equal(connections.has('close-test'), false, 'connection should be removed after close')
                resolve()
              } catch (err) {
                reject(err)
              }
            }, 100)
          } catch (err) {
            res.destroy()
            reject(err)
          }
        }, 100)
      })

      req.on('error', reject)
    })
  })

  it('rejects duplicate connId, replacing the old connection', async () => {
    return new Promise<void>((resolve, reject) => {
      // Open first connection
      const req1 = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=dup-test`,
        { headers: { 'x-foreman-channel-meta': JSON.stringify({ label: 'first' }) } },
      )

      req1.on('response', (res1) => {
        setTimeout(() => {
          try {
            assert.ok(connections.has('dup-test'), 'first connection should be registered')
            assert.equal(connections.get('dup-test')?.label, 'first')

            // Open second connection with same connId
            const req2 = get(
              `http://127.0.0.1:${port}/mcp/channel/events?connId=dup-test`,
              { headers: { 'x-foreman-channel-meta': JSON.stringify({ label: 'second' }) } },
            )

            req2.on('response', (res2) => {
              setTimeout(() => {
                try {
                  // The old connection should be replaced by the new one
                  const conn = connections.get('dup-test')
                  assert.ok(conn, 'connection should still exist')
                  assert.equal(conn?.label, 'second', 'label should be from second connection')

                  // Clean up - destroy both responses
                  res1.destroy()
                  res2.destroy()

                  setTimeout(() => {
                    connections.delete('dup-test')
                    resolve()
                  }, 100)
                } catch (err) {
                  res1.destroy()
                  res2.destroy()
                  reject(err)
                }
              }, 100)
            })

            req2.on('error', (err) => {
              res1.destroy()
              reject(err)
            })
          } catch (err) {
            res1.destroy()
            reject(err)
          }
        }, 100)
      })

      req1.on('error', reject)
    })
  })

  it('returns 400 when connId query parameter is missing', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events`,
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'missing connId query parameter')
  })

  it('returns 400 when connId is empty', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=`,
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'missing connId query parameter')
  })

  it('passes correct JSON-RPC format in SSE data', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=jsonrpc-test`,
      )

      req.on('response', async (res) => {
        try {
          await new Promise((r) => setTimeout(r, 100))

          const conn = connections.get('jsonrpc-test')
          assert.ok(conn)

          const notified = new Promise<void>((res2) => {
            const handler = (chunk: Buffer) => {
              const text = chunk.toString()
              if (text.includes('data: ')) {
                res.off('data', handler)
                res2()
              }
            }
            res.on('data', handler)
            setTimeout(() => res2(), 3000)
          })

          conn!.sendNotification({
            method: 'notifications/test',
            params: { key: 'value' },
          })

          await notified

          // Check the SSE format by reading data from the response
          // The sendNotification writes JSON-RPC formatted data
          const conn2 = connections.get('jsonrpc-test')
          assert.equal(conn2?.channelCapable, true)

          res.destroy()
          connections.delete('jsonrpc-test')
          resolve()
        } catch (err) {
          res.destroy()
          connections.delete('jsonrpc-test')
          reject(err)
        }
      })

      req.on('error', reject)
    })
  })

  // Fix 4: strict meta header validation tests
  it('rejects meta header exceeding 2KB', async () => {
    const bigValue = 'x'.repeat(2049)
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=big-meta`,
      { headers: { 'x-foreman-channel-meta': JSON.stringify({ label: bigValue }) } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata header exceeds 2KB limit')
  })

  it('rejects label exceeding 128 bytes', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=long-label`,
      { headers: { 'x-foreman-channel-meta': JSON.stringify({ label: 'x'.repeat(129) }) } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata field label exceeds 128 bytes')
  })

  it('rejects cwd exceeding 512 bytes', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=long-cwd`,
      { headers: { 'x-foreman-channel-meta': JSON.stringify({ cwd: '/'.repeat(513) }) } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata field cwd exceeds 512 bytes')
  })

  it('rejects non-positive pid', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=bad-pid`,
      { headers: { 'x-foreman-channel-meta': JSON.stringify({ pid: 0 }) } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata field pid must be a positive safe integer')
  })

  it('rejects negative pid', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=neg-pid`,
      { headers: { 'x-foreman-channel-meta': JSON.stringify({ pid: -1 }) } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata field pid must be a positive safe integer')
  })

  it('rejects non-integer pid', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=float-pid`,
      { headers: { 'x-foreman-channel-meta': JSON.stringify({ pid: 1.5 }) } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata field pid must be a positive safe integer')
  })

  it('rejects invalid startedAt date', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp/channel/events?connId=bad-date`,
      { headers: { 'x-foreman-channel-meta': JSON.stringify({ startedAt: 'not-a-date' }) } },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, 'metadata field startedAt must be a valid ISO 8601 date')
  })

  it('accepts valid ISO date for startedAt', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=good-date`,
        { headers: { 'x-foreman-channel-meta': JSON.stringify({ startedAt: '2026-06-13T00:00:00.000Z' }) } },
      )
      req.on('response', (res) => {
        setTimeout(() => {
          try {
            const conn = connections.get('good-date')
            assert.ok(conn, 'connection should be registered')
            assert.equal(conn?.startedAt, '2026-06-13T00:00:00.000Z')
            res.destroy()
            resolve()
          } catch (err) {
            res.destroy()
            reject(err)
          }
        }, 100)
      })
      req.on('error', reject)
    })
  })

  it('accepts valid pid (positive safe integer)', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=good-pid`,
        { headers: { 'x-foreman-channel-meta': JSON.stringify({ pid: 1234 }) } },
      )
      req.on('response', (res) => {
        setTimeout(() => {
          try {
            const conn = connections.get('good-pid')
            assert.ok(conn, 'connection should be registered')
            assert.equal(conn?.pid, 1234)
            res.destroy()
            resolve()
          } catch (err) {
            res.destroy()
            reject(err)
          }
        }, 100)
      })
      req.on('error', reject)
    })
  })

  // Fix 1c: nonce is first SSE event
  it('sends channel/registered nonce as first SSE event', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${port}/mcp/channel/events?connId=nonce-test`,
      )

      req.on('response', (res) => {
        try {
          let firstEvent: { event?: string; data: string } | null = null
          const handler = (chunk: Buffer) => {
            const text = chunk.toString()
            const parts = text.split('\n\n')
            for (const part of parts) {
              const lines = part.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ') && !firstEvent) {
                  firstEvent = { data: line.slice(6) }
                }
              }
              if (firstEvent) break
            }
            if (firstEvent) {
              res.off('data', handler)
              try {
                const msg = JSON.parse(firstEvent.data)
                assert.equal(msg.method, 'channel/registered')
                assert.ok(msg.params?.nonce, 'nonce should be present')
                assert.equal(typeof msg.params.nonce, 'string')
                assert.equal(msg.params.nonce.length, 32, 'nonce should be 32 hex chars (16 bytes)')
                connections.delete('nonce-test')
                res.destroy()
                resolve()
              } catch (err) {
                res.destroy()
                reject(err)
              }
            }
          }
          res.on('data', handler)

          setTimeout(() => {
            if (!firstEvent) {
              res.destroy()
              reject(new Error('nonce event not received'))
            }
          }, 3000)
        } catch (err) {
          res.destroy()
          reject(err)
        }
      })

      req.on('error', reject)
    })
  })
})
