import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshConversationClient } from '../src/dsh-conversation-client.js';

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
    signal: AbortSignal;
  }) => Promise<string>;
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

    // Cancel targets the actual (owner-scoped) turn id from the snapshot, not
    // a hardcoded legacy id.
    const turnId = String(sent.turns?.[0]?.id);
    await harness.client.cancel(turnId);
    await settle();
    assert.equal(sawAbort, true, 'cancel aborts the in-flight summary callback');

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
