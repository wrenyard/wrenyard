import { describe, expect, it } from 'vitest';
import type { GatewayConnection } from '@wrenyard/protocol/gateway';

import { adapterForProtocol, createModelTransport, type ModelRequest, type SessionProtocol } from '../src/transport/index.ts';

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R1, approved case).
const STANDARD_FIELDS = [
  ['openai_chat', 'high', { reasoning_effort: 'high' }],
  ['openai_responses', 'high', { reasoning: { summary: 'auto', effort: 'high' } }],
  ['anthropic_messages', 'high', { thinking: { type: 'enabled' }, output_config: { effort: 'high' } }],
  ['anthropic_messages', 'none', { thinking: { type: 'disabled' } }],
] as const satisfies readonly (readonly [SessionProtocol, ModelRequest['reasoningEffort'], Record<string, unknown>])[];

function request(protocol: SessionProtocol, reasoningEffort: ModelRequest['reasoningEffort']): ModelRequest {
  return {
    model: 'example-model',
    messages: [{ role: 'user', content: 'hello' }],
    reasoningEffort,
    signal: new AbortController().signal,
  };
}

describe('session model transport reasoning effort', () => {
  it.each(STANDARD_FIELDS)('sends the reasoning effort in the %s standard field', (protocol, effort, expected) => {
    const adapter = adapterForProtocol(protocol);
    if (adapter === undefined) throw new Error(`No adapter for ${protocol}`);
    const body: unknown = JSON.parse(adapter.serialize(request(protocol, effort)));
    expect(body).toMatchObject(expected);
  });
});

// Source: docs/specs/2026-11-05-standard-protocol-access.md (R2, approved case).
describe('session model transport model identity', () => {
  it('sends the model id exactly as the endpoint lists it', async () => {
    const id = 'example-provider/example-model';
    const connection: GatewayConnection = {
      openaiChatBaseUrl: 'http://127.0.0.1/gateway/openai-chat/v1',
      openaiResponsesBaseUrl: 'http://127.0.0.1/gateway/openai-responses/v1',
      anthropicBaseUrl: 'http://127.0.0.1/gateway/anthropic/v1',
      token: 'test-token',
      models: [{ id, publicId: id, provider: 'example-provider', protocols: ['openai_chat'], displayName: 'Example Model' }],
    };
    let sent: { model?: string } | undefined;
    const transport = createModelTransport({
      gateway: async () => connection,
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as { model?: string };
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    await transport.complete({
      model: id,
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'default',
      signal: new AbortController().signal,
    });
    expect(sent?.model).toBe(connection.models[0]!.id);
  });
});
