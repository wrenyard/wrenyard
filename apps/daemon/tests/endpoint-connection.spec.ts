import { expect, it } from 'vitest'

import { endpointConnection } from '../lib/daemon/services/endpoint-connection.mts'

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R5, approved case).
it('uses the configured endpoint as a chat connection', async () => {
  const fetch = async (url: string) =>
    url === 'https://models.example/api/v4/models'
      ? Response.json({ data: [{ id: 'any-model' }] })
      : new Response(null, { status: 404 })

  const connection = await endpointConnection(
    { url: 'https://models.example/api/v4', token: 'test-key' },
    fetch,
  )

  expect(connection).toMatchObject({
    openaiChatBaseUrl: 'https://models.example/api/v4',
    token: 'test-key',
    models: [{ publicId: 'any-model', protocols: ['openai_chat'] }],
  })
})
