import { describe, expect, it } from 'vitest';
import { adapterForProtocol, type ModelRequest, type SessionProtocol } from '../src/transport/index.ts';

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
