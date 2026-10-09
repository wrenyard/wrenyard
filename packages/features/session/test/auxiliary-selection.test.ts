import assert from 'node:assert/strict';
import test from 'node:test';
import { createCallRunner, ModelCallError, type AuxiliaryRoute, type CallLedgerEventDraft } from '../src/calls.ts';

test('auxiliary calls select freshly per role and ledger retains route order and efforts', async () => {
  const events: CallLedgerEventDraft[] = [];
  const roles: string[] = [];
  const chosen: AuxiliaryRoute[][] = [
    [{ model: 'openai/gpt-6.1-sol', reasoningEffort: 'none' }, { model: 'openai/gpt-6-luna', reasoningEffort: 'none' }],
    [{ model: 'openai/gpt-6-luna', reasoningEffort: 'low' }],
  ];
  const seen: { model: string; effort?: string }[] = [];
  const runner = createCallRunner({ selectAuxiliary: role => { roles.push(role); return chosen[roles.length - 1]!; },
    driver: { complete: async request => { seen.push({ model: request.model, effort: request.reasoningEffort }); return { text: 'ok' }; } },
    append: event => { events.push(event); } });
  for (const role of ['title', 'reply'] as const) await runner.run({ callId: role, role, messages: [], layers: {}, signal: new AbortController().signal });
  assert.deepEqual(roles, ['title', 'reply']);
  assert.deepEqual(seen, chosen.map(routes => ({ model: routes[0]!.model, effort: routes[0]!.reasoningEffort })));
  const calls = events.filter(event => event.type === 'call');
  assert.equal(calls.length, 2);
  calls.forEach((call, index) => {
    assert.equal(call.model, chosen[index]![0]!.model);
    assert.deepEqual(call.routeCandidates, chosen[index]);
    assert.equal(call.requestedReasoningEffort, 'none'); assert.equal(call.reasoningEffort, chosen[index]![0]!.reasoningEffort);
  });
});
test('a no-candidate failure is recorded once with the role and never calls the driver', async () => {
  const events: CallLedgerEventDraft[] = []; let driverCalls = 0;
  const runner = createCallRunner({ selectAuxiliary: role => { throw new Error(`Auxiliary role ${role}: no candidate qualified (context below minimum)`); },
    driver: { complete: async () => { driverCalls++; return { text: '' }; } }, append: event => { events.push(event); } });
  await assert.rejects(runner.run({ callId: 'failed', role: 'doc-search', messages: [], layers: {}, signal: new AbortController().signal }),
    error => error instanceof ModelCallError && /doc-search.*context below minimum/.test(error.message));
  const calls = events.filter(event => event.type === 'call'); assert.equal(calls.length, 1);
  assert.equal(calls[0]!.status, 'failed'); assert.equal(calls[0]!.requestedReasoningEffort, 'none');
  assert.equal(calls[0]!.reasoningEffort, undefined); assert.equal(driverCalls, 0);
});
