import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayModel } from '@wrenyard/ai-protocol';
import type { LedgerEvent, LedgerEventDraft, SessionSummary } from '@wrenyard/protocol/session';
import {
  MemorySessionPersistence,
  type SessionPersistencePort,
  type SessionStorageHandle,
  type SessionStorageMode,
} from '@wrenyard/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDocumentAuthority,
  createSession,
  type DocumentBeforeAppendContext,
  type DocumentPersistencePort,
  type SessionHost,
} from '../src/index.ts';

const TEST_MODEL: GatewayModel = {
  id: 'test-model',
  publicId: 'test-provider/test-model',
  provider: 'test-provider',
  protocols: ['openai_chat'],
  displayName: 'Test Model',
  reasoningEfforts: ['default'],
  contextWindow: 32_768,
  maxOutputTokens: 4096,
};

function makeRoots(): { dir: string; stateRoot: string; workspaceRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-harness-spec-'));
  const stateRoot = join(dir, 'state');
  const workspaceRoot = join(dir, 'workspace');
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  return { dir, stateRoot, workspaceRoot };
}

function sseText(text: string): Response {
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function sseToolCall(name: string, args: unknown): Response {
  const call = {
    index: 0,
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolNamesFromBody(init: RequestInit | undefined): string[] {
  if (typeof init?.body !== 'string') return [];
  const parsed = JSON.parse(init.body) as {
    tools?: Array<{ name?: string; function?: { name?: string } }>;
  };
  return (parsed.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '');
}

function makeHost(
  roots: { stateRoot: string; workspaceRoot: string },
  overrides: Partial<SessionHost> = {},
): SessionHost {
  return {
    workspaceRoot: roots.workspaceRoot,
    stateRoot: roots.stateRoot,
    deviceName: 'test-device',
    gateway: async () => ({
      openaiChatBaseUrl: 'http://127.0.0.1/gateway/openai-chat/v1',
      openaiResponsesBaseUrl: 'http://127.0.0.1/gateway/openai-responses/v1',
      anthropicBaseUrl: 'http://127.0.0.1/gateway/anthropic/v1',
      token: 'test-token',
      models: [TEST_MODEL],
    }),
    resolveAuxiliaryModel: async () => ({
      model: TEST_MODEL.publicId,
      reasoningEffort: 'default',
    }),
    previewAuxiliaryRoutes: async () => [],
    listProjects: async () => [{
      id: 'p1',
      workspaceDir: 'projects/p1',
      checkoutPath: roots.workspaceRoot,
    }],
    gitHead: async () => ({}),
    methods: async () => [],
    call: async () => ({}),
    listTaskDefinitions: async () => [{
      id: 't1',
      description: 'Slow test task',
      project: 'p1',
      inputSummary: [],
    }],
    describeTask: async () => ({
      description: 'Slow test task',
      inputSchema: { type: 'object', properties: {} },
      source: 'project',
    }),
    findTaskWriteConflict: async () => null,
    createTaskRun: async () => ({ taskRunId: 'run-1' }),
    waitTaskRun: async (_taskRunId, signal) => new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ status: 'cancelled', output: 'aborted' });
        return;
      }
      signal.addEventListener('abort', () => {
        resolve({ status: 'cancelled', output: 'aborted' });
      }, { once: true });
    }),
    cancelTaskRun: async () => {},
    ...overrides,
  };
}

describe('@wrenyard/harness', () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    while (dirsToClean.length > 0) {
      rmSync(dirsToClean.pop()!, { recursive: true, force: true });
    }
  });

  it('interrupt cancels running tasks, flushes action results, and closes the open step and turn cleanly', async () => {
    const roots = makeRoots();
    dirsToClean.push(roots.dir);

    let markWaiting!: () => void;
    const taskWaiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const cancelledTaskRuns: string[] = [];

    let dispatched = false;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const tools = toolNamesFromBody(init);
      if (tools.includes('wy_action')) {
        return sseToolCall('wy_action', { type: 'dispatch', intent: 'run t1 in p1' });
      }
      if (tools.includes('task_create')) {
        if (!dispatched) {
          dispatched = true;
          return sseToolCall('task_create', { project: 'p1', task: 't1', input: {} });
        }
        return sseToolCall('done', { status: 'done', summary: 'Dispatched.' });
      }
      return sseText('Mock Title');
    });

    const host = makeHost(roots, {
      waitTaskRun: async (_taskRunId, signal) => {
        markWaiting();
        return new Promise((resolve) => {
          const finish = (): void => resolve({ status: 'cancelled', output: 'interrupted' });
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener('abort', finish, { once: true });
        });
      },
      cancelTaskRun: async (taskRunId) => {
        cancelledTaskRuns.push(taskRunId);
      },
    });

    const session = createSession(host);
    const { sessionId } = await session.createSession();

    let resolveTurnFinished!: () => void;
    const turnFinished = new Promise<void>((resolve) => {
      resolveTurnFinished = resolve;
    });
    const unsub = session.subscribe(sessionId, (event) => {
      if (event.type === 'turn.finished') {
        resolveTurnFinished();
      }
    });

    const { turn } = await session.send(sessionId, {
      text: 'dispatch a slow task',
      model: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'default' },
    });

    await taskWaiting;
    await session.interrupt(sessionId, turn);
    await turnFinished;
    unsub();

    expect(cancelledTaskRuns).toEqual(['run-1']);
    const events = session.readLedger(sessionId);
    const stepFinished = events.find((event) => event.type === 'step.finished');
    const actionFinished = events.find((event) => event.type === 'action.finished');
    const turnInterrupted = events.find((event) => event.type === 'turn.interrupted');
    const finished = events.find((event) => event.type === 'turn.finished');

    expect(turnInterrupted).toMatchObject({ type: 'turn.interrupted', turn, reason: 'user' });
    expect(stepFinished).toMatchObject({ type: 'step.finished', turn, status: 'interrupted' });
    expect(actionFinished).toMatchObject({ type: 'action.finished', turn, afterInterrupt: true });
    expect(finished).toMatchObject({ type: 'turn.finished', turn, status: 'interrupted' });
    expect(stepFinished!.seq).toBeLessThan(finished!.seq);
    expect(actionFinished!.seq).toBeLessThan(finished!.seq);

    await session.close();
  });

  it('drains the harness pipeline before closing SessionManager and persistence on close()', async () => {
    const roots = makeRoots();
    dirsToClean.push(roots.dir);

    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const tools = toolNamesFromBody(init);
      if (tools.includes('reply')) {
        return sseToolCall('reply', { text: 'Completed.' });
      }
      if (tools.includes('set_status')) {
        return sseToolCall('set_status', { needsUser: false });
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('<wy-title>')) {
        return sseText('Sample Session Title');
      }
      return sseText('Done.');
    });

    const inner = new MemorySessionPersistence<LedgerEvent, SessionSummary>();
    let persistenceClosed = false;
    const lifecycleOrder: string[] = [];

    let markTitleAppendEntered!: () => void;
    const titleAppendEntered = new Promise<void>((resolve) => {
      markTitleAppendEntered = resolve;
    });
    let releaseTitleAppend!: () => void;
    const titleAppendGate = new Promise<void>((resolve) => {
      releaseTitleAppend = resolve;
    });

    const wrapHandle = (
      handle: SessionStorageHandle<LedgerEvent, SessionSummary>,
    ): SessionStorageHandle<LedgerEvent, SessionSummary> => ({
      sessionId: handle.sessionId,
      mode: handle.mode,
      read: () => handle.read(),
      readPage: (afterSeq, limit) => handle.readPage(afterSeq, limit),
      append: async (draft) => {
        if (draft.type === 'session.titled') {
          markTitleAppendEntered();
          await titleAppendGate;
          if (persistenceClosed) {
            throw new Error('persistence closed before harness pipeline drained');
          }
          const committed = await handle.append(draft);
          lifecycleOrder.push('session.titled.appended');
          return committed;
        }
        return handle.append(draft);
      },
      ...(handle.appendBatch === undefined ? {} : {
        appendBatch: (drafts) => handle.appendBatch!(drafts),
      }),
      flush: () => handle.flush(),
      summary: () => handle.summary(),
      close: () => handle.close(),
    });

    const spyPersistence: SessionPersistencePort<LedgerEvent, SessionSummary> = {
      init: () => inner.init(),
      create: async (sessionId, initialDrafts, options) =>
        wrapHandle(await inner.create(sessionId, initialDrafts, options)),
      open: async (sessionId, mode: SessionStorageMode) =>
        wrapHandle(await inner.open(sessionId, mode)),
      stat: (sessionId) => inner.stat(sessionId),
      list: () => inner.list(),
      read: (sessionId) => inner.read(sessionId),
      readPage: (sessionId, afterSeq, limit) => inner.readPage(sessionId, afterSeq, limit),
      subscribe: (sessionId, listener) => inner.subscribe(sessionId, listener),
      deleteSession: (sessionId) => inner.deleteSession(sessionId),
      flush: () => inner.flush(),
      close: async () => {
        persistenceClosed = true;
        lifecycleOrder.push('persistence.close');
        await inner.close();
      },
    };

    const session = createSession(makeHost(roots), { persistence: spyPersistence });
    const { sessionId } = await session.createSession();

    let markTurnFinished!: () => void;
    const turnFinished = new Promise<void>((resolve) => {
      markTurnFinished = resolve;
    });
    const unsub = session.subscribe(sessionId, (event) => {
      if (event.type === 'turn.finished') {
        markTurnFinished();
      }
    });

    await session.send(sessionId, {
      text: 'say hello',
      model: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'default' },
    });

    await turnFinished;
    await titleAppendEntered;
    unsub();

    const closing = session.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(persistenceClosed).toBe(false);

    releaseTitleAppend();
    await closing;

    expect(persistenceClosed).toBe(true);
    expect(lifecycleOrder).toEqual(['session.titled.appended', 'persistence.close']);
    expect(inner.read(sessionId).some((event) =>
      event.type === 'session.titled' && event.text === 'Sample Session Title',
    )).toBe(true);
  });

  it('allows seeded document.content and workspace.changed drafts through createDocumentAuthority beforeAppend hook', () => {
    const roots = makeRoots();
    dirsToClean.push(roots.dir);

    let hook: ((ctx: DocumentBeforeAppendContext) => unknown) | undefined;
    const persistence: DocumentPersistencePort = {
      read: () => [],
      setBeforeAppendHook: (next) => {
        hook = next;
      },
    };

    createDocumentAuthority({
      workspaceRoot: roots.workspaceRoot,
      stateRoot: roots.stateRoot,
      persistence,
    });

    expect(hook).toBeDefined();
    const docDraft: LedgerEventDraft = {
      type: 'document.content',
      path: 'docs/spec.md',
      title: 'Spec',
      updated: '2026-11-18T00:00:00.000Z',
      version: 'v2',
      tokens: 10,
      source: 'write',
      format: 'diff',
      base: 'v1',
      content: '@@ -1 +1 @@\n-old\n+new\n',
    };
    const changeDraft: LedgerEventDraft = {
      type: 'workspace.changed',
      parent: 'a1',
      scope: 'document',
      target: 'docs/spec.md',
      change: 'updated',
    };

    expect(hook!({ sessionId: 's2', events: [], draft: docDraft, isSeed: true })).toEqual({
      action: 'append',
      draft: docDraft,
    });
    expect(hook!({ sessionId: 's2', events: [], draft: changeDraft, isSeed: true })).toEqual({
      action: 'append',
      draft: changeDraft,
    });
    expect(() => hook!({ sessionId: 's2', events: [], draft: changeDraft, isSeed: false })).toThrow(
      'Document changes must use commitDocument',
    );
  });
});
