import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentClient, AgentEvent, AgentRequest, AgentSession, ClientStatus } from '@wrenyard/clients';
import { ExecReplayBuffer } from '../src/replay.ts';
import { ExecService } from '../src/service.ts';
import type { ExecutionFeature } from '@wrenyard/agent-client';

/** A controllable session whose events and result the test drives directly. */
function controlledSession(): {
  session: AgentSession;
  emit: (event: AgentEvent) => void;
  end: (exitCode: number | null) => void;
  cancelled: () => boolean;
} {
  const queued: AgentEvent[] = [];
  const waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  const closed = { value: false };
  let cancelCalled = false;
  let settle: (exitCode: number | null) => void = () => undefined;
  const result = new Promise<{ exitCode: number | null }>((resolve) => {
    settle = (exitCode) => resolve({ exitCode });
  });
  const emit = (event: AgentEvent): void => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queued.push(event);
  };
  return {
    emit,
    end: (exitCode) => {
      closed.value = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true });
      settle(exitCode);
    },
    cancelled: () => cancelCalled,
    session: {
      events: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queued.length > 0) {
              yield queued.shift()!;
              continue;
            }
            if (closed.value) return;
            const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => { waiters.push(resolve); });
            if (next.done) return;
            yield next.value;
          }
        },
      },
      result,
      cancel: async () => { cancelCalled = true; },
      diagnostics: { pid: 1234 },
    },
  };
}

function stubClient(session: AgentSession, capture?: { request?: AgentRequest }): AgentClient {
  return {
    id: 'stub',
    capabilities: { run: true, account: false, resume: false },
    inspect: (): Promise<ClientStatus> => Promise.resolve({ installation: { state: 'missing' }, authentication: 'unknown' }),
    start: async (request: AgentRequest): Promise<AgentSession> => {
      if (capture) capture.request = request;
      return session;
    },
  };
}

const BASE_REQUEST = { model: 'gpt-5-codex', prompt: 'Hello.', cwd: '/workspace', client: 'stub' };

test('retains events under both ceilings and reports an eviction gap', () => {
  const buffer = new ExecReplayBuffer({ maxEvents: 2, maxBytes: 1024 });
  buffer.append('e1', { type: 'a' });
  buffer.append('e1', { type: 'b' });
  buffer.append('e1', { type: 'c' });

  const fresh = buffer.read(2);
  assert.equal(fresh.kind, 'events');
  assert.deepEqual(fresh.kind === 'events' ? fresh.events.map((entry) => entry.seq) : [], [3]);

  // Sequence 1 is gone, so a cursor of 0 can no longer be satisfied.
  const expired = buffer.read(0);
  assert.equal(expired.kind, 'cursor-expired');
  assert.equal(expired.kind === 'cursor-expired' ? expired.oldestRetainedSeq : 0, 2);
  assert.equal(buffer.nextSeq, 4);
});

test('enforces the byte ceiling independently of the count ceiling', () => {
  const buffer = new ExecReplayBuffer({ maxEvents: 100, maxBytes: 8 });
  buffer.append('e1', { type: 'x', text: 'abcdefghij' });
  buffer.append('e1', { type: 'y', text: 'klmnopqrst' });
  assert.ok(buffer.size < 2, 'large records must be evicted by bytes');
  assert.ok(buffer.oldestRetainedSeq > 1);
});

test('reading never evicts, so repeated reads are stable', () => {
  const buffer = new ExecReplayBuffer({ maxEvents: 3, maxBytes: 1024 });
  buffer.append('e1', { type: 'a' });
  buffer.append('e1', { type: 'b' });
  const first = buffer.read(0);
  const second = buffer.read(0);
  assert.deepEqual(first, second);
  assert.equal(buffer.size, 2);
});

test('drains the client stream once and reports a completed snapshot', async () => {
  const controlled = controlledSession();
  const service = new ExecService({ clients: new Map([['stub', stubClient(controlled.session)]]) });
  const handle = await service.start({ ...BASE_REQUEST });
  assert.equal(service.get(handle.id)?.status, 'running');

  controlled.emit({ type: 'output', record: { type: 'message', text: 'hi' } });
  controlled.emit({ type: 'exit', exitCode: 0, signal: null });
  controlled.end(0);
  await handle.result;
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const events = service.events(handle.id, 0);
  assert.deepEqual(events.map((entry) => entry.seq), [1, 2]);
  const snapshot = service.get(handle.id);
  assert.equal(snapshot?.status, 'completed');
  assert.equal(snapshot?.exitCode, 0);
  assert.equal(snapshot?.client, 'stub');
});

test('replays the same history to two independent readers', async () => {
  const controlled = controlledSession();
  const service = new ExecService({ clients: new Map([['stub', stubClient(controlled.session)]]) });
  const handle = await service.start({ ...BASE_REQUEST });
  controlled.emit({ type: 'output', record: { type: 'message', text: 'one' } });
  controlled.emit({ type: 'output', record: { type: 'message', text: 'two' } });
  controlled.emit({ type: 'exit', exitCode: 0, signal: null });
  controlled.end(0);
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const first: AgentEvent[] = [];
  for await (const event of handle.events) first.push(event);
  const second: AgentEvent[] = [];
  for await (const event of handle.events) second.push(event);
  assert.equal(first.length, 3);
  assert.deepEqual(second, first, 'a second reader must not be starved by the first');
});

test('rejects an unknown feature before the client is started', async () => {
  let started = false;
  const controlled = controlledSession();
  const client = stubClient(controlled.session);
  const service = new ExecService({
    clients: new Map([['stub', { ...client, start: async () => { started = true; return controlled.session; } }]]),
    features: new Map<string, ExecutionFeature>([['known', { id: 'known', mcpServers: {} }]]),
  });
  await assert.rejects(
    service.start({ ...BASE_REQUEST, features: ['known', 'missing'] }),
    /Unknown execution feature/,
  );
  assert.equal(started, false);
});

test('merges feature MCP servers and appends instructions to the prompt', async () => {
  const capture: { request?: AgentRequest } = {};
  const controlled = controlledSession();
  const features = new Map<string, ExecutionFeature>([
    ['a', { id: 'a', instructions: 'First instruction.', mcpServers: { alpha: { transport: 'http', url: 'http://a' } } }],
    ['b', { id: 'b', instructions: 'Second instruction.', mcpServers: { beta: { transport: 'stdio', command: 'beta' } } }],
  ]);
  const service = new ExecService({
    clients: new Map([['stub', stubClient(controlled.session, capture)]]),
    features,
  });
  await service.start({ ...BASE_REQUEST, features: ['a', 'b'] });
  assert.deepEqual(Object.keys(capture.request?.mcpServers ?? {}), ['alpha', 'beta']);
  assert.match(capture.request?.prompt ?? '', /Hello\./);
  assert.ok((capture.request?.prompt ?? '').indexOf('First instruction.') < (capture.request?.prompt ?? '').indexOf('Second instruction.'));
});

test('rejects two selected features that declare the same MCP server', async () => {
  const controlled = controlledSession();
  const features = new Map<string, ExecutionFeature>([
    ['a', { id: 'a', mcpServers: { shared: { transport: 'http', url: 'http://a' } } }],
    ['b', { id: 'b', mcpServers: { shared: { transport: 'http', url: 'http://b' } } }],
  ]);
  const service = new ExecService({ clients: new Map([['stub', stubClient(controlled.session)]]), features });
  await assert.rejects(service.start({ ...BASE_REQUEST, features: ['a', 'b'] }), /same MCP server 'shared'/);
});

test('cancelling a live execution settles it as cancelled', async () => {
  const controlled = controlledSession();
  const service = new ExecService({ clients: new Map([['stub', stubClient(controlled.session)]]) });
  const handle = await service.start({ ...BASE_REQUEST });
  const cancelled = service.cancel(handle.id);
  assert.equal(controlled.cancelled(), true);
  // The client acknowledges the cancel but has not ended its stream yet; the
  // cancel must not hang waiting on a stream that never closes.
  controlled.end(null);
  await cancelled;
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(service.get(handle.id)?.status, 'cancelled');
});

test('cancelling an unknown execution throws and a terminal one is a no-op', async () => {
  const controlled = controlledSession();
  const service = new ExecService({ clients: new Map([['stub', stubClient(controlled.session)]]) });
  await assert.rejects(service.cancel('nope'), /Unknown execution/);

  const handle = await service.start({ ...BASE_REQUEST });
  controlled.emit({ type: 'exit', exitCode: 0, signal: null });
  controlled.end(0);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  await service.cancel(handle.id);
  assert.equal(service.get(handle.id)?.status, 'completed');
});

test('a failing exit code produces a failed snapshot with an error', async () => {
  const controlled = controlledSession();
  const service = new ExecService({ clients: new Map([['stub', stubClient(controlled.session)]]) });
  const handle = await service.start({ ...BASE_REQUEST });
  controlled.emit({ type: 'exit', exitCode: 2, signal: null });
  controlled.end(2);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const snapshot = service.get(handle.id);
  assert.equal(snapshot?.status, 'failed');
  assert.equal(snapshot?.exitCode, 2);
  assert.match(snapshot?.error ?? '', /code 2/);
});

test('retention caps completed runs but never live ones', async () => {
  const controlled = controlledSession();
  const service = new ExecService({
    clients: new Map([['stub', stubClient(controlled.session)]]),
    maxCompletedRuns: 1,
  });
  const first = await service.start({ ...BASE_REQUEST });
  controlled.emit({ type: 'exit', exitCode: 0, signal: null });
  controlled.end(0);
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const second = await service.start({ ...BASE_REQUEST });
  controlled.emit({ type: 'exit', exitCode: 0, signal: null });
  controlled.end(0);
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  assert.equal(service.get(first.id), undefined, 'oldest completed run must be pruned');
  assert.equal(service.get(second.id)?.status, 'completed');
});

test('close cancels every live execution', async () => {
  const controlled = controlledSession();
  const service = new ExecService({ clients: new Map([['stub', stubClient(controlled.session)]]) });
  const handle = await service.start({ ...BASE_REQUEST });
  await service.close();
  assert.equal(controlled.cancelled(), true);
  // A stream that never closes must not leave the run reporting `running`.
  assert.equal(service.get(handle.id)?.status, 'cancelled');
  await assert.rejects(service.start({ ...BASE_REQUEST }), /closed/);
});

test('rejects an unknown client without starting anything', async () => {
  const service = new ExecService({ clients: new Map() });
  await assert.rejects(service.start({ ...BASE_REQUEST, client: 'ghost' }), /Unknown agent client/);
});
