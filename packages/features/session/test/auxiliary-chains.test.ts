/**
 * Deterministic production-chain coverage for the two auxiliary callers that
 * drive reply organization and task dispatch: the real {@link ReplyWriter} and
 * the real {@link runDispatchAction}. Each runs the real call runner over a fake
 * local transport, so the bounded cross-route failover is exercised through the
 * real call chains without contacting any (paid) provider.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ReasoningEffort } from '@wrenyard/models';
import type { ProviderDefinition } from '@wrenyard/providers/base';
import {
  AUXILIARY_IDLE_TIMEOUT_MS,
  createCallRunner,
  type CallRole,
  type CallRunner,
  type RouteHealth,
  type SpanEventDraft,
} from '../src/model/request.ts';
import { ROLE_REQUIREMENTS } from '../src/model/roles.ts';
import { ModelError, type ModelRequest, type ModelResult, type ModelTransport } from '../src/transport/index.ts';
import type { BuiltView, CallsPort } from '../src/ports.ts';
import type { LedgerEvent, LedgerEventDraft } from '../src/ledger/store.ts';
import type { SessionRuntime, TurnRuntime } from '../src/turn/runtime.ts';
import { ReplyWriter, REPLY_TOOL, type ReplyHost } from '../src/auxiliary/reply.ts';
import { runDispatchAction } from '../src/auxiliary/dispatch.ts';
import type { ActionRunContext, ActionWorkflowDeps, ParsedAction } from '../src/reasoning/actions.ts';

const MODEL_IDS = ['alpha', 'beta', 'gamma'];
const providerStub = {
  id: 'test',
  models: MODEL_IDS.map((id) => ({ id, reasoningEfforts: ['none', 'low', 'medium', 'high'] })),
} as unknown as ProviderDefinition;

/** Let the runner reach its in-flight await before a test drives its timing. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Drive a dispatch whose transport stalls to completion by advancing the fake
 * clock one idle deadline at a time. Mock timers must already be enabled.
 */
async function driveToCompletion<T>(run: () => Promise<T>): Promise<T> {
  let done = false;
  const pending = run().then((value) => { done = true; return value; });
  for (let round = 0; round < 64 && !done; round += 1) {
    await flush();
    mock.timers.tick(AUXILIARY_IDLE_TIMEOUT_MS);
    await flush();
  }
  return await pending;
}

/** A minimal `turn.started` ledger event carrying `text`. */
function compileEvent(seq: number, text: string): LedgerEvent {
  return {
    seq, at: '2026-01-01T00:00:00.000Z', type: 'turn.started', turn: 1,
    id: `t${seq}`, text, model: { provider: 'test', model: 'alpha', reasoningEffort: 'low' },
  } as unknown as LedgerEvent;
}

/** The plain text of a request's messages, exactly as the compile view sent it. */
function requestText(request: ModelRequest): string {
  return request.messages
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')))
    .join('\n');
}

/** A chain runner over a fake local transport; every request is recorded as `role:model`. */
function makeChain(options: {
  routes: readonly string[];
  routeStatus?: (model: string) => RouteHealth | undefined;
  onCall: (request: ModelRequest) => ModelResult | Promise<ModelResult>;
}) {
  const calls: string[] = [];
  const transport: ModelTransport = {
    async complete(request) {
      calls.push(`${request.attribution?.role ?? '?'}:${request.model}`);
      return options.onCall(request);
    },
  };
  const events: SpanEventDraft[] = [];
  const runner = createCallRunner({
    resolveProvider: () => providerStub,
    transport,
    ...(options.routeStatus === undefined ? {} : { routeStatus: options.routeStatus }),
    selectAuxiliary: (role) => options.routes.map((model) => ({
      model,
      reasoningEffort: ROLE_REQUIREMENTS[role].expectedReasoningEffort[0] as ReasoningEffort,
    })),
    append: (event) => { events.push(event); },
    now: () => new Date(0),
  });
  return { runner, calls, events };
}

/** A reply tool call carrying `text`, the only shape the reply chain accepts. */
const replyTool = (model: string, text: string): ModelResult => ({
  text: '',
  toolCalls: [{ index: 0, id: 'c1', name: REPLY_TOOL.name, arguments: JSON.stringify({ text }) }],
  metrics: { attempts: [{ status: 200, ms: 1, model }] },
});

/** A compile result: a single JSON object naming a known project and task. */
const compileResult = (model: string): ModelResult => ({
  text: JSON.stringify({ project: 'p1', task: 't1', title: 'T', input: { x: 1 } }),
  toolCalls: [],
  metrics: { attempts: [{ status: 200, ms: 1, model }] },
});

/**
 * A transport failure shaped exactly like the real one — the normalized error
 * carries the single attempt the transport issued, so the runner records it.
 */
const transportFault = (request: ModelRequest): ModelError =>
  new ModelError(`fault:${request.model}`, {
    kind: 'network',
    metrics: { attempts: [{ error: 'network', ms: 5, model: request.model }] },
  });

/** The failed model spans among the drafts the runner reported. */
function failedSpans(events: readonly SpanEventDraft[]): Array<Extract<SpanEventDraft, { type: 'span.finished' }>> {
  return events.filter(
    (event): event is Extract<SpanEventDraft, { type: 'span.finished' }> =>
      event.type === 'span.finished' && event.status === 'failed',
  );
}

function makeSession(): SessionRuntime {
  return {
    sessionId: 's1', workspaceRoot: '/tmp/ws', snapshot: {}, files: {}, actions: {}, calls: {},
    spanSeq: 0, actionSeq: 0, title: '', lastTitleVersion: 0, titleVersion: 0,
    titleUpdatedWithReply: true, firstUserText: 'hi', turns: new Map(), nextTurn: 2,
    reasonQueue: Promise.resolve(), replyQueue: Promise.resolve(),
  } as unknown as SessionRuntime;
}

function makeTurn(): TurnRuntime {
  return {
    turn: 1, userText: 'hi', model: { provider: 'test', model: 'alpha', reasoningEffort: 'low' as ReasoningEffort },
    publicId: 'test/alpha', imageUnsupported: false, phase: 'reasoning', step: 1,
    abort: new AbortController(), actions: new Map(), finished: false, durableTerminal: false,
    resultQueue: [], flushPromise: Promise.resolve(), dropDeferred: false, reasonCompleted: true,
    actionsThisStep: 0, toolCallsThisStep: 0, asksThisStep: [], parsePromises: new Set(),
    actionPromises: new Set(), stepText: '', taskRunIds: new Set(), correctionRequired: false,
    emptyReasonRetried: false, currentReasonText: '',
  } as unknown as TurnRuntime;
}

/** Map the engine's `invoke` seam onto the real runner. */
async function invokeViaRunner(
  runner: CallRunner,
  turn: TurnRuntime,
  role: CallRole,
  view: BuiltView,
  extra?: { spanId?: string; parent?: string; step?: number; maxTokens?: number; tools?: readonly import('../src/transport/index.ts').ToolSpec[]; toolChoice?: import('../src/transport/index.ts').ToolChoice },
) {
  const spanId = extra?.spanId ?? `span-${role}`;
  try {
    const result = await runner.run({
      spanId,
      parent: extra?.parent ?? 'a1',
      role,
      turn: turn.turn,
      step: extra?.step ?? turn.step,
      messages: view.messages,
      layers: view.layers,
      signal: turn.abort.signal,
      ...(extra?.tools === undefined ? {} : { tools: extra.tools }),
      ...(extra?.toolChoice === undefined ? {} : { toolChoice: extra.toolChoice }),
      ...(extra?.maxTokens === undefined ? {} : { maxTokens: extra.maxTokens }),
    });
    return { ok: true as const, spanId, text: result.text, toolCalls: result.toolCalls, metrics: result.metrics };
  } catch (error) {
    return { ok: false as const, spanId, text: '', error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── Reply organization chain ───────────────────────────────────────────────

test('reply organization falls back to the next route when the preferred route hangs', async () => {
  const { runner, calls } = makeChain({
    routes: ['test/alpha', 'test/beta'],
    onCall: (request) => {
      if (request.model === 'test/alpha') throw new ModelError('hung', { kind: 'network' });
      return replyTool(request.model, `reply from ${request.model}`);
    },
  });
  const appended: LedgerEventDraft[] = [];
  const host = {
    ledger: { read: () => [], append: async (_id: string, draft: LedgerEventDraft) => { appended.push(draft); return draft; } },
    now: () => new Date(0),
    track: () => {},
    appendError: async () => {},
    ports: { memory: undefined },
    invoke: async (_session: SessionRuntime, turn: TurnRuntime, role: CallRole, view: BuiltView, extra?: Parameters<typeof invokeViaRunner>[4]) =>
      invokeViaRunner(runner, turn, role, view, extra),
  };
  const writer = new ReplyWriter(host as unknown as ReplyHost, 'device');
  const session = makeSession();
  const turn = makeTurn();
  session.turns.set(1, turn);

  writer.request(session, turn, { step: 1, status: 'running', terminal: false });
  await session.replyQueue;

  // Only the reply-role calls are asserted; a terminal turn also runs a
  // best-effort status classification call.
  assert.deepEqual(calls.filter((call) => call.startsWith('reply:')), ['reply:test/alpha', 'reply:test/beta']);
  const sent = appended.find((event) => event.type === 'reply.sent');
  assert.ok(sent !== undefined);
  assert.equal(sent.type === 'reply.sent' ? sent.text : undefined, 'reply from test/beta');
});

test('reply organization skips an open route and reuses it once recovered', async () => {
  let alphaOpen = true;
  const { runner, calls } = makeChain({
    routes: ['test/alpha', 'test/beta'],
    routeStatus: (model) => (model === 'test/alpha' && alphaOpen
      ? { state: 'model_unavailable', until: '2026-01-01T00:05:00.000Z', phase: 'open' }
      : undefined),
    onCall: (request) => replyTool(request.model, `reply from ${request.model}`),
  });
  const appended: LedgerEventDraft[] = [];
  const host = {
    ledger: { read: () => [], append: async (_id: string, draft: LedgerEventDraft) => { appended.push(draft); return draft; } },
    now: () => new Date(0),
    track: () => {},
    appendError: async () => {},
    ports: { memory: undefined },
    invoke: async (_session: SessionRuntime, turn: TurnRuntime, role: CallRole, view: BuiltView, extra?: Parameters<typeof invokeViaRunner>[4]) =>
      invokeViaRunner(runner, turn, role, view, extra),
  };
  const writer = new ReplyWriter(host as unknown as ReplyHost, 'device');

  const first = makeSession();
  const firstTurn = makeTurn();
  first.turns.set(1, firstTurn);
  writer.request(first, firstTurn, { step: 1, status: 'running', terminal: false });
  await first.replyQueue;
  // The open preferred route is skipped entirely, never called.
  assert.deepEqual(calls, ['reply:test/beta']);

  alphaOpen = false;
  const second = makeSession();
  const secondTurn = makeTurn();
  second.turns.set(1, secondTurn);
  writer.request(second, secondTurn, { step: 1, status: 'running', terminal: false });
  await second.replyQueue;
  // Once healthy again, the preferred route is used first.
  assert.deepEqual(calls, ['reply:test/beta', 'reply:test/alpha']);
});

test('reply organization reports a readable failure when every route faults', async () => {
  const until = '2026-01-01T00:05:00.000Z';
  const { runner, calls, events } = makeChain({
    routes: ['test/alpha', 'test/beta'],
    routeStatus: () => ({ state: 'model_unavailable', until, phase: 'half_open' }),
    onCall: (request) => { throw transportFault(request); },
  });
  const appended: LedgerEventDraft[] = [];
  const errors: string[] = [];
  const host = {
    ledger: { read: () => [], append: async (_id: string, draft: LedgerEventDraft) => { appended.push(draft); return draft; } },
    now: () => new Date(0),
    track: () => {},
    appendError: async (_id: string, _stage: string, message: string) => { errors.push(message); },
    ports: { memory: undefined },
    invoke: async (_session: SessionRuntime, turn: TurnRuntime, role: CallRole, view: BuiltView, extra?: Parameters<typeof invokeViaRunner>[4]) =>
      invokeViaRunner(runner, turn, role, view, extra),
  };
  const writer = new ReplyWriter(host as unknown as ReplyHost, 'device');
  const session = makeSession();
  const turn = makeTurn();
  session.turns.set(1, turn);

  writer.request(session, turn, { step: 1, status: 'completed', terminal: true });
  await session.replyQueue;

  assert.deepEqual(calls.filter((call) => call.startsWith('reply:')), ['reply:test/alpha', 'reply:test/beta']);
  assert.ok(errors.length >= 1);
  // The terminal fallback is still sent so the user always gets a message.
  const sent = appended.find((event) => event.type === 'reply.sent');
  assert.ok(sent !== undefined);
  // The failed reply span keeps the attempt evidence and the route retry time.
  const failed = failedSpans(events);
  assert.ok(failed.length >= 1);
  assert.equal(failed[0]!.error?.kind, 'network');
  assert.equal(failed[0]!.error?.retryAt, until);
  assert.deepEqual(
    (failed[0]!.metrics?.attempts ?? []).map((attempt) => attempt.model),
    ['test/alpha', 'test/beta'],
  );
});

// ─── Task dispatch chain ────────────────────────────────────────────────────

function dispatchDeps(runner: CallRunner) {
  const spans: SpanEventDraft[] = [];
  const calls: CallsPort = {
    run: (input) => runner.run({
      spanId: input.spanId, parent: input.parent, role: input.role, turn: input.turn, step: input.step,
      messages: input.messages, layers: input.layers, signal: input.signal,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
    holdSpan: () => {},
    releaseSpan: async () => {},
  };
  const deps = {
    host: {
      describeTask: async () => ({
        description: 't1', source: 'builtin',
        inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false },
      }),
      createTaskRun: async () => ({ taskRunId: 'run-1' }),
      waitTaskRun: async () => ({ status: 'done', output: 'done' }),
      cancelTaskRun: async () => {},
      methods: async () => [],
      call: async () => undefined,
      environmentTools: async () => ['browser', 'desktop'],
    },
    files: {},
    calls,
    fileStore: {},
    appendSpan: (draft: SpanEventDraft) => { spans.push(draft); },
    now: () => new Date(0),
    nextSpanId: () => `span-${spans.length}`,
  } as unknown as ActionWorkflowDeps;
  return { deps, spans };
}

function dispatchContext(): ActionRunContext {
  return {
    sessionId: 's1', turn: 1, step: 1, actionId: 'a1', userText: 'do it', workspaceRoot: '/tmp/ws',
    snapshot: {}, currentEvents: () => [], projects: [{ id: 'p1', workspaceDir: 'projects/p1' }],
    tasks: [{ id: 't1', description: 't1', inputSummary: [] }],
    signal: new AbortController().signal, onTaskRun: async () => {},
  } as unknown as ActionRunContext;
}

const DISPATCH_ACTION: ParsedAction = { type: 'dispatch', intent: 'run the task' };

test('task dispatch falls back to the next route for the compile call', async () => {
  const { runner, calls } = makeChain({
    routes: ['test/alpha', 'test/beta'],
    onCall: (request) => {
      if (request.model === 'test/alpha') throw new ModelError('hung', { kind: 'network' });
      return compileResult(request.model);
    },
  });
  const { deps } = dispatchDeps(runner);
  const outcome = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  assert.deepEqual(calls, ['dispatch:test/alpha', 'dispatch:test/beta']);
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.task, 't1');
  assert.equal(outcome.taskRunId, 'run-1');
});

test('task dispatch returns a readable failure when every route faults', async () => {
  const until = '2026-01-01T00:05:00.000Z';
  const { runner, calls, events } = makeChain({
    routes: ['test/alpha', 'test/beta'],
    routeStatus: () => ({ state: 'model_unavailable', until, phase: 'half_open' }),
    onCall: (request) => { throw transportFault(request); },
  });
  const { deps } = dispatchDeps(runner);
  const outcome = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  // Call-level failures are capped at COMPILE_CALL_FAILURES_MAX (2), so the
  // compile spends at most 2 attempts × 2 routes = 4 transport calls.
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.startsWith('dispatch:')));
  assert.equal(outcome.status, 'failed');
  // The failure feedback names what was tried instead of silently doing nothing.
  assert.match(outcome.result, /2 of 2 candidate route\(s\), budget 60000 ms/);
  // Every failed compile span keeps both attempts and the route retry time.
  const failed = failedSpans(events);
  assert.ok(failed.length >= 1);
  for (const span of failed) {
    assert.equal(span.error?.kind, 'network');
    assert.equal(span.error?.retryAt, until);
    assert.deepEqual(
      (span.metrics?.attempts ?? []).map((attempt) => attempt.model),
      ['test/alpha', 'test/beta'],
    );
  }
});

test('dispatch stops after bounded call failures and never opens a run', async () => {
  let calls = 0;
  const { runner, events } = makeChain({
    routes: ['test/alpha', 'test/beta'],
    onCall: () => {
      calls += 1;
      // One server error in the middle; every other route call stalls with no
      // output, so only the idle deadline can end it.
      if (calls === 3) throw new ModelError('server exploded', { kind: 'server', status: 500 });
      return new Promise<ModelResult>(() => {});
    },
  });
  const { deps } = dispatchDeps(runner);
  let createCalls = 0;
  (deps.host as unknown as { createTaskRun: () => Promise<{ taskRunId: string }> }).createTaskRun = async () => {
    createCalls += 1;
    return { taskRunId: 'run-1' };
  };

  mock.timers.enable({ apis: ['setTimeout'] });
  const outcome = await driveToCompletion(() => runDispatchAction(deps, DISPATCH_ACTION, dispatchContext()))
    .finally(() => mock.timers.reset());

  assert.equal(outcome.status, 'failed');
  assert.equal(createCalls, 0);
  assert.ok(failedSpans(events).length >= 1);

  // A second dispatch on the same deps still never opens a run.
  mock.timers.enable({ apis: ['setTimeout'] });
  await driveToCompletion(() => runDispatchAction(deps, DISPATCH_ACTION, dispatchContext()))
    .finally(() => mock.timers.reset());
  assert.equal(createCalls, 0);
});

test('the compile view keeps the intent focus and a bounded event tail', async () => {
  const captured: ModelRequest[] = [];
  const { runner } = makeChain({
    routes: ['test/alpha'],
    onCall: (request) => { captured.push(request); return compileResult(request.model); },
  });
  const { deps } = dispatchDeps(runner);
  const events: LedgerEvent[] = [
    compileEvent(0, 'please finish project p1 task t1'),
    compileEvent(1, 'attention on project p1'),
    ...Array.from({ length: 60 }, (_, index) => compileEvent(index + 2, `UNREL${index} ${'a'.repeat(1000)}`)),
  ];
  const ctx = { ...dispatchContext(), currentEvents: () => events };
  const action: ParsedAction = { type: 'dispatch', intent: 'dispatch task t1 in project p1' };

  const outcome = await runDispatchAction(deps, action, ctx);

  assert.equal(outcome.status, 'done');
  assert.equal(captured.length, 1);
  const text = requestText(captured[0]!);
  // The whole compile view stays far below the old unbounded size.
  assert.ok(text.length < 40_000, `compile request text was ${text.length} chars`);
  // The intent's own project and task are kept even though they are the oldest.
  assert.ok(text.includes('project p1 task t1'));
  // The oldest unrelated events are dropped once the tail budget is spent.
  assert.equal(text.includes('UNREL0 '), false);
});

test('dispatch opens one run for the text and image capabilities it provides', async () => {
  const { runner } = makeChain({
    routes: ['test/alpha'],
    onCall: (request) => compileResult(request.model),
  });
  const { deps } = dispatchDeps(runner);
  let createCalls = 0;
  const host = deps.host as unknown as {
    describeTask: () => Promise<Record<string, unknown>>;
    createTaskRun: () => Promise<{ taskRunId: string }>;
  };
  host.createTaskRun = async () => { createCalls += 1; return { taskRunId: 'run-1' }; };
  const inputSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false };

  // The built-in text capability is serviceable: the run opens exactly once.
  host.describeTask = async () => ({
    description: 't1', source: 'builtin', inputSchema, requiredCapabilities: ['text'],
  });
  const text = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  assert.equal(text.status, 'done');
  assert.equal(createCalls, 1);

  // The image capability is serviceable too, opening one more run.
  host.describeTask = async () => ({
    description: 't1', source: 'builtin', inputSchema, requiredCapabilities: ['image'],
  });
  const image = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  assert.equal(image.status, 'done');
  assert.equal(createCalls, 2);
});

test('dispatch blocks a task whose required tools the environment lacks', async () => {
  const { runner } = makeChain({
    routes: ['test/alpha'],
    onCall: (request) => compileResult(request.model),
  });
  const { deps } = dispatchDeps(runner);
  let createCalls = 0;
  const host = deps.host as unknown as {
    describeTask: () => Promise<Record<string, unknown>>;
    createTaskRun: () => Promise<{ taskRunId: string }>;
    environmentTools?: () => Promise<readonly string[]>;
  };
  host.createTaskRun = async () => { createCalls += 1; return { taskRunId: 'run-1' }; };
  const inputSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false };

  // A required tool the environment does not provide never opens a run.
  host.describeTask = async () => ({
    description: 't1', source: 'builtin', inputSchema, requiredTools: ['unreal'],
  });
  const blocked = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.result, /does not provide the required tools: unreal/);
  assert.equal(createCalls, 0);

  // Once the environment declares the tool, the run opens exactly once.
  host.environmentTools = async () => ['browser', 'desktop', 'unreal'];
  const proceeded = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  assert.equal(proceeded.status, 'done');
  assert.equal(createCalls, 1);
});

test('dispatch maps aliased tool ids before matching the environment', async () => {
  const { runner } = makeChain({
    routes: ['test/alpha'],
    onCall: (request) => compileResult(request.model),
  });
  const { deps } = dispatchDeps(runner);
  let createCalls = 0;
  const host = deps.host as unknown as {
    describeTask: () => Promise<Record<string, unknown>>;
    createTaskRun: () => Promise<{ taskRunId: string }>;
    environmentTools?: () => Promise<readonly string[]>;
  };
  host.createTaskRun = async () => { createCalls += 1; return { taskRunId: 'run-1' }; };
  const inputSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false };

  // `computer-use` maps onto the environment's `desktop` tool and proceeds.
  host.describeTask = async () => ({
    description: 't1', source: 'builtin', inputSchema, requiredTools: ['computer-use'],
  });
  host.environmentTools = async () => ['desktop'];
  const proceeded = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  assert.equal(proceeded.status, 'done');
  assert.equal(createCalls, 1);
});

test('dispatch blocks required tools when the host cannot report the environment', async () => {
  const { runner } = makeChain({
    routes: ['test/alpha'],
    onCall: (request) => compileResult(request.model),
  });
  const { deps } = dispatchDeps(runner);
  let createCalls = 0;
  const host = deps.host as unknown as {
    describeTask: () => Promise<Record<string, unknown>>;
    createTaskRun: () => Promise<{ taskRunId: string }>;
    environmentTools?: () => Promise<readonly string[]>;
  };
  host.createTaskRun = async () => { createCalls += 1; return { taskRunId: 'run-1' }; };
  const inputSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false };

  // No environment report at all means no required tool is known to be present.
  host.environmentTools = undefined;
  host.describeTask = async () => ({
    description: 't1', source: 'builtin', inputSchema, requiredTools: ['browser'],
  });
  const blocked = await runDispatchAction(deps, DISPATCH_ACTION, dispatchContext());
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.result, /does not provide the required tools: browser/);
  assert.equal(createCalls, 0);
});
