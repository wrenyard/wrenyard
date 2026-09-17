import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshConversationClient, projectConversation } from '../src/dsh-conversation-client.js';

// ---------------------------------------------------------------------------
// Minimal fake DSH: an RPC endpoint over `fetch` plus an EventTarget-shaped
// WebSocket stub. Only the public DshConversationClient surface is exercised;
// nothing here reaches into the client's private fields.
// ---------------------------------------------------------------------------

interface RpcCall {
  method: string;
  payload: Record<string, unknown>;
}

/** One DSH event envelope, exactly as the client's projection expects it. */
function event(type: string, seq: number, data: Record<string, unknown>) {
  return { event: { type, seq, time: 1_700_000_000_000 + seq, data } };
}

type SessionEventEnvelope = ReturnType<typeof event>['event'];

/** Re-seq a helper-built event so composed histories keep a monotonic seq. */
function at(seq: number, built: ReturnType<typeof event>) {
  return { event: { ...built.event, seq, time: 1_700_000_000_000 + seq } };
}

/** One host model catalog for DSH 0.1.1-rc.2, shared by host and session paths. */
function modelDirectory() {
  return {
    current: { provider: 'wrenyard', model: 'codebuddy/deepseek-v4.1-flash' },
    routable: true,
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [{ id: 'codebuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
    }],
    failures: [],
  };
}

function hostModelDirectory() {
  return {
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [{ id: 'codebuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
    }],
    failures: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 25); });

/** Bounded poll: drives real timers until `check` holds or the budget expires. */
async function waitFor(check: () => boolean, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await settle();
  }
  return check();
}

interface FakeStream {
  readonly url: string;
  readonly frame: (payload: Record<string, unknown>) => void;
}

/** Per-session DSH-side event log, used to answer `session.history` and to
 * decide whether `session.fork` may take a completed cut from this session. */
interface SessionRecord {
  events: SessionEventEnvelope[];
  hasCompletedTurn: boolean;
}

interface FakeDsh {
  calls: RpcCall[];
  beforeRpc?: (call: RpcCall) => void | Promise<void>;
  streams: FakeStream[];
  /** Per-session stored event log, keyed by session id. Exposed so a test can
   * carry a session's real DSH history into a freshly installed fake (e.g. a
   * restored harness that must still be able to fork that session). */
  sessions: Map<string, SessionRecord>;
  dispose(): void;
}

class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  readonly url: string;

  constructor(url: string | URL) {
    super();
    // EventTarget has no constructor state to preserve; the URL is bookkeeping.
    this.url = typeof url === 'string' ? url : url.toString();
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.dispatchEvent(new Event('close'));
  }
}

function lastTurnEndIndex(events: SessionEventEnvelope[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/end') return index;
  }
  return -1;
}

/**
 * Install one fake DSH RPC endpoint and WebSocket implementation. Every RPC is
 * answered with the exact `server-response` envelope the client validates, and
 * each `events.mux`/`events.host` socket is captured so a test can push
 * `server-request` frames through the public client behavior.
 *
 * `session.create` mints a fresh session id every call; `session.fork` only
 * succeeds against a source session that already recorded a `turn/end` (and
 * then copies that completed prefix plus any trailing `session/title`, never
 * the unfinished tail); `session.history` answers from the same per-session
 * log that every `session/event` frame pushed through `pushMux` accumulates.
 */
function installFakeDsh(overrides: {
  rpc?: (call: RpcCall) => unknown | Promise<unknown>;
  sessionIndex?: {
    sessions: Array<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean }>;
    sessionIds: () => string[];
  };
  /** Pre-existing DSH history for sessions this fake did not itself create
   * (e.g. a session created by an earlier, now-disposed harness). */
  seedHistory?: Record<string, SessionEventEnvelope[]>;
} = {}): FakeDsh {
  const priorFetch = globalThis.fetch;
  const priorWebSocket = globalThis.WebSocket;
  const calls: RpcCall[] = [];
  const sessions = new Map<string, SessionRecord>();
  for (const [sessionId, events] of Object.entries(overrides.seedHistory ?? {})) {
    sessions.set(sessionId, {
      events: [...events],
      hasCompletedTurn: events.some((entry) => entry.type === 'turn/end'),
    });
  }
  const createdSessions: Array<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean }> = [];
  let rootCounter = 0;
  let forkCounter = 0;
  const fake: FakeDsh = {
    calls,
    streams: [],
    sessions,
    dispose() {
      globalThis.fetch = priorFetch;
      globalThis.WebSocket = priorWebSocket;
      FakeSocket.instances = [];
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = url.split('/api/')[1] ?? url;
    const body = init?.body;
    let rpcId = 'rpc-unknown';
    let payload: Record<string, unknown> = {};
    if (typeof body === 'string') {
      const parsed = JSON.parse(body) as { rpcId?: string; payload?: Record<string, unknown> };
      rpcId = parsed.rpcId ?? rpcId;
      payload = parsed.payload ?? {};
    }
    const call: RpcCall = { method, payload };
    calls.push(call);
    if (fake.beforeRpc) await fake.beforeRpc(call);
    let result: { ok: true; value: unknown } | { ok: false; error: { message: string } };
    if (overrides.rpc) {
      result = { ok: true, value: await overrides.rpc(call) };
    } else if (method === 'session.list') {
      result = { ok: true, value: { items: [...(overrides.sessionIndex?.sessions ?? []), ...createdSessions] } };
    } else if (method === 'workspace.list') {
      result = {
        ok: true,
        value: {
          items: [{
            workspaceId: 'workspace-parallel',
            sessionIds: [
              ...(overrides.sessionIndex?.sessionIds() ?? []),
              ...createdSessions.map((session) => session.sessionId),
            ],
          }],
        },
      };
    } else if (method === 'llm.models') {
      result = { ok: true, value: hostModelDirectory() };
    } else if (method === 'session.models') {
      result = { ok: true, value: modelDirectory() };
    } else if (method === 'session.create') {
      do { rootCounter += 1; } while (sessions.has(`root-${rootCounter}`));
      const sessionId = `root-${rootCounter}`;
      sessions.set(sessionId, { events: [], hasCompletedTurn: false });
      createdSessions.push({ sessionId, updatedAt: Date.now(), running: false, blank: true });
      result = { ok: true, value: { sessionId } };
    } else if (method === 'session.fork') {
      const sourceId = String(payload.sessionId);
      const source = sessions.get(sourceId);
      const cutIndex = source ? lastTurnEndIndex(source.events) : -1;
      if (!source || cutIndex === -1) {
        result = { ok: false, error: { message: `session ${sourceId} has no completed turn to fork` } };
      } else {
        const completedPrefix = source.events.slice(0, cutIndex + 1);
        const trailingTitles = source.events.slice(cutIndex + 1).filter((entry) => entry.type === 'session/title');
        do { forkCounter += 1; } while (sessions.has(`fork-${forkCounter}`));
        const sessionId = `fork-${forkCounter}`;
        sessions.set(sessionId, { events: [...completedPrefix, ...trailingTitles], hasCompletedTurn: true });
        createdSessions.push({ sessionId, updatedAt: Date.now(), running: false, blank: false });
        result = { ok: true, value: { sessionId } };
      }
    } else if (method === 'session.prompt' || method === 'session.cancel' || method === 'session.selectModel') {
      result = { ok: true, value: {} };
    } else if (method === 'session.history') {
      const record = sessions.get(String(payload.sessionId));
      result = { ok: true, value: { events: record ? record.events.map(event => ({ event })) : [], hasMore: false } };
    } else {
      throw new Error(`unexpected ${method}`);
    }
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId,
      result,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  FakeSocket.instances = [];
  return fake;
}

/**
 * Resolve one captured socket into a frame dispatcher. The stub's
 * `addEventListener` is the real EventTarget one, so this only needs to find
 * the socket the client opened and deliver a `server-request` envelope.
 */
function streamFor(fake: FakeDsh, name: 'events.mux' | 'events.host'): FakeStream {
  const existing = fake.streams.find((candidate) => candidate.url.includes(name));
  if (existing) return existing;
  const socket = FakeSocket.instances.find((candidate) => candidate.url.includes(name));
  assert.ok(socket, `the client must open ${name}`);
  const stream: FakeStream = {
    url: socket.url,
    frame(payload) {
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'server-request',
        payload,
      }) }));
    },
  };
  fake.streams.push(stream);
  return stream;
}

/**
 * Push one `server-request` frame through the mux stream, as DSH does. Every
 * `session/event` frame is also appended to that session's stored event log,
 * so later `session.history`/`session.fork` RPCs see exactly what was pushed.
 */
function pushMux(fake: FakeDsh, payload: Record<string, unknown>): void {
  if (payload.type === 'session/event' && typeof payload.sessionId === 'string' && payload.event) {
    const sessionId = payload.sessionId;
    const envelope = payload.event as SessionEventEnvelope;
    let record = fake.sessions.get(sessionId);
    if (!record) {
      record = { events: [], hasCompletedTurn: false };
      fake.sessions.set(sessionId, record);
    }
    record.events.push(envelope);
    if (envelope.type === 'turn/end') record.hasCompletedTurn = true;
  }
  streamFor(fake, 'events.mux').frame(payload);
}

/**
 * Seed one execution branch as DSH would: the fork replays the inherited
 * completed cut (seq 1..cut through `turn/end`), then a trailing `session/title`
 * that still belongs to the source before the new branch's own `turn/start`.
 * The source branch, in other words, rejected the fork — inheriting it must
 * never leak into the new turn's own work.
 */
function seedInheritedCut(fake: FakeDsh, sessionId: string, cut: number, title: string): void {
  pushMux(fake, { type: 'session/event', sessionId, ...at(1, event('user/message', 1, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '继承的历史问题' }],
  })) });
  pushMux(fake, { type: 'session/event', sessionId, ...at(cut - 1, event('assistant/message', cut - 1, {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: '继承的历史工作' }] },
  })) });
  pushMux(fake, { type: 'session/event', sessionId, ...at(cut, event('turn/end', cut, {
    turn: 1,
    reason: { kind: 'completed' },
  })) });
  pushMux(fake, { type: 'session/event', sessionId, ...at(cut + 1, event('session/title', cut + 1, { title })) });
}

/** Emit a full, clean DSH turn on one execution session. */
function emitTurn(
  fake: FakeDsh,
  sessionId: string,
  turn: number,
  text: string,
  startSeq: number,
): number {
  let seq = startSeq;
  pushMux(fake, { type: 'session/event', sessionId, ...at(seq, event('turn/start', seq, { turn })) });
  seq += 1;
  pushMux(fake, { type: 'session/event', sessionId, ...at(seq, event('assistant/chunk', seq, {
    turn,
    step: 1,
    chunk: { type: 'text-delta', text },
  })) });
  seq += 1;
  pushMux(fake, { type: 'session/event', sessionId, ...at(seq, event('assistant/message', seq, {
    turn,
    step: 1,
    message: { content: [{ type: 'text', text }] },
  })) });
  seq += 1;
  pushMux(fake, { type: 'session/event', sessionId, ...at(seq, event('turn/end', seq, {
    turn,
    reason: { kind: 'completed' },
  })) });
  return seq + 1;
}

/**
 * The exact snake_case terminal envelope the daemon's `task.run.wait` answers
 * with for one run. Nothing here is projected by the test; the client reads it
 * exactly as it reads the real result.
 */
function terminalTaskResult(taskRunId: string, status = 'done'): Record<string, unknown> {
  return {
    task_run_id: taskRunId,
    task_id: 'demo-task',
    status,
    output: { note: `${taskRunId} finished` },
    usage: {
      completeness: 'complete',
      attempt_count: 1,
      usage_event_count: 1,
      output_tokens: 7,
      reference_cost_usd: 0.0012,
      reference_cost_complete: true,
    },
  };
}

/** One terminal result whose own body already exceeds the per-result cap. */
function oversizedTaskResult(taskRunId: string): Record<string, unknown> {
  return { ...terminalTaskResult(taskRunId), output: { note: 'x'.repeat(9_000) } };
}

/**
 * One nonblocking dispatch backend. Each run's authoritative result is released
 * by the test, and every wait, abort, and cancellation is recorded so a test can
 * assert exactly which runs a turn owned.
 */
function fakeTaskRuns() {
  const waits = new Map<string, (value: unknown) => void>();
  const failures = new Map<string, (error: unknown) => void>();
  const waited: string[] = [];
  const cancelled: string[] = [];
  const aborted: string[] = [];
  return {
    waited,
    cancelled,
    aborted,
    waitForTaskRun(taskRunId: string, signal: AbortSignal): Promise<unknown> {
      waited.push(taskRunId);
      return new Promise<unknown>((resolve, reject) => {
        waits.set(taskRunId, resolve);
        failures.set(taskRunId, reject);
        signal.addEventListener('abort', () => {
          aborted.push(taskRunId);
          reject(new Error('task wait aborted'));
        }, { once: true });
      });
    },
    cancelTaskRun(taskRunId: string): Promise<void> {
      cancelled.push(taskRunId);
      return Promise.resolve();
    },
    /** Deliver one run's authoritative terminal result to its owner-only wait. */
    finish(taskRunId: string, result?: Record<string, unknown>): void {
      waits.get(taskRunId)?.(result ?? terminalTaskResult(taskRunId));
    },
    /** Reject one run's wait, as a transport that broke before any result does. */
    fail(taskRunId: string, message: string): void {
      failures.get(taskRunId)?.(new Error(message));
    },
  };
}

/**
 * The exact text a nonblocking `run_task` returns: the canonical launch object
 * followed by the bounded dispatch note, so the whole result is deliberately
 * not parseable as one JSON object.
 */
function launchResultText(taskRunId: string): string {
  return `${JSON.stringify({ task_run_id: taskRunId, task_id: 'demo-task', status: 'queued' })}\n`
    + `[async dispatch: task_run_id=${JSON.stringify(taskRunId)} is running. `
    + 'The terminal result is pending and will be delivered automatically to this conversation; '
    + 'do not poll, do not call task.run.wait, and do not fabricate a result.]';
}

/** One nonblocking `run_task` call plus its launch-only result. */
function emitDispatchCall(
  fake: FakeDsh,
  sessionId: string,
  turn: number,
  taskRunId: string,
  startSeq: number,
): number {
  const callId = `call-${taskRunId}`;
  let seq = startSeq;
  const push = (type: string, data: Record<string, unknown>): void => {
    pushMux(fake, { type: 'session/event', sessionId, ...event(type, seq, data) });
    seq += 1;
  };
  push('tool/call', { turn, step: 1, callId, name: 'run_task', arguments: JSON.stringify({ task_id: 'demo-task' }) });
  push('tool/result', {
    turn,
    step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: launchResultText(taskRunId) }],
        isError: false,
      }],
    },
  });
  return seq;
}

/** Emit one internal DSH turn's prose plus one nonblocking dispatch. */
function emitDispatch(
  fake: FakeDsh,
  sessionId: string,
  turn: number,
  taskRunId: string,
  startSeq: number,
): number {
  let seq = startSeq;
  const push = (type: string, data: Record<string, unknown>): void => {
    pushMux(fake, { type: 'session/event', sessionId, ...event(type, seq, data) });
    seq += 1;
  };
  push('turn/start', { turn });
  push('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: '已派发后台任务。' }] } });
  return emitDispatchCall(fake, sessionId, turn, taskRunId, seq);
}

/**
 * End one internal DSH turn the way a yield-after-dispatch does: the installed
 * agent loop's pre-step refuses the empty continuation, so the internal turn
 * ends with `blocked` and no assistant final body at all.
 */
function emitYieldEnd(fake: FakeDsh, sessionId: string, turn: number, startSeq: number): number {
  pushMux(fake, {
    type: 'session/event',
    sessionId,
    ...event('turn/end', startSeq, { turn, reason: { kind: 'blocked', message: 'no new messages' } }),
  });
  return startSeq + 1;
}

/** Emit one internal turn that only takes a delivery and yields again. */
function emitYieldTurn(fake: FakeDsh, sessionId: string, turn: number, startSeq: number): number {
  pushMux(fake, { type: 'session/event', sessionId, ...event('turn/start', startSeq, { turn }) });
  return emitYieldEnd(fake, sessionId, turn, startSeq + 1);
}

/** End one internal DSH turn with one exact reason of its own. */
function emitTurnEnd(
  fake: FakeDsh,
  sessionId: string,
  turn: number,
  startSeq: number,
  reason: Record<string, unknown>,
): number {
  pushMux(fake, { type: 'session/event', sessionId, ...event('turn/end', startSeq, { turn, reason }) });
  return startSeq + 1;
}

/**
 * One internal turn with exactly one measurable response window: two nonempty
 * deltas `windowMs` apart and a clean finish, so the tokenizer TPS contract
 * observes this response and nothing else.
 */
function emitMeasuredTurn(
  fake: FakeDsh,
  sessionId: string,
  turn: number,
  startSeq: number,
  startTime: number,
  windowMs: number,
  text: string,
): number {
  let seq = startSeq;
  const push = (type: string, time: number, data: Record<string, unknown>): void => {
    pushMux(fake, { type: 'session/event', sessionId, event: { type, seq, time, data } });
    seq += 1;
  };
  push('turn/start', startTime, { turn });
  push('assistant/chunk', startTime, { turn, step: 1, chunk: { type: 'text-delta', text } });
  push('assistant/chunk', startTime + windowMs, { turn, step: 1, chunk: { type: 'text-delta', text } });
  push('assistant/chunk', startTime + windowMs, { turn, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } });
  push('assistant/message', startTime + windowMs, { turn, step: 1, message: { content: [{ type: 'text', text: `${text}${text}` }] } });
  return seq;
}

/** Open a client wired to a fake DSH, with a real temp state document. */
interface Harness {
  client: DshConversationClient;
  fake: FakeDsh;
  statePath: string;
  directory: string;
  stopped: boolean;
  stop(): void;
}

const openHarnesses: Harness[] = [];

/**
 * Open a client wired to a fake DSH and start it, so the events streams are
 * live before any send. The workspace starts empty; a test that needs durable
 * sessions seeds them through the index fixture.
 */
async function openHarness(options: {
  summarize?: (input: {
    previousSummaries: Array<{ user: string; summary: string }>;
    user: string;
    work: string;
    phase?: 'progress' | 'final';
    signal: AbortSignal;
  }) => Promise<string>;
  waitForTaskRun?: (taskRunId: string, signal: AbortSignal) => Promise<unknown>;
  cancelTaskRun?: (taskRunId: string) => Promise<void>;
  statePath?: string;
  sessions?: Array<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean }>;
  /** Real DSH history for a durable session this harness did not itself
   * create (carried over from a now-disposed harness), keyed by session id. */
  sessionHistory?: Record<string, SessionEventEnvelope[]>;
} = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'wrenyard-parallel-'));
  const statePath = options.statePath ?? join(directory, 'conversation.json');
  const sessions = options.sessions ?? [];
  const fake = installFakeDsh({
    ...(sessions.length > 0 ? {
      sessionIndex: {
        sessions,
        sessionIds: () => sessions.map((session) => session.sessionId),
      },
    } : {}),
    ...(options.sessionHistory ? { seedHistory: options.sessionHistory } : {}),
  });
  const client = new DshConversationClient({
    baseUrl: 'http://127.0.0.1:9',
    workspaceId: 'workspace-parallel',
    workspace: {
      status: 'configured',
      path: '/workspace-parallel',
      configPath: '/config.json',
      source: 'user-config',
      readOnly: false,
    },
    configuredProviderIds: ['wrenyard'],
    statePath,
    ...(options.summarize ? { summarize: options.summarize } : {}),
    ...(options.waitForTaskRun ? { waitForTaskRun: options.waitForTaskRun } : {}),
    ...(options.cancelTaskRun ? { cancelTaskRun: options.cancelTaskRun } : {}),
    onChanged() {},
  });
  const harness: Harness = {
    client,
    fake,
    statePath,
    directory,
    stopped: false,
    stop() {
      if (harness.stopped) return;
      harness.stopped = true;
      client.stop();
      fake.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  openHarnesses.push(harness);
  await client.start();
  // A restored conversation is adopted synchronously by start(); a durable
  // session seeded through the index is adopted once its models load.
  return harness;
}

afterEach(() => {
  while (openHarnesses.length > 0) openHarnesses.pop()?.stop();
});

// ---------------------------------------------------------------------------
// Scenario 1: simultaneous first messages, reverse completion, send order.
// ---------------------------------------------------------------------------

test('simultaneous first messages use separate blank executions and never fork unfinished work', async () => {
  const harness = await openHarness();
  try {
    const first = await harness.client.send('并发第一条');
    const second = await harness.client.send('并发第二条');
    await settle();

    // Both optimistic snapshots exist immediately, in send order.
    assert.deepEqual(first.items.map((item) => item.text), ['并发第一条']);
    assert.deepEqual(second.items.map((item) => item.text), ['并发第一条', '并发第二条']);
    assert.deepEqual(
      second.turns?.map((turn) => turn.running),
      [true, true],
      'both turns are live at the same time',
    );

    const prompts = harness.fake.calls.filter((call) => call.method === 'session.prompt');
    assert.equal(prompts.length, 2, 'each send dispatches exactly one prompt');
    assert.equal(
      prompts.every((call) => call.payload.mode === 'queue'),
      true,
      'a parallel send never steers onto another turn',
    );
    const sessions = prompts.map((call) => String(call.payload.sessionId));
    assert.equal(new Set(sessions).size, 2, 'the two turns run on separate execution sessions');

    // Neither branch has a completed turn yet, so DSH's `session.fork` rejects
    // the unfinished branch: the second simultaneous send must fall back to
    // its own independent `session.create`, never a fork of unfinished work.
    const createCalls = harness.fake.calls.filter((call) => call.method === 'session.create');
    assert.equal(createCalls.length, 2, 'both blank branches are created independently');
    const forkCalls = harness.fake.calls.filter((call) => call.method === 'session.fork');
    assert.equal(forkCalls.length, 0, 'an unfinished branch is never forked');
  } finally {
    harness.stop();
  }
});

test('reverse completion keeps send order, isolates each turn work, and summarizes each once with all-work context', async () => {
  const seen: Array<{ previous: Array<{ user: string; summary: string }>; user: string; work: string }> = [];
  const harness = await openHarness({
    summarize: async (input) => {
      seen.push({ previous: [...input.previousSummaries], user: input.user, work: input.work });
      return `摘要 ${seen.length}`;
    },
  });
  try {
    await harness.client.send('问题 A');
    await harness.client.send('问题 B');
    await settle();

    const prompts = harness.fake.calls.filter((call) => call.method === 'session.prompt');
    const sessionForA = String(prompts[0].payload.sessionId);
    const sessionForB = String(prompts[1].payload.sessionId);
    assert.notEqual(sessionForA, sessionForB);

    // B finishes first with its own text.
    emitTurn(harness.fake, sessionForB, 1, '只有 B 的工作', 1);
    await settle();
    // Then A finishes. Completion order must not reorder the transcript.
    emitTurn(harness.fake, sessionForA, 1, '只有 A 的工作', 1);
    const settledOk = await waitFor(() => seen.length === 2);
    assert.equal(settledOk, true, 'both turns settle within the bounded poll');

    // Each turn's own summary lands in its own send-order slot; the labels are
    // assigned by completion order, so they are read back from the callback.
    const byUser = new Map(seen.map((entry, index) => [entry.user, { ...entry, label: `摘要 ${index + 1}` }]));
    // Each turn's work is exactly its own branch text, never the other's.
    assert.equal(byUser.get('问题 A')?.work, '只有 A 的工作');
    assert.equal(byUser.get('问题 B')?.work, '只有 B 的工作');
    // Exactly one summary call per turn.
    assert.equal(seen.length, 2);
    // Summary context is captured at send time: neither parallel send had a
    // completed predecessor when it was sent, so both saw an empty context.
    assert.deepEqual(byUser.get('问题 A')?.previous, []);
    assert.deepEqual(byUser.get('问题 B')?.previous, []);

    // Raw DSH work now remains in the snapshot as its own item, so each
    // turn's answer is read through its own `finalItemId` rather than an
    // exact item-count or exact-shape assertion over the whole transcript.
    const snapshot = harness.client.snapshot();
    const items = snapshot.items;
    const turns = snapshot.turns ?? [];
    assert.equal(turns.length, 2, 'send order produced exactly two turns');
    const finalTextFor = (turnIndex: number) =>
      items.find((item) => item.id === turns[turnIndex]?.finalItemId)?.text;
    assert.equal(finalTextFor(0), byUser.get('问题 A')?.label, "turn A's final item is its own summary");
    assert.equal(finalTextFor(1), byUser.get('问题 B')?.label, "turn B's final item is its own summary");
  } finally {
    harness.stop();
  }
});

test('a third send while another turn runs inherits the completed cut but excludes inherited events', async () => {
  const seen: Array<{ previous: Array<{ user: string; summary: string }>; user: string; work: string }> = [];
  const harness = await openHarness({
    summarize: async (input) => {
      seen.push({ previous: [...input.previousSummaries], user: input.user, work: input.work });
      return `摘要 ${seen.length}`;
    },
  });
  try {
    await harness.client.send('第一步');
    await settle();
    const firstPrompt = harness.fake.calls.find((call) => call.method === 'session.prompt');
    const firstSession = String(firstPrompt?.payload.sessionId);
    emitTurn(harness.fake, firstSession, 1, '第一步的工作', 1);
    const firstDone = await waitFor(
      () => harness.client.snapshot().items.some((item) => item.text === '摘要 1'),
    );
    assert.equal(firstDone, true, 'the first turn completes before the third send');

    // Second and third sends run in parallel; the third forks the first cut.
    await harness.client.send('第二步（仍在运行）');
    await settle();
    await harness.client.send('第三步');
    await settle();

    const promptSessions = harness.fake.calls
      .filter((call) => call.method === 'session.prompt')
      .map((call) => String(call.payload.sessionId));
    const thirdSession = promptSessions.at(-1) as string;
    assert.notEqual(thirdSession, firstSession);

    // DSH seeds the fork with the inherited completed cut plus a trailing title.
    seedInheritedCut(harness.fake, thirdSession, 4, '旧的标题');
    emitTurn(harness.fake, thirdSession, 7, '第三步的工作', 6);
    const thirdDone = await waitFor(() => seen.some((entry) => entry.user === '第三步'));
    assert.equal(thirdDone, true, 'the third turn summarizes within the bounded poll');

    // The inherited cut is execution detail: it never becomes this turn's work.
    const third = seen.find((entry) => entry.user === '第三步');
    assert.equal(third?.work, '第三步的工作');
    assert.equal(third?.work.includes('继承的历史'), false, 'inherited events are excluded from work');

    const items = harness.client.snapshot().items;
    assert.equal(items.some((item) => item.text.includes('继承的历史问题')), false);
    assert.equal(items.some((item) => item.text === '旧的标题'), false);
    // The third turn's context is the completed first turn, not the running second.
    assert.deepEqual(third?.previous, [{ user: '第一步', summary: '摘要 1' }]);
  } finally {
    harness.stop();
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: conversation persistence across New/select and per-turn cancel.
// ---------------------------------------------------------------------------

test('New and select while a turn runs preserve both conversations and a later send keeps prior summaries', async () => {
  const harness = await openHarness({
    summarize: async (input) => `摘要：${input.user}｜上下文${input.previousSummaries.length}`,
  });
  const historyDir = mkdtempSync(join(tmpdir(), 'wrenyard-parallel-preserved-'));
  try {
    // Conversation 1: one completed turn, persisted to the state document.
    await harness.client.send('会话一的问题');
    await settle();
    const firstSession = String(
      harness.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId,
    );
    emitTurn(harness.fake, firstSession, 1, '会话一的工作', 1);
    await waitFor(() => harness.client.snapshot().items.some((item) => item.text.includes('会话一的问题')));
    await waitFor(() => harness.client.snapshot().items.some((item) => item.text.startsWith('摘要：')));
    const completedItems = harness.client.snapshot().items.map((item) => item.text);
    const conversationOneId = String(harness.client.snapshot().selectedSessionId);
    assert.equal(conversationOneId, firstSession, 'conversation 1 is selected by its own session id');

    // Conversation 2: New opens a second conversation in the same client and
    // the same state file; a turn is still running on it.
    await harness.client.create();
    await harness.client.send('会话二的运行中问题');
    await settle();
    const conversationTwoId = String(harness.client.snapshot().selectedSessionId);
    assert.notEqual(conversationTwoId, conversationOneId, 'New opens a distinct conversation');
    assert.equal(harness.client.snapshot().selectedRunning, true, 'the running turn keeps the conversation live');
    assert.equal(harness.client.snapshot().items.some((item) => item.text === '会话二的运行中问题'), true);

    // Selecting conversation 1 back shows its own completed contents, not
    // conversation 2's running turn.
    await harness.client.select(conversationOneId);
    await settle();
    assert.equal(harness.client.snapshot().selectedSessionId, conversationOneId);
    assert.deepEqual(
      harness.client.snapshot().items.map((item) => item.text),
      completedItems,
      'switching back to conversation 1 shows its own prior contents',
    );

    // Selecting conversation 2 back keeps its background turn running.
    await harness.client.select(conversationTwoId);
    await settle();
    assert.equal(harness.client.snapshot().selectedSessionId, conversationTwoId);
    assert.equal(harness.client.snapshot().selectedRunning, true, 'the background turn still runs');
    assert.equal(
      harness.client.snapshot().items.some((item) => item.text === '会话二的运行中问题'),
      true,
      'selecting a session never discards the running conversation',
    );

    // Preserve the state document and conversation 1's real DSH history to an
    // independent temp file, then fully dispose this harness before a fresh
    // one installs its own global fetch/WebSocket, so the two never overlap.
    const preservedPath = join(historyDir, 'conversation-one.json');
    copyFileSync(harness.statePath, preservedPath);
    const sessionHistory = Object.fromEntries([...harness.fake.sessions].map(([id, session]) => [id, session.events]));
    const durableSessions = [...harness.fake.sessions.keys()].map(sessionId => ({ sessionId, updatedAt: 1, running: false, blank: false }));
    harness.stop();
    const captured: Array<{ user: string; previous: Array<{ user: string; summary: string }> }> = [];
    const restored = await openHarness({
      statePath: preservedPath,
      sessions: durableSessions,
      sessionHistory,
      summarize: async (input) => {
        captured.push({ user: input.user, previous: [...input.previousSummaries] });
        return `摘要：${input.user}`;
      },
    });
    try {
      assert.equal(restored.client.snapshot().selectedSessionId, conversationTwoId, 'restore preserves the last selected conversation');
      assert.ok(restored.client.snapshot().items.some(item => item.text.includes('已中断')));
      await restored.client.select(conversationOneId);
      const restoredItems = restored.client.snapshot().items.map((item) => item.text);
      assert.deepEqual(restoredItems, completedItems, 'prior messages and summaries restore verbatim');
      assert.equal(restored.client.snapshot().selectedSessionId, firstSession, 'the durable conversation is selected');
      assert.equal(
        restoredItems.includes('会话二的运行中问题'),
        false,
        'selecting conversation one isolates the restored background conversation',
      );

      // The first send after a restore forks the retained history and keeps
      // the completed summary as context.
      await restored.client.send('会话一的新问题');
      await settle();
      const newSession = String(
        restored.fake.calls.filter((call) => call.method === 'session.prompt').at(-1)?.payload.sessionId,
      );
      seedInheritedCut(restored.fake, newSession, 4, '旧的标题');
      emitTurn(restored.fake, newSession, 9, '新工作', 6);
      const done = await waitFor(() => captured.some((entry) => entry.user === '会话一的新问题'));
      assert.equal(done, true, 'the new turn summarizes within the bounded poll');

      const settleItems = restored.client.snapshot().items.map((item) => item.text);
      assert.deepEqual(
        settleItems.slice(0, completedItems.length),
        completedItems,
        'the restored conversation is an anchor, not a replacement',
      );
      assert.equal(
        captured.find((entry) => entry.user === '会话一的新问题')?.previous.length,
        1,
        'the prior summary is carried into the next send',
      );
      // The title seed never becomes a visible item.
      assert.equal(settleItems.includes('旧的标题'), false);
    } finally {
      restored.stop();
    }
  } finally {
    harness.stop();
    rmSync(historyDir, { recursive: true, force: true });
  }
});

test('per-turn cancel affects only the targeted conversation and restore preserves the other', async () => {
  const harness = await openHarness();
  try {
    const firstSend = await harness.client.send('待取消的问题');
    await settle();
    await harness.client.send('应保留的问题');
    await settle();

    const prompts = harness.fake.calls.filter((call) => call.method === 'session.prompt');
    const cancelledSession = String(prompts[0].payload.sessionId);
    const keptSession = String(prompts[1].payload.sessionId);
    assert.notEqual(cancelledSession, keptSession);

    // Cancel targets the actual (owner-scoped) turn id from the snapshot, not
    // a hardcoded legacy id.
    const cancelledTurnId = String(firstSend.turns?.[0]?.id);
    await harness.client.cancel(cancelledTurnId);
    await settle();

    const cancelCalls = harness.fake.calls.filter((call) => call.method === 'session.cancel');
    assert.deepEqual(
      cancelCalls.map((call) => call.payload.sessionId),
      [cancelledSession],
      'only the targeted turn execution is stopped',
    );

    // The other turn keeps running and still completes normally.
    emitTurn(harness.fake, keptSession, 1, '保留的工作', 1);
    const keptDone = await waitFor(
      () => harness.client.snapshot().items.some((item) => item.text === '保留的工作'),
    );
    assert.equal(keptDone, true, 'the surviving conversation completes');
    const items = harness.client.snapshot().items;
    assert.equal(items.some((item) => item.text === '保留的工作'), true);
    assert.equal(
      items.filter((item) => item.kind === 'user').map((item) => item.text).join('|'),
      '待取消的问题|应保留的问题',
      'the display order is unchanged by the cancel',
    );

    // Late events for the cancelled branch never revive it.
    emitTurn(harness.fake, cancelledSession, 5, '迟到的工作', 1);
    await settle();
    assert.equal(
      harness.client.snapshot().items.some((item) => item.text === '迟到的工作'),
      false,
      'a cancelled turn never shows late work',
    );
    assert.equal(harness.client.snapshot().turns?.[0]?.running, false);
  } finally {
    harness.stop();
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: cancel during summarization, and frozen telemetry.
// ---------------------------------------------------------------------------

test('cancel during summary aborts the callback and suppresses its late result', async () => {
  const gate = deferred<void>();
  let summarizeCalls = 0;
  let sawAbort = false;
  const harness = await openHarness({
    summarize: async (input) => {
      summarizeCalls += 1;
      input.signal.addEventListener('abort', () => { sawAbort = true; });
      await gate.promise;
      return '迟到的摘要';
    },
  });
  try {
    const sent = await harness.client.send('取消总结的问题');
    await settle();
    const session = String(
      harness.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId,
    );
    // The DSH turn completes cleanly, so summarization starts and blocks on gate.
    emitTurn(harness.fake, session, 1, '总结前的工作', 1);
    const summarizing = await waitFor(() => summarizeCalls === 1);
    assert.equal(summarizing, true, 'the summary callback starts once the DSH turn ends');
    assert.equal(harness.client.snapshot().sessions[0]?.running, true, 'the whole conversation stays active during summary generation');

    // Cancel targets the actual (owner-scoped) turn id from the snapshot, not
    // a hardcoded legacy id.
    const turnId = String(sent.turns?.[0]?.id);
    await harness.client.cancel(turnId);
    await settle();
    assert.equal(sawAbort, true, 'cancel aborts the in-flight summary callback');
    assert.equal(harness.client.snapshot().sessions[0]?.running, false);

    // Releasing the callback afterwards must not publish its result.
    gate.resolve();
    await settle();
    await settle();
    const items = harness.client.snapshot().items;
    assert.equal(items.some((item) => item.text === '迟到的摘要'), false, 'a late summary never lands');
    assert.equal(harness.client.snapshot().turns?.[0]?.running, false);
  } finally {
    harness.stop();
  }
});

test('a completed turn keeps identical duration and usage through later events', async () => {
  const harness = await openHarness();
  try {
    await harness.client.send('计时问题');
    await settle();
    const session = String(
      harness.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId,
    );

    // The optimistic turn snapshot owns the send time; DSH owns the exact end
    // boundary and the observed usage, which must freeze once the turn settles.
    const optimistic = harness.client.snapshot().turns?.[0]?.startedAt;
    assert.equal(typeof optimistic, 'number');

    // One clean turn with an observable streaming window and usage.
    const start = 1_700_000_000_000;
    pushMux(harness.fake, {
      type: 'session/event',
      sessionId: session,
      event: { type: 'turn/start', seq: 1, time: start, data: { turn: 1 } },
    });
    pushMux(harness.fake, {
      type: 'session/event',
      sessionId: session,
      event: { type: 'assistant/chunk', seq: 2, time: start + 100, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '思考中' } } },
    });
    pushMux(harness.fake, {
      type: 'session/event',
      sessionId: session,
      event: { type: 'assistant/chunk', seq: 3, time: start + 600, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } } } },
    });
    pushMux(harness.fake, {
      type: 'session/event',
      sessionId: session,
      event: { type: 'assistant/chunk', seq: 4, time: start + 1_100, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '完成' } } },
    });
    pushMux(harness.fake, {
      type: 'session/event',
      sessionId: session,
      event: { type: 'assistant/message', seq: 5, time: start + 1_200, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '完成' }] } } },
    });
    pushMux(harness.fake, {
      type: 'session/event',
      sessionId: session,
      event: { type: 'turn/end', seq: 6, time: start + 1_400, data: { turn: 1, reason: { kind: 'completed' } } },
    });
    const finished = await waitFor(() => harness.client.snapshot().turns?.[0]?.endedAt !== undefined);
    assert.equal(finished, true, 'the turn settles within the bounded poll');

    const frozen = harness.client.snapshot().turns?.[0];
    assert.equal(frozen?.endedAt, start + 1_400, 'the end boundary is the exact turn/end event time');
    assert.equal(frozen?.inputTokens, 100);
    assert.equal(frozen?.outputTokens, 20);
    assert.equal(frozen?.running, false);
    assert.equal(frozen?.startedAt, optimistic, 'the optimistic send time is never rewritten');

    // Later, unrelated frames on the same session must not recompute telemetry.
    pushMux(harness.fake, {
      type: 'session/event',
      sessionId: session,
      ...event('session/title', 20, { title: '后来到达的标题' }),
    });
    await settle();
    const after = harness.client.snapshot().turns?.[0];
    assert.equal(after?.startedAt, frozen?.startedAt, 'duration stays identical');
    assert.equal(after?.endedAt, frozen?.endedAt, 'endedAt stays identical');
    assert.equal(after?.inputTokens, frozen?.inputTokens, 'input usage stays identical');
    assert.equal(after?.outputTokens, frozen?.outputTokens, 'output usage stays identical');
  } finally {
    harness.stop();
  }
});

test('completed work and tool details survive restart while execution forks stay hidden', async () => {
  const savedDir = mkdtempSync(join(tmpdir(), 'wrenyard-process-restore-'));
  const seen: string[] = [];
  const h = await openHarness({ summarize: async input => { seen.push(input.work); return `Summary: ${input.user}`; } });
  try {
    await h.client.send('inspect');
    await settle();
    const root = String(h.fake.calls.find(c => c.method === 'session.prompt')?.payload.sessionId);
    const push = (e: ReturnType<typeof event>) => pushMux(h.fake, { type: 'session/event', sessionId: root, ...e });
    push(event('turn/start', 1, { turn: 1 }));
    push(event('assistant/message', 2, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Inspecting the report.' }] } }));
    push(event('tool/call', 3, { turn: 1, step: 1, callId: 'read-report', name: 'Read', arguments: '{"path":"report.md"}' }));
    push(event('tool/result', 4, { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'read-report' }, content: [{ type: 'tool-result', toolCallId: 'read-report', content: [{ type: 'text', text: 'report-payload' }], isError: false }] } }));
    push(event('assistant/message', 5, { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Inspection complete.' }] } }));
    push(event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }));
    assert.ok(await waitFor(() => !!h.client.snapshot().turns?.[0]?.finalItemId));
    assert.ok(seen[0].includes('Inspecting the report.'));
    assert.ok(seen[0].includes('report-payload'), 'summary includes the observed tool result');
    assert.ok(h.client.snapshot().items.some(i => i.kind === 'tool' && i.toolResultText?.includes('report-payload')));
    push(event('session/title', 7, { title: 'Report' }));
    await h.client.send('continue');
    await settle();
    const fork = String(h.fake.calls.filter(c => c.method === 'session.prompt').at(-1)?.payload.sessionId);
    assert.notEqual(fork, root);
    emitTurn(h.fake, fork, 2, 'Follow-up work.', 8);
    assert.ok(await waitFor(() => !!h.client.snapshot().turns?.[1]?.finalItemId));
    const before = h.client.snapshot();
    assert.equal(before.sessions.length, 1);
    const statePath = join(savedDir, 'state.json');
    copyFileSync(h.statePath, statePath);
    const sessionHistory = Object.fromEntries([...h.fake.sessions].map(([id, s]) => [id, s.events]));
    const sessions = [...h.fake.sessions.keys()].map(sessionId => ({ sessionId, updatedAt: 1, running: false, blank: false }));
    h.stop();
    const restored = await openHarness({ statePath, sessions, sessionHistory, summarize: async () => 'unused' });
    try {
      assert.equal(restored.client.snapshot().sessions.length, 1, 'internal execution branches remain hidden after restart');
      assert.deepEqual(restored.client.snapshot().items, before.items, 'full process and tool details restore unchanged');
      assert.deepEqual(restored.client.snapshot().turns, before.turns, 'terminal usage and timing stay frozen');
    } finally { restored.stop(); }
  } finally { h.stop(); rmSync(savedDir, { recursive: true, force: true }); }
});

test('continuing a legacy conversation preserves its answer and distinct turn metadata', async () => {
  const legacy = [
    event('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'Legacy question' }] }).event,
    event('turn/start', 2, { turn: 1 }).event,
    event('assistant/message', 3, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Legacy answer' }] } }).event,
    event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }).event,
  ];
  const h = await openHarness({ sessions: [{ sessionId: 'legacy-root', updatedAt: 1, running: false, blank: false }], sessionHistory: { 'legacy-root': legacy }, summarize: async () => 'New summary' });
  try {
    const before = h.client.snapshot();
    assert.ok(before.items.some(i => i.text === 'Legacy answer'));
    assert.equal(before.turns?.length, 1, 'legacy timing metadata remains available');
    await h.client.send('New question');
    await settle();
    const fork = String(h.fake.calls.find(c => c.method === 'session.prompt')?.payload.sessionId);
    assert.notEqual(fork, 'legacy-root');
    emitTurn(h.fake, fork, 2, 'New work', 5);
    assert.ok(await waitFor(() => h.client.snapshot().items.some(i => i.text === 'New summary')));
    const after = h.client.snapshot();
    assert.equal(after.items.filter(i => i.text === 'Legacy question').length, 1);
    assert.equal(after.items.filter(i => i.text === 'Legacy answer').length, 1);
    assert.equal(after.turns?.length, 2);
    assert.equal(new Set(after.turns?.map(t => t.id)).size, 2, 'legacy and product turns have distinct identities');
    assert.deepEqual(after.turns?.[0], before.turns?.[0], 'legacy timing remains frozen');
  } finally { h.stop(); }
});

test('cancelling before session creation preserves the user message across restart', async () => {
  const savedDir = mkdtempSync(join(tmpdir(), 'wrenyard-early-cancel-'));
  const h = await openHarness();
  const gate = deferred<void>();
  h.fake.beforeRpc = async call => { if (call.method === 'session.create') await gate.promise; };
  try {
    const sent = await h.client.send('Cancel before creation');
    await h.client.cancel(sent.turns![0].id);
    const before = h.client.snapshot();
    const statePath = join(savedDir, 'state.json');
    copyFileSync(h.statePath, statePath);
    gate.resolve(); await settle(); h.stop();
    const restored = await openHarness({ statePath });
    try {
      assert.deepEqual(restored.client.snapshot().items, before.items);
      assert.deepEqual(restored.client.snapshot().turns, before.turns);
      assert.ok(restored.client.snapshot().items.some(i => i.text === 'Cancel before creation'));
    } finally { restored.stop(); }
  } finally { gate.resolve(); h.stop(); rmSync(savedDir, { recursive: true, force: true }); }
});

test('a prompt accepted after cancellation receives a post-accept stop', async () => {
  const h = await openHarness();
  const gate = deferred<void>();
  let awaitingAcceptance = false;
  h.fake.beforeRpc = async call => {
    if (call.method === 'session.prompt') { awaitingAcceptance = true; await gate.promise; }
  };
  try {
    const sent = await h.client.send('Cancel during acceptance');
    assert.ok(await waitFor(() => awaitingAcceptance));
    await h.client.cancel(sent.turns![0].id);
    assert.equal(h.fake.calls.filter(c => c.method === 'session.cancel').length, 1);
    gate.resolve();
    assert.ok(await waitFor(() => h.fake.calls.filter(c => c.method === 'session.cancel').length === 2));
    assert.equal(h.client.snapshot().turns?.[0].running, false);
  } finally { gate.resolve(); h.stop(); }
});

test('fork history replay during the inherited-boundary read never completes the new turn', async () => {
  const seen: string[] = [];
  const h = await openHarness({ summarize: async input => { seen.push(input.work); return `Summary ${seen.length}`; } });
  const gate = deferred<void>();
  let readingFork: string | undefined;
  try {
    await h.client.send('First'); await settle();
    const root = String(h.fake.calls.find(c => c.method === 'session.prompt')?.payload.sessionId);
    emitTurn(h.fake, root, 1, 'Original work', 1);
    assert.ok(await waitFor(() => !!h.client.snapshot().turns?.[0].finalItemId));
    h.fake.beforeRpc = async call => {
      if (call.method === 'session.history' && call.payload.sessionId !== root && !readingFork) {
        readingFork = String(call.payload.sessionId); await gate.promise;
      }
    };
    await h.client.send('Second');
    assert.ok(await waitFor(() => !!readingFork));
    for (const inherited of h.fake.sessions.get(readingFork!)!.events) {
      streamFor(h.fake, 'events.mux').frame({ type: 'session/event', sessionId: readingFork, event: inherited });
    }
    await settle();
    assert.equal(seen.length, 1, 'inherited turn/end cannot start another summary');
    assert.equal(h.client.snapshot().turns?.[1].running, true);
    gate.resolve();
    assert.ok(await waitFor(() => h.fake.calls.filter(c => c.method === 'session.prompt').length === 2));
    emitTurn(h.fake, readingFork!, 2, 'New work', 5);
    assert.ok(await waitFor(() => seen.length === 2));
    assert.equal(seen[1], 'New work');
  } finally { gate.resolve(); h.stop(); }
});

// ---------------------------------------------------------------------------
// Scenario 4: one work turn owning several internal DSH turns and the tasks it
// dispatched asynchronously.
// ---------------------------------------------------------------------------

test('a dispatched task keeps the work turn running with a progress note, then one same-session delivery and one final summary', async () => {
  const tasks = fakeTaskRuns();
  const calls: Array<{ phase?: string; user: string; work: string }> = [];
  const h = await openHarness({
    waitForTaskRun: tasks.waitForTaskRun,
    cancelTaskRun: tasks.cancelTaskRun,
    summarize: async (input) => {
      calls.push({ phase: input.phase, user: input.user, work: input.work });
      return input.phase === 'progress' ? '正在等后台任务返回。' : '任务已完成，结果如下。';
    },
  });
  try {
    await h.client.send('派发一个后台任务');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    let seq = emitDispatch(h.fake, session, 1, 'tr-1', 1);
    seq = emitYieldEnd(h.fake, session, 1, seq);

    // The internal turn ended with no assistant final body, but the work turn
    // owns a pending run: that yield is not a failure.
    assert.ok(await waitFor(() => calls.some((call) => call.phase === 'progress')));
    assert.ok(await waitFor(() => h.client.snapshot().items.some((item) => item.text === '正在等后台任务返回。')));
    const waiting = h.client.snapshot().turns?.[0];
    assert.equal(waiting?.running, true, 'a pre-step yield with owned tasks keeps the work turn running');
    assert.equal(waiting?.endedAt, undefined, 'the elapsed clock keeps counting while tasks run');
    assert.equal(waiting?.pendingTaskCount, 1);
    assert.deepEqual(tasks.waited, ['tr-1'], 'exactly one owner-only wait per run id');
    assert.equal(
      h.client.snapshot().items.some((item) => item.text === '任务已完成，结果如下。'),
      false,
      'no final answer is produced while a dispatched run is pending',
    );
    // A pending dispatch shows its own nonterminal identity, never an outcome.
    const pendingTool = h.client.snapshot().items.find((item) => item.taskRun?.taskRunId === 'tr-1');
    assert.equal(pendingTool?.taskRun?.status, 'running');
    assert.equal(pendingTool?.taskRun?.usage.completeness, 'unavailable');

    // The authoritative result is delivered back into the SAME session, once.
    tasks.finish('tr-1');
    assert.ok(await waitFor(() => h.fake.calls.filter((call) => call.method === 'session.prompt').length === 2));
    const delivery = h.fake.calls.filter((call) => call.method === 'session.prompt').at(-1);
    assert.equal(String(delivery?.payload.sessionId), session, 'the result resumes the same execution session');
    const delivered = String((delivery?.payload.content as Array<{ text: string }>)[0].text);
    assert.ok(delivered.includes('[wrenyard:task-results]'), 'the delivery is a marked internal data envelope');
    assert.ok(delivered.includes('tr-1'));
    assert.equal(h.fake.calls.filter((call) => call.method === 'session.fork').length, 0, 'a delivery never forks a new branch');
    assert.equal(h.client.snapshot().turns?.[0]?.running, true, 'the work turn is still running after the delivery');

    // Only the second internal turn's own answer completes the work turn.
    emitTurn(h.fake, session, 2, '后台任务结果已汇总。', seq);
    assert.ok(await waitFor(() => calls.some((call) => call.phase === 'final')));
    const done = h.client.snapshot().turns?.[0];
    assert.equal(done?.running, false);
    assert.equal(typeof done?.endedAt, 'number', 'totals freeze only once everything settled');
    assert.equal(done?.dispatchCount, 1, 'dispatches aggregate across every internal turn');
    assert.equal(done?.pendingTaskCount, undefined);
    const items = h.client.snapshot().items;
    assert.equal(items.find((item) => item.id === done?.finalItemId)?.text, '任务已完成，结果如下。');
    assert.equal(
      items.some((item) => item.text === '正在等后台任务返回。'),
      false,
      'the final answer replaces the progress note instead of standing beside it',
    );
    assert.equal(calls.filter((call) => call.phase === 'final').length, 1, 'exactly one final summary per work turn');
    assert.equal(h.fake.calls.filter((call) => call.method === 'session.prompt').length, 2, 'the result batch is consumed exactly once');
    // The internal envelope is product data, never a user message.
    assert.deepEqual(items.filter((item) => item.kind === 'user').map((item) => item.text), ['派发一个后台任务']);
    assert.equal(items.some((item) => item.text.includes('[wrenyard:task-results]')), false);
    // Both internal turns' process records survive in the settled turn.
    assert.ok(items.some((item) => item.text === '已派发后台任务。'));
    assert.ok(items.some((item) => item.text === '后台任务结果已汇总。'));
    assert.ok(calls.find((call) => call.phase === 'final')?.work.includes('已派发后台任务。'));
    // The authoritative terminal metadata replaces the launch identity.
    const settledTool = items.find((item) => item.taskRun?.taskRunId === 'tr-1');
    assert.equal(settledTool?.taskRun?.status, 'done');
    assert.equal(settledTool?.toolState, 'done');

    // The completed work turn persists exactly one user/final-summary pair, and
    // its owned run is recorded as consumed.
    const document = JSON.parse(readFileSync(h.statePath, 'utf8')) as {
      records: Array<{
        messages: Array<{ kind: string; text: string }>;
        turns: Array<{ tasks?: Array<{ taskRunId: string; status: string }>; internalTurnIds?: string[]; progress?: string; summary?: string }>;
      }>;
    };
    const record = document.records.at(-1);
    assert.deepEqual(
      record?.messages.map((message) => message.kind),
      ['user', 'assistant'],
      'one completed work turn is exactly one user/final-summary pair',
    );
    const persisted = record?.turns.at(-1);
    assert.deepEqual(persisted?.tasks, [{ taskRunId: 'tr-1', status: 'consumed', callId: 'call-tr-1', taskRun: settledTool?.taskRun }]);
    assert.deepEqual(persisted?.internalTurnIds, ['turn-1', 'turn-2'], 'both handled internal boundaries are recorded');
    assert.equal(persisted?.summary, '任务已完成，结果如下。');
  } finally { h.stop(); }
});

test('a task result that arrives before the internal end is delivered without any progress note', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openHarness({
    waitForTaskRun: tasks.waitForTaskRun,
    cancelTaskRun: tasks.cancelTaskRun,
    summarize: async (input) => {
      phases.push(input.phase ?? 'final');
      return input.phase === 'progress' ? '进展' : '完成';
    },
  });
  try {
    await h.client.send('抢跑的任务');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    const seq = emitDispatch(h.fake, session, 1, 'tr-race', 1);
    assert.ok(await waitFor(() => tasks.waited.length === 1));

    // The result wins the race against the internal boundary.
    tasks.finish('tr-race');
    await settle();
    assert.equal(
      h.fake.calls.filter((call) => call.method === 'session.prompt').length,
      1,
      'nothing is delivered while the internal turn is still open',
    );
    assert.equal(h.client.snapshot().turns?.[0]?.running, true);

    // The internal end consumes the already-ready batch immediately.
    emitYieldEnd(h.fake, session, 1, seq);
    assert.ok(await waitFor(() => h.fake.calls.filter((call) => call.method === 'session.prompt').length === 2));
    assert.deepEqual(phases, [], 'a result that already arrived needs no progress note');
    assert.equal(h.client.snapshot().turns?.[0]?.running, true);
    assert.equal(h.client.snapshot().turns?.[0]?.endedAt, undefined);
  } finally { h.stop(); }
});

test('cancelling a work turn stops only its own runs and leaves another conversation untouched', async () => {
  const tasks = fakeTaskRuns();
  const h = await openHarness({
    waitForTaskRun: tasks.waitForTaskRun,
    cancelTaskRun: tasks.cancelTaskRun,
    summarize: async (input) => (input.phase === 'progress' ? '进展' : '完成'),
  });
  try {
    const sent = await h.client.send('要取消的任务');
    await settle();
    const first = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    const conversationOne = String(h.client.snapshot().selectedSessionId);
    emitYieldEnd(h.fake, first, 1, emitDispatch(h.fake, first, 1, 'tr-cancel', 1));
    assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.pendingTaskCount === 1));

    // A second conversation dispatches a run of its own.
    await h.client.create();
    await h.client.send('要保留的任务');
    await settle();
    const second = String(h.fake.calls.filter((call) => call.method === 'session.prompt').at(-1)?.payload.sessionId);
    assert.notEqual(second, first);
    let seq = emitDispatch(h.fake, second, 1, 'tr-keep', 1);
    seq = emitYieldEnd(h.fake, second, 1, seq);
    assert.ok(await waitFor(() => tasks.waited.length === 2));

    await h.client.cancel(String(sent.turns?.[0]?.id));
    await settle();
    assert.deepEqual(tasks.cancelled, ['tr-cancel'], "only the cancelled turn's own run is stopped");
    assert.deepEqual(tasks.aborted, ['tr-cancel'], 'only its own wait is abandoned');

    // The other conversation still consumes its own result and completes.
    tasks.finish('tr-keep');
    assert.ok(await waitFor(
      () => h.fake.calls.filter((call) => call.method === 'session.prompt' && call.payload.sessionId === second).length === 2,
    ));
    emitTurn(h.fake, second, 2, '保留的工作', seq);
    assert.ok(await waitFor(() => h.client.snapshot().items.some((item) => item.text === '完成')));
    assert.equal(h.client.snapshot().turns?.[0]?.running, false);

    // A late result for the cancelled run never revives its turn.
    tasks.finish('tr-cancel');
    await settle();
    await h.client.select(conversationOne);
    const cancelled = h.client.snapshot().turns?.[0];
    assert.equal(cancelled?.running, false);
    assert.equal(cancelled?.pendingTaskCount, undefined);
    assert.equal(h.client.snapshot().items.some((item) => item.text === '完成'), false, 'the cancelled conversation never gains an answer');
  } finally { h.stop(); }
});

test('an interrupted work turn restores its dispatched runs truthfully and never re-executes them', async () => {
  const savedDir = mkdtempSync(join(tmpdir(), 'wrenyard-task-restore-'));
  const tasks = fakeTaskRuns();
  const h = await openHarness({
    waitForTaskRun: tasks.waitForTaskRun,
    cancelTaskRun: tasks.cancelTaskRun,
    summarize: async (input) => (input.phase === 'progress' ? '进展消息' : '最终答复'),
  });
  try {
    await h.client.send('持久化派发');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    emitYieldEnd(h.fake, session, 1, emitDispatch(h.fake, session, 1, 'tr-persist', 1));
    assert.ok(await waitFor(() => h.client.snapshot().items.some((item) => item.text === '进展消息')));

    const document = JSON.parse(readFileSync(h.statePath, 'utf8')) as {
      records: Array<{
        messages: Array<{ kind: string }>;
        turns: Array<{
          status: string;
          progress?: string;
          internalTurnIds?: string[];
          process?: Array<{ text: string }>;
          tasks?: Array<{ taskRunId: string; status: string }>;
        }>;
      }>;
    };
    const persisted = document.records.at(-1)?.turns.at(-1);
    assert.deepEqual(persisted?.tasks?.map((task) => [task.taskRunId, task.status]), [['tr-persist', 'pending']]);
    assert.deepEqual(persisted?.internalTurnIds, ['turn-1']);
    assert.equal(persisted?.progress, '进展消息', 'the latest progress note is persisted on the turn');
    assert.ok(persisted?.process?.some((item) => item.text === '已派发后台任务。'), 'the process of a waiting turn is preserved');
    assert.deepEqual(
      document.records.at(-1)?.messages.map((message) => message.kind),
      ['user'],
      'a progress note never enters the completed user/summary history',
    );

    const statePath = join(savedDir, 'state.json');
    copyFileSync(h.statePath, statePath);
    const sessionHistory = Object.fromEntries([...h.fake.sessions].map(([id, record]) => [id, record.events]));
    const sessions = [...h.fake.sessions.keys()].map((sessionId) => ({ sessionId, updatedAt: 1, running: false, blank: false }));
    h.stop();

    const restoredTasks = fakeTaskRuns();
    const restored = await openHarness({
      statePath,
      sessions,
      sessionHistory,
      waitForTaskRun: restoredTasks.waitForTaskRun,
      cancelTaskRun: restoredTasks.cancelTaskRun,
      summarize: async () => 'unused',
    });
    try {
      const items = restored.client.snapshot().items;
      // The interrupted model turn stays explicitly interrupted: its dispatched
      // run is neither re-awaited nor reported as finished.
      assert.ok(items.some((item) => item.text.includes('已中断') && item.text.includes('未回传')));
      assert.equal(items.some((item) => item.text === '最终答复'), false);
      assert.deepEqual(restoredTasks.waited, [], 'a restored interrupted turn never re-executes its runs');
      assert.equal(restored.client.snapshot().turns?.at(-1)?.running, false);
      assert.ok(items.some((item) => item.text === '已派发后台任务。'), 'the preserved process still renders');
      const tool = items.find((item) => item.taskRun?.taskRunId === 'tr-persist');
      assert.equal(tool?.taskRun?.status, 'running', 'the run keeps the last state actually observed');
    } finally { restored.stop(); }
  } finally { h.stop(); rmSync(savedDir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Scenario 5: a work turn may never answer from work that did not happen.
// ---------------------------------------------------------------------------

/** One task-owning harness with a phase-tagging summarizer. */
async function openTaskHarness(tasks: ReturnType<typeof fakeTaskRuns>, phases: string[]): Promise<Harness> {
  return openHarness({
    waitForTaskRun: tasks.waitForTaskRun,
    cancelTaskRun: tasks.cancelTaskRun,
    summarize: async (input) => {
      phases.push(input.phase ?? 'final');
      return input.phase === 'progress' ? '进展' : '完成';
    },
  });
}

/** The text of every delivery this session received after its first prompt. */
function deliveries(fake: FakeDsh, sessionId: string): string[] {
  return fake.calls
    .filter((call) => call.method === 'session.prompt' && call.payload.sessionId === sessionId)
    .slice(1)
    .map((call) => String((call.payload.content as Array<{ text: string }>)[0].text));
}

test('a real internal error never completes a work turn that owns a dispatched run', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openTaskHarness(tasks, phases);
  try {
    await h.client.send('会出错的派发');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    const seq = emitDispatch(h.fake, session, 1, 'tr-error', 1);
    emitTurnEnd(h.fake, session, 1, seq, { kind: 'error', message: 'provider exploded' });

    assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.running === false));
    // An owned run is not a licence to treat a broken branch as a yield.
    assert.deepEqual(phases, [], 'a failed branch produces neither a progress note nor an answer');
    assert.equal(h.client.snapshot().items.some((item) => item.text === '完成'), false);
    assert.ok(h.client.snapshot().items.some((item) => item.text.includes('provider exploded')));
    assert.deepEqual(tasks.cancelled, ['tr-error'], 'the run it still owned is stopped');
    assert.deepEqual(deliveries(h.fake, session), [], 'nothing is delivered into a failed branch');
    assert.equal(h.client.snapshot().turns?.[0]?.pendingTaskCount, undefined);
  } finally { h.stop(); }
});

test('a yield with nothing outstanding is a failure rather than an empty answer', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openTaskHarness(tasks, phases);
  try {
    await h.client.send('空转的一轮');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    pushMux(h.fake, { type: 'session/event', sessionId: session, ...event('turn/start', 1, { turn: 1 }) });
    emitYieldEnd(h.fake, session, 1, 2);

    assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.running === false));
    assert.deepEqual(phases, []);
    assert.ok(h.client.snapshot().items.some((item) => item.text.startsWith('未完成')));
  } finally { h.stop(); }
});

test('a rejected wait fails the work turn instead of answering from a result it never saw', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openTaskHarness(tasks, phases);
  try {
    await h.client.send('等待会失败');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    emitYieldEnd(h.fake, session, 1, emitDispatch(h.fake, session, 1, 'tr-wait', 1));
    assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.pendingTaskCount === 1));

    tasks.fail('tr-wait', 'transport closed');
    assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.running === false));
    assert.equal(h.client.snapshot().items.some((item) => item.text === '完成'), false, 'a failed wait never becomes an answer');
    assert.ok(h.client.snapshot().items.some((item) => item.text.includes('transport closed')));
    assert.deepEqual(deliveries(h.fake, session), [], 'an unobserved result is never delivered');
    assert.deepEqual(tasks.cancelled, ['tr-wait'], 'the run is stopped rather than left running behind a settled turn');
    // The coordinator had already yielded, so there was no model run to abort.
    assert.equal(h.fake.calls.filter((call) => call.method === 'session.cancel').length, 0);

    const document = JSON.parse(readFileSync(h.statePath, 'utf8')) as {
      records: Array<{ turns: Array<{ tasks?: Array<{ status: string }> }> }>;
    };
    assert.deepEqual(
      document.records.at(-1)?.turns.at(-1)?.tasks?.map((task) => task.status),
      ['pending'],
      'a run whose outcome was never observed is never recorded as consumed',
    );
  } finally { h.stop(); }
});

test('a nonterminal or mismatched run answer never becomes an outcome', async () => {
  for (const answer of [
    { label: 'nonterminal', result: { ...terminalTaskResult('tr-odd'), status: 'running' } },
    { label: 'mismatched', result: terminalTaskResult('tr-other') },
    { label: 'malformed', result: { note: 'not a run projection' } },
  ]) {
    const tasks = fakeTaskRuns();
    const phases: string[] = [];
    const h = await openTaskHarness(tasks, phases);
    try {
      await h.client.send(`异常回传：${answer.label}`);
      await settle();
      const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
      emitYieldEnd(h.fake, session, 1, emitDispatch(h.fake, session, 1, 'tr-odd', 1));
      assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.pendingTaskCount === 1));

      tasks.finish('tr-odd', answer.result);
      assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.running === false), answer.label);
      assert.deepEqual(deliveries(h.fake, session), [], `${answer.label} is never delivered`);
      assert.equal(
        h.client.snapshot().items.some((item) => item.text === '完成'),
        false,
        `${answer.label} never becomes an answer`,
      );
      assert.ok(
        h.client.snapshot().items.some((item) => item.text.includes('未回传可用的终态结果')),
        answer.label,
      );
      assert.deepEqual(tasks.cancelled, ['tr-odd'], answer.label);
    } finally { h.stop(); }
  }
});

test('a result set larger than one envelope is delivered in bounded batches without losing a run', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openTaskHarness(tasks, phases);
  try {
    await h.client.send('四个超大结果');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    const ids = ['tr-big-1', 'tr-big-2', 'tr-big-3', 'tr-big-4'];
    let seq = emitDispatch(h.fake, session, 1, ids[0], 1);
    for (const id of ids.slice(1)) seq = emitDispatchCall(h.fake, session, 1, id, seq);
    seq = emitYieldEnd(h.fake, session, 1, seq);
    assert.ok(await waitFor(() => tasks.waited.length === ids.length));
    for (const id of ids) tasks.finish(id, oversizedTaskResult(id));

    assert.ok(await waitFor(() => deliveries(h.fake, session).length === 1));
    const first = deliveries(h.fake, session)[0];
    assert.ok(first.length <= 24_500, 'one delivery stays within the envelope bound');
    assert.ok(first.includes('[结果已达单条长度上限'), 'a per-result cut is stated rather than silent');
    assert.ok(ids.filter((id) => first.includes(id)).length < ids.length, 'the bound excluded at least one run');

    // The excluded runs stayed ready, so the next boundary delivers them.
    seq = emitYieldTurn(h.fake, session, 2, seq);
    assert.ok(await waitFor(() => deliveries(h.fake, session).length === 2));
    const batches = deliveries(h.fake, session);
    for (const id of ids) {
      assert.equal(
        batches.filter((batch) => batch.includes(id)).length,
        1,
        `${id} is delivered exactly once across the deliveries`,
      );
    }
    assert.ok(batches.every((batch) => batch.includes('[wrenyard:task-results]') && batch.length <= 24_500));

    emitTurn(h.fake, session, 3, '四个结果都已汇总。', seq);
    assert.ok(await waitFor(() => phases.includes('final')));
    const done = h.client.snapshot().turns?.[0];
    assert.equal(done?.running, false);
    assert.equal(done?.dispatchCount, ids.length);
    assert.equal(deliveries(h.fake, session).length, 2, 'no batch is resent after the turn completes');
    const document = JSON.parse(readFileSync(h.statePath, 'utf8')) as {
      records: Array<{ turns: Array<{ tasks?: Array<{ taskRunId: string; status: string }> }> }>;
    };
    assert.deepEqual(
      document.records.at(-1)?.turns.at(-1)?.tasks?.map((task) => [task.taskRunId, task.status]),
      ids.map((id) => [id, 'consumed']),
      'every dispatched run is recorded as consumed exactly once',
    );
  } finally { h.stop(); }
});

test('cancelling while a result delivery is being accepted receives a post-accept stop', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openTaskHarness(tasks, phases);
  const gate = deferred<void>();
  try {
    const sent = await h.client.send('回传中取消');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    emitYieldEnd(h.fake, session, 1, emitDispatch(h.fake, session, 1, 'tr-late', 1));
    assert.ok(await waitFor(() => h.client.snapshot().turns?.[0]?.pendingTaskCount === 1));

    let awaitingAcceptance = false;
    h.fake.beforeRpc = async (call) => {
      if (call.method === 'session.prompt') { awaitingAcceptance = true; await gate.promise; }
    };
    tasks.finish('tr-late');
    assert.ok(await waitFor(() => awaitingAcceptance));
    await h.client.cancel(String(sent.turns?.[0]?.id));
    assert.equal(h.fake.calls.filter((call) => call.method === 'session.cancel').length, 1);

    gate.resolve();
    assert.ok(
      await waitFor(() => h.fake.calls.filter((call) => call.method === 'session.cancel').length === 2),
      'a delivery DSH accepted after the cancel is stopped again',
    );
    assert.equal(h.client.snapshot().turns?.[0]?.running, false);
    assert.equal(h.client.snapshot().items.some((item) => item.text === '完成'), false);
  } finally { gate.resolve(); h.stop(); }
});

test('a boundary observed while a delivery is in flight is still delivered once that prompt returns', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openTaskHarness(tasks, phases);
  const gate = deferred<void>();
  try {
    await h.client.send('回传竞态');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    let seq = emitYieldEnd(h.fake, session, 1, emitDispatch(h.fake, session, 1, 'tr-first', 1));
    assert.ok(await waitFor(() => tasks.waited.length === 1));

    let prompts = 0;
    h.fake.beforeRpc = async (call) => {
      if (call.method !== 'session.prompt') return;
      prompts += 1;
      if (prompts === 1) await gate.promise;
    };
    tasks.finish('tr-first');
    assert.ok(await waitFor(() => prompts === 1), 'the first delivery is in flight');

    // The coordinator dispatches and yields again before that prompt resolves.
    seq = emitDispatch(h.fake, session, 2, 'tr-second', seq);
    seq = emitYieldEnd(h.fake, session, 2, seq);
    assert.ok(await waitFor(() => tasks.waited.length === 2));
    tasks.finish('tr-second');
    await settle();
    assert.equal(prompts, 1, 'an in-flight delivery suppresses the next one');

    gate.resolve();
    assert.ok(await waitFor(() => prompts === 2), 'the suppressed batch is delivered once the prompt returns');
    const batches = deliveries(h.fake, session);
    assert.equal(batches.length, 2);
    assert.ok(batches[1].includes('tr-second'));
    assert.equal(batches[1].includes('tr-first'), false, 'a consumed result is never resent');

    emitTurn(h.fake, session, 3, '两批结果都已汇总。', seq);
    assert.ok(await waitFor(() => phases.includes('final')));
    assert.equal(h.client.snapshot().turns?.[0]?.running, false);
    assert.equal(deliveries(h.fake, session).length, 2, 'each batch is delivered exactly once');
  } finally { gate.resolve(); h.stop(); }
});

test('a work turn reports total tokens over total generation time, not the mean of its turns', async () => {
  const tasks = fakeTaskRuns();
  const phases: string[] = [];
  const h = await openTaskHarness(tasks, phases);
  try {
    await h.client.send('多轮吞吐');
    await settle();
    const session = String(h.fake.calls.find((call) => call.method === 'session.prompt')?.payload.sessionId);
    const base = 1_700_000_000_000;
    // A long slow window, then a short fast one: an arithmetic mean of the two
    // rates and the true aggregate rate cannot coincide.
    let seq = emitMeasuredTurn(h.fake, session, 1, 1, base, 4_000, '第一轮很长的流式输出内容，用来构成一个可测量的窗口。');
    seq = emitDispatchCall(h.fake, session, 1, 'tr-tps', seq);
    seq = emitYieldEnd(h.fake, session, 1, seq);
    assert.ok(await waitFor(() => tasks.waited.length === 1));
    tasks.finish('tr-tps');
    assert.ok(await waitFor(() => h.fake.calls.filter((call) => call.method === 'session.prompt').length === 2));

    seq = emitMeasuredTurn(h.fake, session, 2, seq, base + 60_000, 200, '第二轮短输出。');
    emitTurnEnd(h.fake, session, 2, seq, { kind: 'completed' });
    assert.ok(await waitFor(() => phases.includes('final')));

    const branch = h.fake.sessions.get(session)!.events.map((entry) => ({ event: entry }));
    const projected = projectConversation(branch, Number.POSITIVE_INFINITY);
    const measured = projected.turns
      .map((turn) => turn.outputTps)
      .filter((value): value is number => value !== undefined);
    assert.equal(measured.length, 2, 'both internal turns have their own measurable window');
    const totalTokens = measured[0] * 4 + measured[1] * 0.2;
    const expected = totalTokens / 4.2;
    assert.ok(Math.abs((projected.outputTps ?? 0) - expected) < 1e-6, 'the projection aggregates tokens over time');
    const mean = (measured[0] + measured[1]) / 2;
    assert.ok(Math.abs(expected - mean) > 1e-6, 'the two definitions really do differ here');
    assert.equal(
      h.client.snapshot().turns?.[0]?.outputTps,
      projected.outputTps,
      'the work turn reports the aggregate rate of every internal turn it ran',
    );
  } finally { h.stop(); }
});
