/**
 * Focused coverage for the memory-search auxiliary parsing in `memory.ts`:
 * the shared select_memories shape, the classified failure reasons and the one
 * bounded correction round. Every test drives the real `runMemorySearch` over a
 * scripted stub host, so no model, network, daemon or socket is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMemorySearch, type MemorySearchHost } from '../src/auxiliary/memory.ts';
import type { BuiltView, InvokedCall } from '../src/ports.ts';
import type { LedgerEvent, LedgerEventDraft } from '../src/ledger/store.ts';
import type { SessionRuntime, TurnRuntime } from '../src/turn/runtime.ts';

const MEMORY_INDEX = ['# Memories', '- [alpha](memories/alpha.md)', '- [beta](memories/beta.md)'].join('\n');

/** A successful outcome carrying `count` select_memories tool calls. */
function selectReply(spanId: string, args: string, count = 1): InvokedCall {
  return {
    ok: true,
    spanId,
    text: '',
    toolCalls: Array.from({ length: count }, (_, index) => ({
      index, id: `call-${index}`, name: 'select_memories', arguments: args,
    })),
  };
}

/** A successful outcome that returned no tool call. */
function textReply(spanId: string, text = 'DONE'): InvokedCall {
  return { ok: true, spanId, text, toolCalls: [] };
}

function makeHost(replies: readonly InvokedCall[]) {
  const appended: LedgerEventDraft[] = [];
  const invokes: { view: BuiltView }[] = [];
  const host = {
    ports: { memory: undefined },
    ledger: {
      read: () => [] as LedgerEvent[],
      append: async (_sessionId: string, draft: LedgerEventDraft) => {
        appended.push(draft);
        return draft as unknown as LedgerEvent;
      },
    },
    invoke: async (
      _session: SessionRuntime,
      _turn: TurnRuntime,
      _role: string,
      view: BuiltView,
    ): Promise<InvokedCall> => {
      invokes.push({ view });
      const reply = replies[invokes.length - 1];
      return reply ?? { ok: false, spanId: 'overflow', text: '', error: 'unexpected extra invoke' };
    },
  };
  return { host: host as unknown as MemorySearchHost, appended, invokes };
}

function makeSession(): SessionRuntime {
  return {
    sessionId: 's1',
    workspaceRoot: 'workspace',
    snapshot: { memoryIndex: MEMORY_INDEX },
    files: { read: (path: string) => ({ path, title: path, content: `body of ${path}` }) },
  } as unknown as SessionRuntime;
}

function makeTurn(): TurnRuntime {
  return { turn: 1, userText: 'hi', abort: new AbortController(), finished: false } as unknown as TurnRuntime;
}

/**
 * The ledger draft whose `type` accepts `T`. A plain `Extract` resolves to
 * `never` for the system notices, because `system.info`, `system.warning` and
 * `system.error` share one member with a union-typed `type` field. Distributing
 * over the union keeps such a member matched, so its extra fields stay readable.
 */
type EventOfType<T extends LedgerEventDraft['type'], E = LedgerEventDraft> = E extends { type: infer K }
  ? T extends K
    ? E
    : never
  : never;

function eventsOfType<T extends LedgerEventDraft['type']>(
  events: readonly LedgerEventDraft[],
  type: T,
): EventOfType<T>[] {
  return events.filter((event): event is EventOfType<T> => event.type === type);
}

/** The correction text the second invocation carried, if any. */
function userContent(view: BuiltView): string {
  const content = view.messages[1]?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

test('a single valid select_memories result publishes the picks and warns nothing', async () => {
  const args = JSON.stringify({ picks: [{ path: 'memories/alpha.md', reason: 'relevant now' }] });
  const { host, appended, invokes } = makeHost([selectReply('span-1', args)]);
  await runMemorySearch(host, makeSession(), makeTurn(), 1);

  assert.equal(invokes.length, 1);
  const recalled = eventsOfType(appended, 'memory.recalled');
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0]!.path, 'memories/alpha.md');
  assert.equal(recalled[0]!.source, 'memory-search');
  assert.equal(recalled[0]!.parent, 'span-1');
  assert.equal(recalled[0]!.content, 'body of memories/alpha.md');
  assert.deepEqual(eventsOfType(appended, 'system.warning'), []);
});

test('two JSON objects plus interleaved text are ambiguous, then a valid correction publishes', async () => {
  const ambiguous = [
    JSON.stringify({ picks: [{ path: 'memories/alpha.md', reason: 'first object' }] }),
    'DONE',
    JSON.stringify({ picks: [] }),
  ].join('\n\n');
  const valid = JSON.stringify({ picks: [{ path: 'memories/beta.md', reason: 'corrected' }] });
  const { host, appended, invokes } = makeHost([selectReply('span-1', ambiguous), selectReply('span-2', valid)]);
  await runMemorySearch(host, makeSession(), makeTurn(), 1);

  // Exactly one correction round, classified as ambiguous in the correction input.
  assert.equal(invokes.length, 2);
  assert.match(userContent(invokes[1]!.view), /ambiguous/);
  assert.match(userContent(invokes[1]!.view), /exactly once with a single valid JSON object/);
  // The first object of the rejected payload is never extracted: only the
  // correction's pick is published, under the corrected span.
  const recalled = eventsOfType(appended, 'memory.recalled');
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0]!.path, 'memories/beta.md');
  assert.equal(recalled[0]!.parent, 'span-2');
  assert.deepEqual(eventsOfType(appended, 'system.warning'), []);
});

test('two malformed attempts warn once with the classified reason and publish nothing', async () => {
  const ambiguous = `${JSON.stringify({ picks: [] })}\n\nDONE\n${JSON.stringify({ picks: [] })}`;
  const wrongShape = JSON.stringify({ picks: 'not-an-array' });
  const { host, appended, invokes } = makeHost([selectReply('span-1', ambiguous), selectReply('span-2', wrongShape)]);
  await runMemorySearch(host, makeSession(), makeTurn(), 1);

  assert.equal(invokes.length, 2);
  const warnings = eventsOfType(appended, 'system.warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.code, 'memory-search');
  assert.equal(warnings[0]!.source, 'system');
  assert.equal(warnings[0]!.parent, 'span-2');
  assert.match(warnings[0]!.message, /must contain a picks array/);
  assert.deepEqual(eventsOfType(appended, 'memory.recalled'), []);
});

test('no tool call on the first attempt triggers exactly one correction round', async () => {
  const valid = JSON.stringify({ picks: [{ path: 'memories/alpha.md', reason: 'retried' }] });
  const { host, appended, invokes } = makeHost([textReply('span-1'), selectReply('span-2', valid)]);
  await runMemorySearch(host, makeSession(), makeTurn(), 1);

  assert.equal(invokes.length, 2);
  assert.match(userContent(invokes[1]!.view), /no select_memories call/);
  assert.equal(eventsOfType(appended, 'memory.recalled').length, 1);
  assert.deepEqual(eventsOfType(appended, 'system.warning'), []);
});

test('two select_memories calls on the first attempt trigger exactly one correction round', async () => {
  const valid = JSON.stringify({ picks: [{ path: 'memories/beta.md', reason: 'retried' }] });
  const empty = JSON.stringify({ picks: [] });
  const { host, appended, invokes } = makeHost([selectReply('span-1', empty, 2), selectReply('span-2', valid)]);
  await runMemorySearch(host, makeSession(), makeTurn(), 1);

  assert.equal(invokes.length, 2);
  assert.match(userContent(invokes[1]!.view), /2 calls/);
  assert.equal(eventsOfType(appended, 'memory.recalled').length, 1);
  assert.deepEqual(eventsOfType(appended, 'system.warning'), []);
});

test('a failed second attempt of a correction round stops after one retry', async () => {
  const { host, appended, invokes } = makeHost([
    textReply('span-1'),
    { ok: false, spanId: 'span-2', text: '', error: 'transport failed' },
  ]);
  await runMemorySearch(host, makeSession(), makeTurn(), 1);

  assert.equal(invokes.length, 2);
  const warnings = eventsOfType(appended, 'system.warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /transport failed/);
  assert.deepEqual(eventsOfType(appended, 'memory.recalled'), []);
});

const SHAPE_CASES: { name: string; args: string; pattern: RegExp }[] = [
  { name: 'missing field', args: JSON.stringify({ picks: [{ path: 'memories/alpha.md' }] }), pattern: /missing the field: reason/ },
  { name: 'extra field', args: JSON.stringify({ picks: [{ path: 'memories/alpha.md', reason: 'r', note: 'n' }] }), pattern: /unknown field: note/ },
  { name: 'wrong type', args: JSON.stringify({ picks: [{ path: 'memories/alpha.md', reason: 7 }] }), pattern: /needs a reason string/ },
  { name: 'picks not an array', args: JSON.stringify({ picks: 'nope' }), pattern: /must contain a picks array/ },
  {
    name: 'too many picks',
    args: JSON.stringify({ picks: [1, 2, 3, 4].map((n) => ({ path: 'memories/alpha.md', reason: `r${n}` })) }),
    pattern: /more than 3 picks/,
  },
  { name: 'unknown target', args: JSON.stringify({ picks: [{ path: 'memories/gamma.md', reason: 'r' }] }), pattern: /not in the memory index/ },
  { name: 'invalid JSON', args: '{"picks":[}', pattern: /is not valid JSON/ },
];

for (const shapeCase of SHAPE_CASES) {
  test(`invalid shape is classified distinctly: ${shapeCase.name}`, async () => {
    const { host, appended, invokes } = makeHost([
      selectReply('span-1', shapeCase.args),
      selectReply('span-2', shapeCase.args),
    ]);
    await runMemorySearch(host, makeSession(), makeTurn(), 1);

    // One correction round only, and the classified reason reaches the warning.
    assert.equal(invokes.length, 2);
    const warnings = eventsOfType(appended, 'system.warning');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, shapeCase.pattern);
    assert.equal(warnings[0]!.code, 'memory-search');
    assert.deepEqual(eventsOfType(appended, 'memory.recalled'), []);
  });
}
