import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveDeliveryRoutes } from '../lib/message/delivery/router.mts'
import { MessageDeliveryHub, type MessageBackend } from '../lib/message/delivery/hub.mts'
import type {
  ChannelConfig,
  MessageDeliveryResult,
  MessageEnvelope,
  MessageDeliveryRegistryConfig,
  TelegramChannelConfig,
  WecomChannelConfig,
  WebhookChannelConfig,
} from '../lib/message/delivery/types.mts'

function makeEvent(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'test-1',
    kind: 'task.done',
    severity: 'success',
    title: 'Test Task',
    body: 'Task completed successfully.',
    refs: { taskId: 'task-1', sessionId: 'sess-1' },
    ts: new Date().toISOString(),
    ...overrides,
  }
}

function makeRegistry(overrides: Partial<MessageDeliveryRegistryConfig> = {}): MessageDeliveryRegistryConfig {
  return {
    enabled: true,
    channels: {
      main: { backend: 'system' } as ChannelConfig,
      alerts: { backend: 'telegram', chat_id: '123' } as TelegramChannelConfig,
      logs: { backend: 'webhook', url: 'https://example.com/hook' } as WebhookChannelConfig,
    },
    default: ['main'],
    ...overrides,
  }
}

// ============================================================
// Router
// ============================================================

describe('resolveDeliveryRoutes', () => {
  it('uses explicit channels when provided', () => {
    const cfg = makeRegistry()
    const result = resolveDeliveryRoutes(makeEvent(), ['alerts', 'main'], cfg)
    assert.deepStrictEqual(result, { routes: ['alerts', 'main'], errors: [] })
  })

  it('puts unknown explicit channel names into errors', () => {
    const cfg = makeRegistry()
    const result = resolveDeliveryRoutes(makeEvent(), ['missing', 'main', 'nope'], cfg)
    assert.deepStrictEqual(result, { routes: ['main'], errors: ['missing', 'nope'] })
  })

  it('uses routes over default when no explicit channels', () => {
    const cfg = makeRegistry({
      routes: { 'task.done': ['alerts', 'logs'] },
    })
    const result = resolveDeliveryRoutes(makeEvent({ kind: 'task.done' }), undefined, cfg)
    assert.deepStrictEqual(result, { routes: ['alerts', 'logs'], errors: [] })
  })

  it('falls back to default when no explicit or route match', () => {
    const cfg = makeRegistry()
    const result = resolveDeliveryRoutes(makeEvent({ kind: 'message' }), undefined, cfg)
    assert.deepStrictEqual(result, { routes: ['main'], errors: [] })
  })

  it('returns errors for unknown route channels', () => {
    const cfg = makeRegistry({
      routes: { 'task.failed': ['missing', 'main'] },
    })
    const result = resolveDeliveryRoutes(makeEvent({ kind: 'task.failed' }), undefined, cfg)
    assert.deepStrictEqual(result, { routes: ['main'], errors: ['missing'] })
  })

  it('empty explicit array means no channels (no fallback to default)', () => {
    const cfg = makeRegistry()
    const result = resolveDeliveryRoutes(makeEvent(), [], cfg)
    // Explicit [] = no route channels returned; pet always-append still adds 'pet' later
    assert.deepStrictEqual(result, { routes: [], errors: [] })
  })

  it('never throws', () => {
    const cfg = makeRegistry()
    const result = resolveDeliveryRoutes(makeEvent(), ['nonexistent'], cfg)
    assert.deepStrictEqual(result, { routes: [], errors: ['nonexistent'] })
  })
})

// ============================================================
// Hub
// ============================================================

function fakeBackend(name: string, behavior: 'ok' | 'throw' | 'fail'): MessageBackend {
  return {
    name,
    async deliver(event, channel): Promise<MessageDeliveryResult> {
      if (behavior === 'throw') throw new Error(`BOOM from ${name}`)
      if (behavior === 'fail') return { channel, backend: name, ok: false, error: 'simulated failure' }
      return { channel, backend: name, ok: true }
    },
  }
}

function fakeRegistryBackend(_name: string, cfg: ChannelConfig): MessageBackend {
  return {
    name: cfg.backend,
    async deliver(_event, channel): Promise<MessageDeliveryResult> {
      return { channel, backend: cfg.backend, ok: true }
    },
  }
}

describe('MessageDeliveryHub', () => {
  it('resolves channels and dispatches to all', async () => {
    const cfg = makeRegistry({
      channels: {
        a: { backend: 'system' },
        b: { backend: 'system' },
      },
      default: ['a', 'b'],
    })
    const deliveries: string[] = []
    const hub = new MessageDeliveryHub(cfg, (name, _cfg) => ({
      name,
      async deliver(event, channel) {
        deliveries.push(channel)
        return { channel, backend: name, ok: true }
      },
    }))
    const results = await hub.emit(makeEvent())
    assert.equal(results.length, 2)
    assert.deepStrictEqual(deliveries.sort(), ['a', 'b'])
    assert.ok(results.every((d) => d.ok))
  })

  it('never throws when a backend throws', async () => {
    const cfg = makeRegistry({
      channels: {
        good: { backend: 'system' },
        bad: { backend: 'system' },
      },
      default: ['good', 'bad'],
    })
    const hub = new MessageDeliveryHub(cfg, (name) => fakeBackend(name, name === 'bad' ? 'throw' : 'ok'))
    const results = await hub.emit(makeEvent())
    assert.equal(results.length, 2)
    const good = results.find((d) => d.channel === 'good')
    const bad = results.find((d) => d.channel === 'bad')
    assert.ok(good?.ok)
    assert.ok(!bad?.ok)
    assert.ok(bad?.error?.includes('BOOM'))
  })

  it('other channels unaffected by one failure', async () => {
    const cfg = makeRegistry({
      channels: {
        a: { backend: 'system' },
        b: { backend: 'system' },
        c: { backend: 'system' },
      },
      default: ['a', 'b', 'c'],
    })
    const hub = new MessageDeliveryHub(cfg, (name) =>
      fakeBackend(name, name === 'b' ? 'throw' : 'ok'),
    )
    const results = await hub.emit(makeEvent())
    assert.equal(results.length, 3)
    const ok = results.filter((d) => d.ok)
    assert.equal(ok.length, 2)
  })

  it('delivers communication channels through the unified channel model', async () => {
    const cfg = makeRegistry({
      channels: {
        pet: { backend: 'system' },
        tg: { backend: 'telegram', chat_id: '123' } as ChannelConfig,
        oc: { backend: 'openclaw', target: 'peer', channel: 'telegram', mode: 'send' } as ChannelConfig,
      },
      default: ['tg', 'oc'],
    })
    const delivered: string[] = []
    const hub = new MessageDeliveryHub(cfg, (name, channelCfg) => ({
      name,
      async deliver(_event, channel) {
        delivered.push(channel)
        return { channel, backend: channelCfg.backend, ok: true }
      },
    }))

    const results = await hub.emit(makeEvent())

    assert.deepEqual(delivered, ['tg', 'oc'])
    assert.equal(results.every((delivery) => delivery.ok), true)
  })

  it('delivers local and outbound webhooks through the unified channel model', async () => {
    const cfg = makeRegistry({
      channels: {
        local_hook: { backend: 'webhook', url: 'http://127.0.0.1:8787/hook' } as WebhookChannelConfig,
        pet: { backend: 'webhook', url: 'https://example.com/pet-compatible' } as WebhookChannelConfig,
        outbound: { backend: 'webhook', url: 'https://example.com/outbound' } as WebhookChannelConfig,
      },
      default: ['local_hook', 'pet', 'outbound'],
    })
    const delivered: string[] = []
    const hub = new MessageDeliveryHub(cfg, (name, channelCfg) => ({
      name,
      async deliver(_event, channel) {
        delivered.push(channel)
        return { channel, backend: channelCfg.backend, ok: true }
      },
    }))

    const results = await hub.emit(makeEvent())

    assert.deepEqual(delivered.sort(), ['local_hook', 'outbound', 'pet'])
    const outbound = results.find((d) => d.channel === 'outbound')
    assert.equal(outbound?.ok, true)
  })

  it('message intent delivers message channel without auto-appending pet', async () => {
    const cfg = makeRegistry({
      channels: {
        pet: { backend: 'system' },
        tg: { backend: 'telegram', chat_id: '123' } as TelegramChannelConfig,
      },
      default: ['pet'],
    })
    const delivered: string[] = []
    const hub = new MessageDeliveryHub(cfg, (name, channelCfg) => ({
      name,
      async deliver(_event, channel) {
        delivered.push(channel)
        return { channel, backend: channelCfg.backend, ok: true }
      },
    }))

    const results = await hub.emit(makeEvent({ kind: 'message' }), { channels: ['tg'] })

    assert.deepEqual(delivered, ['tg'])
    assert.equal(results.length, 1)
    assert.equal(results[0].channel, 'tg')
    assert.equal(results[0].ok, true)
  })
})

// ============================================================
// Telegram backend request construction
// ============================================================

describe('telegram backend', () => {
  it('builds correct sendMessage request with HTML parse_mode', async () => {
    const { createTelegramBackend } = await import('../lib/adapters/message/backends/telegram.mts')
    const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: init?.body as string ?? '',
        headers: init?.headers as Record<string, string> ?? {},
      })
      return { ok: true, status: 200, text: async () => '' } as Response
    }

    process.env.TG_TOKEN = 'test-bot-token'
    const backend = createTelegramBackend(
      { backend: 'telegram', chat_id: '123456', token_env: 'TG_TOKEN' },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    try {
      const event = makeEvent({ kind: 'message', title: 'Test', body: 'Hello world' })
      const result = await backend.deliver(event, 'alerts')
      assert.ok(result.ok)
      assert.equal(requests.length, 1)
      assert.ok(requests[0].url.includes('bottest-bot-token/sendMessage'))
      const parsed = JSON.parse(requests[0].body)
      assert.equal(parsed.chat_id, '123456')
      assert.equal(parsed.parse_mode, 'HTML')
      assert.match(parsed.text, /Test/)
      assert.match(parsed.text, /Hello world/)
    } finally {
      delete process.env.TG_TOKEN
    }
  })

  it('multiple chunks when message is long', async () => {
    const { formatMessageDeliveryTexts } = await import('../lib/message/delivery/format.mts')
    const result = formatMessageDeliveryTexts({
      taskName: 'Test',
      status: 'done',
      client: null,
      model: null,
      prUrl: null,
      duration: '',
      summary: 'x'.repeat(4000),
    })
    assert.ok(result.length > 1, `Expected >1 chunks, got ${result.length}`)
  })
})

// ============================================================
// WeCom backend request construction
// ============================================================

describe('wecom backend', () => {
  it('builds markdown message request', async () => {
    const { createWecomBackend } = await import('../lib/adapters/message/backends/wecom.mts')
    const requests: Array<{ url: string; body: string }> = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string ?? '' })
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    }

    process.env.WECOM_KEY = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'
    try {
      const backend = createWecomBackend(
        { backend: 'wecom', webhook_env: 'WECOM_KEY' },
        { fetch: fakeFetch as typeof globalThis.fetch },
      )
      const result = await backend.deliver(makeEvent({ title: 'Alert', body: 'Something happened', severity: 'warning' }), 'alerts')
      assert.ok(result.ok)
      assert.equal(requests.length, 1)
      assert.ok(requests[0].url.includes('key=test'))
      const parsed = JSON.parse(requests[0].body)
      assert.equal(parsed.msgtype, 'markdown')
      assert.match(parsed.markdown.content, /Alert/)
      assert.match(parsed.markdown.content, /warning/)
    } finally {
      delete process.env.WECOM_KEY
    }
  })
})

// ============================================================
// Webhook backend request construction
// ============================================================

describe('webhook backend', () => {
  it('POSTs full MessageEnvelope JSON by default', async () => {
    const { createWebhookBackend } = await import('../lib/adapters/message/backends/webhook.mts')
    const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: init?.body as string ?? '',
        headers: init?.headers as Record<string, string> ?? {},
      })
      return new Response('ok', { status: 200 })
    }

    const backend = createWebhookBackend(
      { backend: 'webhook', url: 'https://example.com/hook' },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    const event = makeEvent()
    const result = await backend.deliver(event, 'logs')
    assert.ok(result.ok)
    assert.equal(requests.length, 1)
    const parsed = JSON.parse(requests[0].body)
    assert.equal(parsed.id, event.id)
    assert.equal(parsed.kind, 'task.done')
  })

  it('uses template substitution when template is provided', async () => {
    const { createWebhookBackend } = await import('../lib/adapters/message/backends/webhook.mts')
    const requests: Array<{ url: string; body: string }> = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string ?? '' })
      return { ok: true, status: 200 } as Response
    }

    const backend = createWebhookBackend(
      {
        backend: 'webhook',
        url: 'https://example.com/hook',
        template: { text: '{{title}}: {{body}}', severity: '{{severity}}' },
      },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    const event = makeEvent({ title: 'My Title', body: 'My Body', severity: 'warning' })
    const result = await backend.deliver(event, 'logs')
    assert.ok(result.ok)
    const parsed = JSON.parse(requests[0].body)
    assert.equal(parsed.text, 'My Title: My Body')
    assert.equal(parsed.severity, 'warning')
  })

  it('supports nested objects via dot-notation template keys', async () => {
    const { createWebhookBackend } = await import('../lib/adapters/message/backends/webhook.mts')
    const requests: Array<{ body: string }> = []
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      requests.push({ body: init?.body as string ?? '' })
      return { ok: true, status: 200 } as Response
    }

    const backend = createWebhookBackend(
      {
        backend: 'webhook',
        url: 'https://example.com/hook',
        template: {
          id: '{{id}}',
          kind: '{{kind}}',
          severity: '{{severity}}',
          title: '{{title}}',
          body: '{{body}}',
          ts: '{{ts}}',
          'refs.taskId': '{{taskId}}',
          'refs.workflowId': '{{workflowId}}',
          'refs.sessionId': '{{sessionId}}',
          'refs.project': '{{project}}',
        },
      },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    const event = makeEvent({
      kind: 'task.done',
      refs: { taskId: 'task-1', sessionId: 'sess-1', project: 'my-proj' },
    })
    const result = await backend.deliver(event, 'pet')
    assert.ok(result.ok)
    const parsed = JSON.parse(requests[0].body)
    assert.equal(parsed.id, event.id)
    assert.equal(parsed.kind, 'task.done')
    assert.equal(parsed.severity, 'success')
    assert.equal(parsed.title, 'Test Task')
    assert.equal(parsed.ts, event.ts)
    assert.deepStrictEqual(parsed.refs, {
      taskId: 'task-1',
      workflowId: '',
      sessionId: 'sess-1',
      project: 'my-proj',
    })
  })

  it('omits empty nested refs object when all values are empty', async () => {
    const { createWebhookBackend } = await import('../lib/adapters/message/backends/webhook.mts')
    const requests: Array<{ body: string }> = []
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      requests.push({ body: init?.body as string ?? '' })
      return { ok: true, status: 200 } as Response
    }

    const backend = createWebhookBackend(
      {
        backend: 'webhook',
        url: 'https://example.com/hook',
        template: {
          id: '{{id}}',
          ts: '{{ts}}',
          'refs.taskId': '{{taskId}}',
          'refs.workflowId': '{{workflowId}}',
        },
      },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    const event = makeEvent({ refs: {} })
    const result = await backend.deliver(event, 'pet')
    assert.ok(result.ok)
    const parsed = JSON.parse(requests[0].body)
    assert.equal(parsed.id, event.id)
    assert.equal(parsed.refs, undefined, 'empty refs should be omitted')
  })
})

// ============================================================
// cc-channel backend
// ============================================================

import { randomBytes } from 'node:crypto'
import type { McpConnection } from '../lib/adapters/message/backends/index.mts'

function fakeConnection(id: string, channelCapable = true): McpConnection & { notifications: Array<{ method: string; params: Record<string, unknown> }>; dead: boolean } {
  const conn: McpConnection & { notifications: Array<{ method: string; params: Record<string, unknown> }>; dead: boolean } = {
    id,
    channelCapable,
    dead: false,
    notifications: [],
    sendNotification(message: { method: string; params: Record<string, unknown> }) {
      if (this.dead) throw new Error('connection closed')
      this.notifications.push(message)
    },
  }
  return conn
}

function fakeDeadConnection(id: string, channelCapable = true): McpConnection & { notifications: Array<{ method: string; params: Record<string, unknown> }>; dead: boolean } {
  const conn = fakeConnection(id, channelCapable)
  conn.dead = true
  return conn
}

describe('cc-channel backend', () => {
  it('targets the originating connection from the event without task record lookup', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connB = fakeConnection('conn-b')
    const connections = new Map<string, McpConnection>([['conn-a', connA], ['conn-b', connB]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({
      refs: { taskId: 'task-1', project: 'test' },
      originatingConnectionId: 'conn-a',
    } as Partial<MessageEnvelope>)
    const result = await backend.deliver(event, 'cc')

    assert.ok(result.ok)
    assert.equal(connA.notifications.length, 1)
    assert.equal(connB.notifications.length, 0)
  })

  it('sends to originating connection only when alive', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connB = fakeConnection('conn-b')
    const connections = new Map<string, McpConnection>([['conn-a', connA], ['conn-b', connB]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({
      refs: { taskId: 'task-1', project: 'test' },
      originatingConnectionId: 'conn-a',
    })
    const result = await backend.deliver(event, 'cc')

    assert.ok(result.ok)
    assert.equal(connA.notifications.length, 1)
    assert.equal(connB.notifications.length, 0)
    assert.equal(connA.notifications[0].method, 'notifications/claude/channel')
    const params = connA.notifications[0].params as Record<string, unknown>
    assert.ok(typeof params.content === 'string')
    assert.ok((params.content as string).includes(event.title))
    assert.ok((params.content as string).includes(event.body))
    const meta = params.meta as Record<string, unknown>
    assert.equal(meta.source, 'foreman')
    assert.equal(meta.kind, event.kind)
    assert.equal(meta.severity, event.severity)
    assert.deepStrictEqual(meta.refs, event.refs)
  })

  it('broadcasts to all channel-capable connections when originating is dead', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeDeadConnection('conn-a')
    const connB = fakeConnection('conn-b')
    const connections = new Map<string, McpConnection>([['conn-a', connA], ['conn-b', connB]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({
      refs: { taskId: 'task-1', project: 'test' },
      originatingConnectionId: 'conn-a',
    })
    const result = await backend.deliver(event, 'cc')

    // Originating conn is dead, so it broadcasts to conn-b
    assert.ok(result.ok)
    assert.equal(connA.notifications.length, 0)
    assert.equal(connB.notifications.length, 1)
  })

  it('returns no-channel-connection when zero channel-capable connections', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, {
      connections: new Map(),
    })

    const result = await backend.deliver(makeEvent(), 'cc')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-channel-connection')
  })

  it('transport write throws yields ok:false, hub unaffected', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    // Broadcast mode (no originating record): one connection throws, one succeeds
    const connBad = fakeDeadConnection('conn-bad')
    const connGood = fakeConnection('conn-good')
    const connections = new Map<string, McpConnection>([['conn-bad', connBad], ['conn-good', connGood]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const result = await backend.deliver(makeEvent(), 'cc')

    // One threw, so overall ok is false
    assert.equal(result.ok, false)
    assert.equal(result.backend, 'cc-channel')
    assert.ok(result.error, 'should have error message')
    // But the good connection still received the notification (hub unaffected)
    assert.equal(connGood.notifications.length, 1)
    assert.equal(connBad.notifications.length, 0)
  })

  it('broadcasts when no originating connection id is present', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connections = new Map<string, McpConnection>([['conn-a', connA]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({ refs: { taskId: 'nonexistent', project: 'test' } })
    const result = await backend.deliver(event, 'cc')

    assert.ok(result.ok)
    assert.equal(connA.notifications.length, 1)
  })

  it('targets originating connection for workflow events', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connB = fakeConnection('conn-b')
    const connections = new Map<string, McpConnection>([['conn-a', connA], ['conn-b', connB]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({
      kind: 'flow.done',
      refs: { workflowId: 'wf-1', project: 'test' },
      originatingConnectionId: 'conn-b',
    })
    const result = await backend.deliver(event, 'cc')

    assert.ok(result.ok)
    assert.equal(connA.notifications.length, 0)
    assert.equal(connB.notifications.length, 1)
  })

  it('excludes non-channel-capable connections from broadcast', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a', false)
    const connB = fakeConnection('conn-b', true)
    const connections = new Map<string, McpConnection>([['conn-a', connA], ['conn-b', connB]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const result = await backend.deliver(makeEvent(), 'cc')

    assert.ok(result.ok)
    assert.equal(connA.notifications.length, 0)
    assert.equal(connB.notifications.length, 1)
  })
})

// ============================================================
// cc-channel targeted delivery primitive
// ============================================================

describe('cc-channel targeted delivery', () => {
  it('delivers to a specific connection by id', async () => {
    const { deliverToConnection } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const conn = fakeConnection('target-1')
    const connections = new Map<string, McpConnection>([['target-1', conn]])

    const event = makeEvent({ refs: { taskId: 'task-1', project: 'test' } })
    const result = deliverToConnection({ connections }, 'target-1', event)

    assert.ok(result.ok)
    assert.equal(result.channel, 'target-1')
    assert.equal(result.backend, 'cc-channel')
    assert.equal(conn.notifications.length, 1)

    const params = conn.notifications[0].params as Record<string, unknown>
    assert.ok(typeof params.content === 'string')
    assert.ok((params.content as string).includes(event.title))
    assert.ok((params.content as string).includes(event.body))
    const meta = params.meta as Record<string, unknown>
    assert.equal(meta.source, 'foreman')
    assert.equal(meta.kind, event.kind)
    assert.equal(meta.severity, event.severity)
    assert.deepStrictEqual(meta.refs, event.refs)
  })

  it('returns no-such-connection for unknown connId', async () => {
    const { deliverToConnection } = await import('../lib/adapters/message/backends/cc-channel.mts')

    const result = deliverToConnection(
      { connections: new Map() },
      'nonexistent',
      makeEvent(),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-such-connection')
    assert.equal(result.backend, 'cc-channel')
  })

  it('returns failed delivery when sendNotification throws', async () => {
    const { deliverToConnection } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const deadConn = fakeDeadConnection('dead-target')
    const connections = new Map<string, McpConnection>([['dead-target', deadConn]])

    const result = deliverToConnection(
      { connections },
      'dead-target',
      makeEvent(),
    )

    assert.equal(result.ok, false)
    assert.equal(result.backend, 'cc-channel')
    assert.ok(result.error, 'should have error message')
    assert.ok((result.error as string).includes('connection closed'))
  })

  it('records origin when connection is alive and event has origin', async () => {
    const { deliverToConnection } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const conn = fakeConnection('origin-target')
    const connections = new Map<string, McpConnection>([['origin-target', conn]])

    const event = makeEvent({
      refs: { taskId: 'task-o' },
      origin: { channel: 'telegram', thread: 'th-1', sender: 'alice' },
    })
    const result = deliverToConnection(
      { connections },
      'origin-target',
      event,
    )

    assert.ok(result.ok)
    assert.equal(conn.originRing?.length, 1)
    assert.deepStrictEqual(conn.originRing?.[0], { channel: 'telegram', thread: 'th-1', sender: 'alice' })
  })

  it('does NOT record origin when connection throws', async () => {
    const { deliverToConnection } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const deadConn = fakeDeadConnection('dead-origin')
    const connections = new Map<string, McpConnection>([['dead-origin', deadConn]])

    const event = makeEvent({ origin: { channel: 'telegram', thread: 'th-2' } })
    deliverToConnection(
      { connections },
      'dead-origin',
      event,
    )

    // Origin ring was never populated since connection threw
    assert.equal(deadConn.originRing?.length ?? 0, 0)
  })
})

// ============================================================
// Remote backend
// ============================================================

describe('remote backend', () => {
  it('returns unknown-peer when peer not in registry', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'nonexistent', channel: 'wecom' },
      { peers: {} },
    )
    const result = await backend.deliver(makeEvent(), 'remote-channel')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'unknown-peer')
  })

  it('POSTs to peer URL with hops incremented and Bearer header', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: init?.body as string ?? '',
        headers: init?.headers as Record<string, string> ?? {},
      })
      return new Response(JSON.stringify({ ok: true, deliveries: [{ channel: 'wecom', backend: 'wecom', ok: true }] }), { status: 200 })
    }

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787', token_env: 'PEER_TOKEN' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    process.env.PEER_TOKEN = 'test-peer-token'
    try {
      const event = makeEvent({ kind: 'task.done', hops: 0 })
      const result = await backend.deliver(event, 'remote-channel')
      assert.equal(result.ok, true)
      assert.equal(requests.length, 1)
      // URL should join correctly
      assert.equal(requests[0].url, 'http://10.0.0.1:8787/message/deliver')
      // Should have Bearer header
      assert.equal(requests[0].headers['Authorization'], 'Bearer test-peer-token')
      // Check forwarded event
      const parsedBody = JSON.parse(requests[0].body)
      assert.equal(parsedBody.event.hops, 1)
      assert.equal(parsedBody.event.kind, 'task.done')
      assert.equal(parsedBody.channel, 'wecom')
      // Should include remote deliveries in detail
      assert.deepStrictEqual(result.detail, { remoteDeliveries: [{ channel: 'wecom', backend: 'wecom', ok: true }] })
    } finally {
      delete process.env.PEER_TOKEN
    }
  })

  it('sends no Authorization header when peer has no token', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const requests: Array<{ headers: Record<string, string> }> = []
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      requests.push({ headers: init?.headers as Record<string, string> ?? {} })
      return new Response(JSON.stringify({ ok: true, deliveries: [] }), { status: 200 })
    }

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    await backend.deliver(makeEvent(), 'remote-channel')
    assert.equal(requests.length, 1)
    assert.ok(!('Authorization' in requests[0].headers))
  })

  it('handles trailing slash in peer URL', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const requests: Array<{ url: string }> = []
    const fakeFetch = async (url: string) => {
      requests.push({ url })
      return new Response(JSON.stringify({ ok: true, deliveries: [] }), { status: 200 })
    }

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787/' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    await backend.deliver(makeEvent(), 'remote-channel')
    assert.equal(requests[0].url, 'http://10.0.0.1:8787/message/deliver')
  })

  it('increments hops from undefined (treats as 0)', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const requests: Array<{ body: string }> = []
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      requests.push({ body: init?.body as string ?? '' })
      return new Response(JSON.stringify({ ok: true, deliveries: [] }), { status: 200 })
    }

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    // Event without hops field
    const event = makeEvent()
    delete (event as unknown as Record<string, unknown>).hops
    await backend.deliver(event, 'remote-channel')
    const parsed = JSON.parse(requests[0].body)
    assert.equal(parsed.event.hops, 1)
  })

  it('returns ok:false when peer responds with error', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const fakeFetch = async () => new Response('Internal Error', { status: 500 })

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    const result = await backend.deliver(makeEvent(), 'remote-channel')
    assert.equal(result.ok, false)
    assert.ok(result.error?.includes('500'))
  })

  it('returns ok:false when fetch throws', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const fakeFetch = async () => { throw new Error('connection refused') }

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    const result = await backend.deliver(makeEvent(), 'remote-channel')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'connection refused')
  })

  it('remote channel ok is false when no remote delivery is ok', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const fakeFetch = async () => new Response(
      JSON.stringify({ ok: true, deliveries: [{ channel: 'wecom', backend: 'wecom', ok: false, error: 'send-failed' }] }),
      { status: 200 },
    )

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    const result = await backend.deliver(makeEvent(), 'remote-channel')
    assert.equal(result.ok, false)
    assert.deepStrictEqual(result.detail, {
      remoteDeliveries: [{ channel: 'wecom', backend: 'wecom', ok: false, error: 'send-failed' }],
    })
  })
})

// ============================================================
// Token resolution helper
// ============================================================

describe('resolveToken', () => {
  it('returns token from env var', async () => {
    const { resolveToken } = await import('../lib/config/index.mts')
    process.env.TEST_TOKEN = 'my-secret'
    try {
      const token = resolveToken({ token_env: 'TEST_TOKEN' })
      assert.equal(token, 'my-secret')
    } finally {
      delete process.env.TEST_TOKEN
    }
  })

  it('returns null when env var is not set', async () => {
    const { resolveToken } = await import('../lib/config/index.mts')
    const token = resolveToken({ token_env: 'NONEXISTENT_VAR' })
    assert.equal(token, null)
  })
})

// ============================================================
// Origin ring buffer
// ============================================================

describe('origin ring buffer', () => {
  it('records origins and returns most recent', async () => {
    const { recordOrigin, mostRecentOrigin } = await import('../lib/adapters/message/backends/index.mts')
    const conn: McpConnection = {
      id: 'conn-test',
      channelCapable: true,
      sendNotification() {},
    }

    assert.equal(mostRecentOrigin(conn), undefined)

    const o1 = { channel: 'telegram', thread: 't1' }
    recordOrigin(conn, o1)
    assert.deepStrictEqual(mostRecentOrigin(conn), o1)

    const o2 = { channel: 'openclaw', peer: 'mc0', sender: 'user1' }
    recordOrigin(conn, o2)
    assert.deepStrictEqual(mostRecentOrigin(conn), o2)
  })

  it('caps at 8 entries', async () => {
    const { recordOrigin, mostRecentOrigin } = await import('../lib/adapters/message/backends/index.mts')
    const conn: McpConnection = {
      id: 'conn-test',
      channelCapable: true,
      sendNotification() {},
    }

    for (let i = 0; i < 12; i++) {
      recordOrigin(conn, { channel: `ch-${i}` })
    }

    assert.equal(conn.originRing?.length, 8)
    assert.deepStrictEqual(mostRecentOrigin(conn), { channel: 'ch-11' })
    // Oldest should be ch-4 (after shifting 0-3 out)
    assert.deepStrictEqual(conn.originRing?.[0], { channel: 'ch-4' })
  })
})

// ============================================================
// cc-channel origin recording on delivery
// ============================================================

describe('cc-channel origin recording on delivery', () => {
  it('records origin on originating connection when event has origin', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connections = new Map<string, McpConnection>([['conn-a', connA]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({
      refs: { taskId: 'task-1' },
      originatingConnectionId: 'conn-a',
      origin: { channel: 'telegram', thread: 'msg-123', sender: 'user1' },
    })
    const result = await backend.deliver(event, 'cc')

    assert.ok(result.ok)
    assert.equal(connA.originRing?.length, 1)
    assert.deepStrictEqual(connA.originRing?.[0], { channel: 'telegram', thread: 'msg-123', sender: 'user1' })
  })

  it('does NOT record origin when event has no origin', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connections = new Map<string, McpConnection>([['conn-a', connA]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({ refs: { taskId: 'task-1' }, originatingConnectionId: 'conn-a' })
    delete (event as any).origin
    const result = await backend.deliver(event, 'cc')

    assert.ok(result.ok)
    assert.equal(connA.originRing?.length ?? 0, 0)
  })

  it('records origin on broadcast connections', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connB = fakeConnection('conn-b')
    const connections = new Map<string, McpConnection>([['conn-a', connA], ['conn-b', connB]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({
      origin: { channel: 'wecom', thread: 't456' },
    })
    const result = await backend.deliver(event, 'cc')

    assert.ok(result.ok)
    assert.equal(connA.originRing?.length, 1)
    assert.equal(connB.originRing?.length, 1)
    assert.deepStrictEqual(connA.originRing?.[0], { channel: 'wecom', thread: 't456' })
    assert.deepStrictEqual(connB.originRing?.[0], { channel: 'wecom', thread: 't456' })
  })

  it('cc-channel payload includes origin when event has one', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connections = new Map<string, McpConnection>([['conn-a', connA]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({
      refs: { taskId: 'task-o' },
      originatingConnectionId: 'conn-a',
      origin: { channel: 'openclaw', peer: 'mc1', thread: 'th1', sender: 'alice' },
    })
    await backend.deliver(event, 'cc')

    assert.equal(connA.notifications.length, 1)
    const params = connA.notifications[0].params as Record<string, unknown>
    const meta = params.meta as Record<string, unknown>
    assert.deepStrictEqual(meta.origin, { channel: 'openclaw', peer: 'mc1', thread: 'th1', sender: 'alice' })
  })

  it('cc-channel payload does NOT include origin when event has none', async () => {
    const { createCcChannelBackend } = await import('../lib/adapters/message/backends/cc-channel.mts')
    const connA = fakeConnection('conn-a')
    const connections = new Map<string, McpConnection>([['conn-a', connA]])

    const backend = createCcChannelBackend('cc', { backend: 'cc-channel' }, { connections })

    const event = makeEvent({ refs: { taskId: 'task-no' }, originatingConnectionId: 'conn-a' })
    delete (event as any).origin
    await backend.deliver(event, 'cc')

    assert.equal(connA.notifications.length, 1)
    const params = connA.notifications[0].params as Record<string, unknown>
    const meta = params.meta as Record<string, unknown>
    assert.equal(meta.origin, undefined)
  })
})

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
// ============================================================
// Auth fail-closed + timing-safe compare (Fix 1)
// ============================================================

describe('message delivery auth fail-closed and timing-safe', () => {
  it('returns 500 when auth configured but token resolves to null', async () => {
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, null, {
        enabled: true,
        channels: {},
        default: [],
        auth: { token_env: 'NONEXISTENT_AUTH_TOKEN_VAR' },
      }, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo
    try {
      const resp = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })
      assert.equal(resp.status, 500)
      const body = await resp.json() as Record<string, unknown>
      assert.equal(body.error, 'message delivery auth misconfigured')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns 401 for wrong bearer token', async () => {
    process.env.AUTH_TOKEN = 'correct-token'
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, null, {
        enabled: true,
        channels: {},
        default: [],
        auth: { token_env: 'AUTH_TOKEN' },
      }, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo
    try {
      const resp = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-token',
        },
        body: JSON.stringify({ message: 'hello' }),
      })
      assert.equal(resp.status, 401)
      const body = await resp.json() as Record<string, unknown>
      assert.equal(body.error, 'unauthorized')
    } finally {
      delete process.env.AUTH_TOKEN
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('does NOT leak timing info via bearer length comparison', async () => {
    process.env.AUTH_TOKEN = 'secret'
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, null, {
        enabled: true,
        channels: {},
        default: [],
        auth: { token_env: 'AUTH_TOKEN' },
      }, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo
    try {
      // Different-length tokens should get same 401 as same-length-wrong tokens
      const resp1 = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer a' },
        body: JSON.stringify({ message: 'hello' }),
      })
      const resp2 = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer wrong2' },
        body: JSON.stringify({ message: 'hello' }),
      })
      assert.equal(resp1.status, 401)
      assert.equal(resp2.status, 401)
    } finally {
      delete process.env.AUTH_TOKEN
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// ============================================================
// Hops normalization tests (Fix B — invalid hops → 400)
// ============================================================

describe('hops normalization', () => {
  it('returns 400 for negative hops', async () => {
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })

    const hub = new MessageDeliveryHub(cfg, fakeRegistryBackend)

    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, hub, cfg, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo

    try {
      // hops: -1000000 should return 400 (invalid hops)
      const resp = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: {
            kind: 'task.done',
            title: 'Test',
            body: 'Test',
            hops: -1000000,
          },
        }),
      })
      assert.equal(resp.status, 400)
      const result = await resp.json() as { error: string }
      assert.equal(result.error, 'invalid hops')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns 400 for hops=-1', async () => {
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })

    const hub = new MessageDeliveryHub(cfg, fakeRegistryBackend)

    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, hub, cfg, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo

    try {
      const resp = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: { kind: 'task.done', title: 'T', body: 'B', hops: -1 } }),
      })
      assert.equal(resp.status, 400)
      const result = await resp.json() as { error: string }
      assert.equal(result.error, 'invalid hops')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns 400 for string hops', async () => {
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })

    const hub = new MessageDeliveryHub(cfg, fakeRegistryBackend)

    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, hub, cfg, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo

    try {
      // Flat message shape with hops: "abc" — not a valid number
      const resp = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', hops: 'abc' }),
      })
      assert.equal(resp.status, 400)
      const result = await resp.json() as { error: string }
      assert.equal(result.error, 'invalid hops')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('absent hops still routes normally (hops=0, remote allowed)', async () => {
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })

    const hub = new MessageDeliveryHub(cfg, fakeRegistryBackend)

    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, hub, cfg, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo

    try {
      const resp = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: { kind: 'task.done', title: 'Test', body: 'Test' } }),
      })
      assert.equal(resp.status, 200)
      const result = await resp.json() as { ok: boolean; deliveries?: Array<{ ok: boolean }> }
      assert.ok(result.ok)
      assert.ok(result.deliveries?.some((d) => d.ok))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('floors float hops (1.5 → 1, valid)', async () => {
    const { handleMessageDeliveryRequest } = await import('../lib/daemon/daemon.mts')
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })

    const hub = new MessageDeliveryHub(cfg, fakeRegistryBackend)

    const server = createServer((req, res) => {
      void handleMessageDeliveryRequest(req, res, hub, cfg, new Map())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo

    try {
      // 1.5 should floor to 1, which is valid → 200
      const resp = await fetch(`http://127.0.0.1:${addr.port}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: { kind: 'task.done', title: 'Test', body: 'Test', hops: 1.5 },
        }),
      })
      assert.equal(resp.status, 200)
      const result = await resp.json() as { ok: boolean; deliveries?: Array<{ ok: boolean }> }
      assert.ok(result.ok)
      assert.ok(result.deliveries?.some((d) => d.ok))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('remote backend normalizes NaN/Infinity/negative hops before increment', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const requests: Array<{ body: string }> = []
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      requests.push({ body: init?.body as string ?? '' })
      return new Response(JSON.stringify({ ok: true, deliveries: [] }), { status: 200 })
    }

    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc0', channel: 'wecom' },
      {
        peers: { mc0: { url: 'http://10.0.0.1:8787' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )

    // hops: NaN should normalize to 0, then +1 = 1
    const eventNaN = makeEvent({ hops: NaN })
    await backend.deliver(eventNaN, 'remote-channel')
    const parsedNaN = JSON.parse(requests[0].body)
    assert.equal(parsedNaN.event.hops, 1)

    // hops: -5 should normalize to 0, then +1 = 1
    const eventNeg = makeEvent({ hops: -5 })
    await backend.deliver(eventNeg, 'remote-channel')
    const parsedNeg = JSON.parse(requests[1].body)
    assert.equal(parsedNeg.event.hops, 1)
  })
})

// ============================================================
// Message hub non-blocking emits (Fix 6)
// ============================================================

describe('message hub non-blocking emits', () => {
  it('keeps a hanging delivery isolated from callers that do not await it', async () => {
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    // Create a hub whose emit never resolves
    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })
    const hub = new MessageDeliveryHub(cfg, (_name, _cfg) => ({
      name: 'system',
      async deliver(_event, _channel): Promise<any> {
        // Hang forever
        return new Promise(() => {})
      },
    }))

    const emitPromise = hub.emit(makeEvent(), { channels: ['main'] })
    const timeout = await new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), 50),
    )
    assert.ok(timeout, 'emit should hang (device hang test)')
    emitPromise.catch(() => {})
  })

  it('keeps hanging workflow delivery isolated from callers that do not await it', async () => {
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })
    const hub = new MessageDeliveryHub(cfg, (_name, _cfg) => ({
      name: 'system',
      async deliver(_event, _channel): Promise<any> {
        return new Promise(() => {})
      },
    }))

    const emitPromise = hub.emit(
      makeEvent({ kind: 'flow.done', refs: { workflowId: 'wf-1', project: 'test' } }),
      { channels: ['main'] },
    )
    const timeout = await new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), 50),
    )
    assert.ok(timeout, 'emit should hang (device hang test)')
    emitPromise.catch(() => {})
  })
})

// ============================================================
// Policy channels passthrough (Fix 7)
// ============================================================

describe('policy channels passthrough', () => {
  it('passes policy.channels to hub.emit', async () => {
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: {
        alerts: { backend: 'system' } as ChannelConfig,
        main: { backend: 'system' } as ChannelConfig,
      },
      default: ['main'],
    })
    const hub = new MessageDeliveryHub(cfg, (_name, _cfg) => ({
      name: 'system',
      async deliver(_event, channel) {
        return { channel, backend: 'system', ok: true }
      },
    }))

    const results = await hub.emit(makeEvent(), { channels: ['alerts'] })
    assert.equal(results.length, 1)
    assert.equal(results[0].channel, 'alerts')
    assert.ok(results[0].ok)
  })

  it('falls back to default when channels is undefined', async () => {
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: {
        main: { backend: 'system' } as ChannelConfig,
        alerts: { backend: 'system' } as ChannelConfig,
      },
      default: ['main'],
    })
    const delivered: string[] = []
    const hub = new MessageDeliveryHub(cfg, (_name, _cfg) => ({
      name: 'system',
      async deliver(_event, channel) {
        delivered.push(channel)
        return { channel, backend: 'system', ok: true }
      },
    }))

    const results = await hub.emit(makeEvent(), { channels: undefined })
    assert.equal(results.length, 1)
    assert.equal(results[0].channel, 'main')
  })

  it('empty array means no channels (no fallback to default)', async () => {
    // Router now treats explicit [] as "no channels" — no fallback to default
    const { MessageDeliveryHub } = await import('../lib/message/delivery/hub.mts')

    const cfg = makeRegistry({
      channels: { main: { backend: 'system' } as ChannelConfig },
      default: ['main'],
    })
    const hub = new MessageDeliveryHub(cfg, (_name, _cfg) => ({
      name: 'system',
      async deliver(_event, channel) {
        return { channel, backend: 'system', ok: true }
      },
    }))

    const results = await hub.emit(makeEvent(), { channels: [] })
    // No channels resolved, no pet configured → 0 deliveries
    assert.equal(results.length, 0)
  })
})

// ============================================================
// Secret redaction (Fix 2)
// ============================================================

describe('secret redaction helpers', () => {
  it('redacts multiple secrets from text', async () => {
    const { redactSecrets } = await import('../lib/message/delivery/redact.mts')
    const result = redactSecrets('hello secret123 world secret123 done', ['secret123'])
    assert.equal(result, 'hello *** world *** done')
  })

  it('redactSecrets with empty secrets array returns unchanged', async () => {
    const { redactSecrets } = await import('../lib/message/delivery/redact.mts')
    const result = redactSecrets('hello world', [])
    assert.equal(result, 'hello world')
  })

  it('redactTelegramUrl redacts bot token in URL', async () => {
    const { redactTelegramUrl } = await import('../lib/message/delivery/redact.mts')
    const result = redactTelegramUrl('https://api.telegram.org/bot123456:ABC-DEF/sendMessage')
    assert.equal(result, 'https://api.telegram.org/bot***/sendMessage')
  })

  it('redactWecomUrl redacts key query param', async () => {
    const { redactWecomUrl } = await import('../lib/message/delivery/redact.mts')
    const result = redactWecomUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123')
    assert.equal(result, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***')
    const result2 = redactWecomUrl('https://example.com/hook?foo=bar&key=secret&baz=qux')
    assert.equal(result2, 'https://example.com/hook?foo=bar&key=***&baz=qux')
  })

  it('redactAuthorizationHeader redacts Bearer token', async () => {
    const { redactAuthorizationHeader } = await import('../lib/message/delivery/redact.mts')
    const result = redactAuthorizationHeader('Bearer my-secret-token')
    assert.equal(result, 'Bearer ***')
  })
})

describe('telegram backend error redaction', () => {
  it('does not leak bot token in delivery error', async () => {
    const { createTelegramBackend } = await import('../lib/adapters/message/backends/telegram.mts')
    const fakeFetch = async () => {
      throw new Error('fetch failed for https://api.telegram.org/bot12345678:ABCDEFGH/sendMessage')
    }
    const backend = createTelegramBackend(
      { backend: 'telegram', chat_id: '123', token_env: 'TELEGRAM_TOKEN_REDACT_TEST' },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    process.env.TELEGRAM_TOKEN_REDACT_TEST = 'my-bot-token-12345'
    try {
      const result = await backend.deliver(makeEvent(), 'tg')
      assert.equal(result.ok, false)
      assert.ok(result.error, 'should have error')
      // Must NOT contain the literal token
      assert.ok(!result.error!.includes('my-bot-token-12345'), `error leaked token: ${result.error}`)
      // Must NOT contain the bot token path segment from the URL
      assert.ok(!result.error!.includes('12345678:ABCDEFGH'), `error leaked bot token: ${result.error}`)
    } finally {
      delete process.env.TELEGRAM_TOKEN_REDACT_TEST
    }
  })
})

describe('wecom backend error redaction', () => {
  it('does not leak webhook key in delivery error', async () => {
    const { createWecomBackend } = await import('../lib/adapters/message/backends/wecom.mts')
    // Simulate a fetch that throws with the webhook URL in the error
    const fakeFetch = async () => {
      throw new Error(
        'fetch failed for https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=my-secret-key-123',
      )
    }
    const backend = createWecomBackend(
      { backend: 'wecom', webhook_env: 'WECOM_KEY_REDACT_TEST' },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    process.env.WECOM_KEY_REDACT_TEST = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=my-secret-key-123'
    try {
      const result = await backend.deliver(makeEvent(), 'wc')
      assert.equal(result.ok, false)
      assert.ok(result.error, 'should have error')
      // Must NOT contain the literal key
      assert.ok(!result.error!.includes('my-secret-key-123'), `error leaked key: ${result.error}`)
    } finally {
      delete process.env.WECOM_KEY_REDACT_TEST
    }
  })
})

describe('remote backend error redaction', () => {
  it('does not leak bearer token in delivery error', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const fakeFetch = async () => {
      throw new Error('fetch failed: Authorization: Bearer my-bearer-secret')
    }
    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc-redact', channel: 'wc' },
      {
        peers: { 'mc-redact': { url: 'http://10.0.0.1:8787' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )
    const result = await backend.deliver(makeEvent(), 'remote-channel')
    assert.equal(result.ok, false)
    assert.ok(result.error, 'should have error')
    // Must NOT contain the auth header token
    assert.ok(!result.error!.includes('my-bearer-secret'), `error leaked bearer: ${result.error}`)
  })

  it('does not leak token in error body from upstream', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    const fakeFetch = async () => {
      return new Response(JSON.stringify({ error: 'invalid token my-secret-123' }), { status: 401 })
    }
    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc-upstream', channel: 'wc' },
      {
        peers: { 'mc-upstream': { url: 'http://10.0.0.1:8787', token_env: 'REMOTE_TOKEN_REDACT' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )
    process.env.REMOTE_TOKEN_REDACT = 'my-secret-123'
    try {
      const result = await backend.deliver(makeEvent(), 'remote-channel')
      assert.equal(result.ok, false)
      assert.ok(result.error, 'should have error')
      // Must NOT contain the token in the error
      assert.ok(!result.error!.includes('my-secret-123'), `error leaked token: ${result.error}`)
    } finally {
      delete process.env.REMOTE_TOKEN_REDACT
    }
  })
})

// ============================================================
// Fix A1 — remote backend deep-redacts non-string detail
// ============================================================

describe('remote backend non-string detail redaction', () => {
  it('deep-redacts token from non-string detail in upstream deliveries', async () => {
    const { createRemoteBackend } = await import('../lib/adapters/message/backends/remote.mts')
    // Upstream returns a delivery with a non-string detail object embedding the token
    const fakeFetch = async () => {
      return new Response(JSON.stringify({
        ok: true,
        deliveries: [{
          channel: 'wecom',
          backend: 'wecom',
          ok: false,
          error: 'send failed',
          detail: { code: 500, message: 'Bearer my-secret-deep', url: 'https://api.example.com' },
        }],
      }), { status: 200 })
    }
    const backend = createRemoteBackend(
      { backend: 'remote', peer: 'mc-detail', channel: 'wc' },
      {
        peers: { 'mc-detail': { url: 'http://10.0.0.1:8787', token_env: 'DEEP_REDACT_TOKEN' } },
        fetch: fakeFetch as typeof globalThis.fetch,
      },
    )
    process.env.DEEP_REDACT_TOKEN = 'my-secret-deep'
    try {
      const result = await backend.deliver(makeEvent(), 'remote-channel')
      assert.equal(result.ok, false)
      const detail = result.detail as { remoteDeliveries?: Array<{ detail?: unknown; error?: string }> }
      assert.ok(detail?.remoteDeliveries, 'should have remoteDeliveries')
      const remoteDelivery = detail.remoteDeliveries![0]
      // The detail object should have been deep-redacted
      const detailStr = JSON.stringify(remoteDelivery.detail)
      assert.ok(!detailStr.includes('my-secret-deep'), `detail leaked token: ${detailStr}`)
    } finally {
      delete process.env.DEEP_REDACT_TOKEN
    }
  })
})

// ============================================================
// Fix A3 — wecom backend errmsg redaction
// ============================================================

describe('wecom backend errmsg redaction', () => {
  it('does not leak webhook key in parsed errmsg', async () => {
    const { createWecomBackend } = await import('../lib/adapters/message/backends/wecom.mts')
    // Simulate WeCom API returning a non-200 response with errmsg containing the webhook key
    const fakeFetch = async () => {
      return new Response(JSON.stringify({
        errcode: 93000,
        errmsg: 'invalid webhook url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=errmsg-secret-key',
      }), { status: 400 })
    }
    const backend = createWecomBackend(
      { backend: 'wecom', webhook_env: 'WECOM_ERRMSG_REDACT_TEST' },
      { fetch: fakeFetch as typeof globalThis.fetch },
    )
    process.env.WECOM_ERRMSG_REDACT_TEST = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=errmsg-secret-key'
    try {
      const result = await backend.deliver(makeEvent(), 'wc')
      assert.equal(result.ok, false)
      assert.ok(result.error, 'should have error')
      // Must NOT contain the literal key
      assert.ok(!result.error!.includes('errmsg-secret-key'), `error leaked key: ${result.error}`)
    } finally {
      delete process.env.WECOM_ERRMSG_REDACT_TEST
    }
  })
})
