import { expect, it } from 'vitest'

import type { ReasoningEffort } from '@wrenyard/models'
import { createCallRunner } from '@wrenyard/session'
import { createModelTransport } from '@wrenyard/model-call/transport'

import { resolveAuxiliaryModel } from '../lib/daemon/services/auxiliary-model.mts'
import { endpointConnection } from '../lib/daemon/services/endpoint-connection.mts'

/**
 * In-process Chat endpoint: it lists its models and records the model id of
 * every chat request it receives.
 */
class FakeEndpoint {
  private static readonly byUrl = new Map<string, FakeEndpoint>()

  readonly config: { url: string; token: string }
  readonly requestedModels: string[] = []

  constructor(private readonly models: readonly string[]) {
    this.config = { url: `https://endpoint.example/${models.join('-')}`, token: 'test-key' }
    FakeEndpoint.byUrl.set(this.config.url, this)
  }

  static fetchFor(url: string): typeof fetch {
    const endpoint = FakeEndpoint.byUrl.get(url)
    if (endpoint === undefined) throw new Error(`Unknown fake endpoint: ${url}`)
    return endpoint.fetch
  }

  private readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === `${this.config.url}/models`) {
      return Response.json({ data: this.models.map((id) => ({ id })) })
    }
    if (url === `${this.config.url}/chat/completions`) {
      const body = JSON.parse(String(init?.body)) as { model?: unknown }
      if (typeof body.model === 'string') this.requestedModels.push(body.model)
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(null, { status: 404 })
  }
}

/** Run one auxiliary call through the real selection, call runner and transport. */
async function runAuxiliaryCall(
  role: 'search',
  config: {
    endpoint: { url: string; token: string }
    models: { auxiliary: { model: string; reasoningEffort: ReasoningEffort } }
  },
): Promise<void> {
  const fetch = FakeEndpoint.fetchFor(config.endpoint.url)
  const connection = await endpointConnection(config.endpoint, fetch)
  const runner = createCallRunner({
    models: async () => connection.models,
    transport: createModelTransport({ gateway: async () => connection, fetch }),
    resolveAuxiliaryModel: () =>
      resolveAuxiliaryModel(config, async () => {
        throw new Error('gateway route selection must not run with a configured endpoint')
      }),
    append: () => {},
  })
  await runner.run({
    spanId: 'span-1',
    parent: 'action-1',
    role,
    messages: [{ role: 'user', content: 'hello' }],
    layers: {},
    signal: new AbortController().signal,
  })
}

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R6, approved case).
it('sends the configured auxiliary model to the endpoint', async () => {
  const endpoint = new FakeEndpoint(['model-a', 'model-b'])
  const config = {
    endpoint: endpoint.config,
    models: { auxiliary: { model: 'model-b', reasoningEffort: 'high' as const } },
  }

  await runAuxiliaryCall('search', config)

  expect(endpoint.requestedModels).toEqual(['model-b'])
})
