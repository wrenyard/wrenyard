import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveWorkerIdentityKey,
  ForemanEventPoller,
  type ForemanEventRecord,
} from '../src/main/foreman-event-poller';
import { resolveForemanIpcPath } from '../src/main/foreman-ipc-client';
import type { ForgeEventSignal, SessionMetaData } from '../src/main/forge-types';

describe('ForemanEventPoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps DB-backed Foreman events into existing SiteModel signals over IPC', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const responses: unknown[] = [
      {
        events: [
          event(1, 'dispatch', '2026-06-20T01:00:00.000Z', { execution_id: 'exec-1' }),
          event(2, 'message', '2026-06-20T01:00:01.000Z', {
            task_id: 'task-1',
            execution_id: 'exec-1',
            data: { role: 'assistant', text: 'Checking the repo.' },
          }),
          event(3, 'tool_call', '2026-06-20T01:00:02.000Z', {
            task_id: 'task-1',
            execution_id: 'exec-1',
            data: { name: 'Read', call_id: 'call-1', input_summary: 'src/main' },
          }),
          event(4, 'tool_result', '2026-06-20T01:00:03.000Z', {
            task_id: 'task-1',
            execution_id: 'exec-1',
            data: { call_id: 'call-1', status: 'ok', output_tail: 'done' },
          }),
          event(5, 'turn_usage', '2026-06-20T01:00:04.000Z', {
            task_id: 'task-1',
            execution_id: 'exec-1',
            data: { input_tokens: 12, output_tokens: 8, duration_ms: 500 },
          }),
          event(6, 'terminal', '2026-06-20T01:00:05.000Z', {
            task_id: 'task-1',
            execution_id: 'exec-1',
            data: { status: 'done', summary: 'Finished checking the repo.' },
          }),
          event(7, 'task.done', '2026-06-20T01:00:06.000Z', {
            task_id: 'task-1',
            execution_id: 'exec-1',
            data: { status: 'done', summary: 'Finished checking the repo.' },
          }),
        ],
        count: 7,
        cursor: 7,
      },
      { events: [], count: 0, cursor: 7 },
    ];
    const seen: Array<{ key: string; signal: ForgeEventSignal; meta: SessionMetaData }> = [];
    const poller = new ForemanEventPoller({
      request: async (method, params) => {
        requests.push({ method, params });
        return responses.shift();
      },
      onSignal: (key, signal, meta) => seen.push({ key, signal, meta }),
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(requests).toEqual([
      { method: 'event.list', params: { limit: 200 } },
      { method: 'event.list', params: { since: 7, limit: 200 } },
    ]);
    expect(seen.map((item) => item.key)).toEqual([
      'exec-1',
      'exec-1',
      'exec-1',
      'exec-1',
      'exec-1',
      'exec-1',
    ]);
    expect(seen.map((item) => item.signal.kind)).toEqual([
      'spawn',
      'message',
      'tool_call',
      'tool_result',
      'turn_usage',
      'done',
    ]);
    expect(seen[0].meta).toMatchObject({
      workerIdentityKey: 'exec-1',
      profile: 'foreman',
      status: 'running',
    });
    expect(seen[5].meta.status).toBe('done');
    expect(seen[5].signal).toEqual({
      kind: 'done',
      ts: Date.parse('2026-06-20T01:00:05.000Z'),
      summary: 'Finished checking the repo.',
    });
  });

  it('uses the task native terminal summary and deduplicates result without task.done', async () => {
    const seen: Array<{ key: string; signal: ForgeEventSignal; meta: SessionMetaData }> = [];
    const poller = new ForemanEventPoller({
      request: async (method, params) => method === 'task.run.status'
        ? taskStatus(params, 'commit', 'workspace/commit')
        : ({
          events: [
            event(1, 'message', '2026-07-12T03:24:31.000Z', {
              task_id: 'task_59623684',
              execution_id: 'exec-commit',
              data: { role: 'assistant', text: '<foreman-task-output>...</foreman-task-output>' },
            }),
            event(2, 'terminal', '2026-07-12T03:24:33.000Z', {
              task_id: 'task_59623684',
              execution_id: 'exec-commit',
              status: 'done',
              exit_code: 0,
              data: { summary: 'Created and pushed the AGENTS.md deletion commit.' },
            }),
            event(3, 'result', '2026-07-12T03:24:33.000Z', {
              task_id: 'task_59623684',
              execution_id: 'exec-commit',
              status: 'done',
              exit_code: 0,
              data: { summary: 'Created and pushed the AGENTS.md deletion commit.' },
            }),
          ],
          count: 3,
          cursor: 3,
        }),
      onSignal: (key, signal, meta) => seen.push({ key, signal, meta }),
    });

    await poller.pollOnce();

    expect(seen.map((item) => item.signal.kind)).toEqual(['message', 'done']);
    expect(seen[1]).toMatchObject({
      key: 'exec-commit',
      signal: {
        kind: 'done',
        summary: 'Created and pushed the AGENTS.md deletion commit.',
      },
      meta: { status: 'done' },
    });
  });

  it('ignores daemon start facts while still mapping completion facts', async () => {
    const seen: Array<{ key: string; signal: ForgeEventSignal; meta: SessionMetaData }> = [];
    const poller = new ForemanEventPoller({
      request: async (method, params) => method === 'task.run.status'
        ? taskStatus(params, 'fact-task', 'workspace/fact-task')
        : ({
        events: [
          daemonFact(1, 'task.run.started', '2026-07-01T00:00:00.000Z', {
            refs: { executionId: 'exec-fact', taskId: 'task_abcdef12' },
            data: { task_name: 'Fact task', profile: 'codex', cwd: '/tmp/repo' },
          }),
          daemonFact(2, 'task.run.completed', '2026-07-01T00:00:01.000Z', {
            refs: { executionId: 'exec-fact', taskId: 'task_abcdef12' },
            data: { summary: 'Fact task done.' },
          }),
        ],
        count: 2,
        cursor: 2,
      }),
      onSignal: (key, signal, meta) => seen.push({ key, signal, meta }),
    });

    await poller.pollOnce();

    expect(seen.map((item) => item.key)).toEqual(['exec-fact']);
    expect(seen.map((item) => item.signal.kind)).toEqual(['done']);
    expect(seen[0].meta).toMatchObject({
      taskId: 'fact-task',
      taskName: 'fact-task',
      taskLabel: 'fact-task',
      profile: 'codex',
      workDir: '/tmp/repo',
    });
    expect(seen[0].signal).toMatchObject({ summary: 'Fact task done.' });
  });

  it('caches task names from start facts for later messages with generated run ids', async () => {
    const seen: Array<{ key: string; signal: ForgeEventSignal; meta: SessionMetaData }> = [];
    const poller = new ForemanEventPoller({
      request: async (method, params) => method === 'task.run.status'
        ? taskStatus(params, 'explore-doc', 'workspace/explore-doc')
        : ({
        events: [
          daemonFact(1, 'task.run.started', '2026-07-09T00:00:00.000Z', {
            refs: { taskId: 'task_a1b99341', executionId: 'exec-explore' },
            data: {
              taskName: 'explore-doc',
              qualifiedName: 'workspace/explore-doc',
              profile: 'codex',
              cwd: '/tmp/repo',
            },
          }),
          event(2, 'message', '2026-07-09T00:00:01.000Z', {
            task_id: 'task_a1b99341',
            execution_id: 'exec-explore',
            data: { role: 'assistant', text: 'Checking the repo.' },
          }),
        ],
        count: 2,
        cursor: 2,
      }),
      onSignal: (key, signal, meta) => seen.push({ key, signal, meta }),
    });

    await poller.pollOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe('exec-explore');
    expect(seen[0].signal.kind).toBe('message');
    expect(seen[0].meta).toMatchObject({
      taskId: 'explore-doc',
      taskName: 'explore-doc',
      taskLabel: 'explore-doc',
      profile: 'codex',
      workDir: '/tmp/repo',
    });
  });

  it('maps queue-waiting to a queued signal without requiring a worker spawn', async () => {
    const seen: Array<{ key: string; signal: ForgeEventSignal; meta: SessionMetaData }> = [];
    const poller = new ForemanEventPoller({
      request: async (method, params) => method === 'task.run.status'
        ? taskStatus(params, 'queued-task', 'workspace/queued-task')
        : ({
        events: [
          event(1, 'task.started', '2026-07-01T00:00:00.000Z', {
            task_id: 'task_1111aaaa',
            execution_id: 'exec-queued',
            data: { task_name: 'Queued task', profile: 'codex' },
          }),
          event(2, 'queue-waiting', '2026-07-01T00:00:01.000Z', {
            task_id: 'task_1111aaaa',
            execution_id: 'exec-queued',
            data: { task_name: 'Queued task', profile: 'codex' },
          }),
          event(3, 'queue-acquired', '2026-07-01T00:00:02.000Z', {
            task_id: 'task_1111aaaa',
            execution_id: 'exec-queued',
            data: { task_name: 'Queued task', profile: 'codex' },
          }),
        ],
        count: 3,
        cursor: 3,
      }),
      onSignal: (key, signal, meta) => seen.push({ key, signal, meta }),
    });

    await poller.pollOnce();

    expect(seen.map((item) => item.key)).toEqual(['exec-queued', 'exec-queued']);
    expect(seen.map((item) => item.signal.kind)).toEqual(['queued', 'working']);
    expect(seen[0].meta).toMatchObject({
      taskId: 'queued-task',
      taskName: 'queued-task',
      taskLabel: 'queued-task',
      profile: 'codex',
    });
  });

  it('drains startup backlog to the latest cursor without emitting replayed events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T01:00:10.000Z'));

    const requests: Array<{ method: string; params: unknown }> = [];
    const responses: unknown[] = [
      {
        events: [
          event(1, 'dispatch', '2026-06-20T01:00:09.999Z', { execution_id: 'old-exec' }),
          event(2, 'dispatch', '2026-06-20T01:00:10.000Z', { execution_id: 'new-exec' }),
        ],
        count: 2,
      },
      { events: [], count: 0 },
    ];
    const seen: Array<{ key: string; signal: ForgeEventSignal }> = [];
    const poller = new ForemanEventPoller({
      intervalMs: 60_000,
      request: async (method, params) => {
        requests.push({ method, params });
        return responses.shift();
      },
      onSignal: (key, signal) => seen.push({ key, signal }),
    });

    poller.start();
    await flushPromises();
    poller.stop();
    await poller.pollOnce();

    expect(requests).toEqual([
      { method: 'event.list', params: { limit: 1000 } },
      { method: 'event.list', params: { since: 2, limit: 200 } },
    ]);
    expect(seen).toEqual([]);
  });

  it('advances the fallback cursor over unsupported event rows', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const responses: unknown[] = [
      {
        events: [
          {
            id: 12,
            type: 'not-yet-supported',
            timestamp: '2026-06-20T02:30:00.000Z',
            execution_id: 'exec-unsupported',
          },
        ],
        count: 1,
      },
      { events: [], count: 0 },
    ];
    const seen: ForgeEventSignal[] = [];
    const poller = new ForemanEventPoller({
      request: async (method, params) => {
        requests.push({ method, params });
        return responses.shift();
      },
      onSignal: (_key, signal) => seen.push(signal),
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(requests[1]).toEqual({ method: 'event.list', params: { since: 12, limit: 200 } });
    expect(seen).toEqual([]);
  });

  it('tolerates Foreman being down and retries on the next poll', async () => {
    let calls = 0;
    const seen: ForgeEventSignal[] = [];
    const poller = new ForemanEventPoller({
      request: async () => {
        calls++;
        if (calls === 1) throw new Error('connection refused');
        return {
          events: [
            event(1, 'dispatch', '2026-06-20T03:00:00.000Z', { session_id: 'session-1' }),
          ],
          count: 1,
          cursor: 1,
        };
      },
      onSignal: (_key, signal) => seen.push(signal),
    });

    await expect(poller.pollOnce()).resolves.toBeUndefined();
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    expect(seen).toEqual([{ kind: 'spawn', ts: Date.parse('2026-06-20T03:00:00.000Z') }]);
  });

  it('does not emit signals from an in-flight start poll after stop', async () => {
    let resolvePayload: (payload: unknown) => void = () => undefined;
    const response = new Promise<unknown>((resolve) => {
      resolvePayload = resolve;
    });
    const seen: ForgeEventSignal[] = [];
    const poller = new ForemanEventPoller({
      intervalMs: 60_000,
      request: async () => response,
      onSignal: (_key, signal) => seen.push(signal),
    });

    poller.start();
    poller.stop();
    resolvePayload({
      events: [
        event(1, 'dispatch', '2999-06-20T03:00:00.000Z', { execution_id: 'exec-stopped' }),
      ],
      count: 1,
      cursor: 1,
    });
    await response;
    await flushPromises();

    expect(seen).toEqual([]);
  });

  it('keeps worker aliases stable as richer ids arrive', async () => {
    const seen: Array<{ key: string; kind: ForgeEventSignal['kind'] }> = [];
    const poller = new ForemanEventPoller({
      request: async () => ({
        events: [
          event(1, 'dispatch', '2026-06-20T05:30:00.000Z', {
            session_id: 'session-before-exec',
          }),
          event(2, 'message', '2026-06-20T05:30:01.000Z', {
            execution_id: 'exec-late',
            session_id: 'session-before-exec',
            data: { role: 'assistant', text: 'Execution id arrived late.' },
          }),
          event(3, 'terminal', '2026-06-20T05:30:02.000Z', {
            execution_id: 'exec-late',
            data: { status: 'done' },
          }),
        ],
        count: 3,
        cursor: 3,
      }),
      onSignal: (key, signal) => seen.push({ key, kind: signal.kind }),
    });

    await poller.pollOnce();

    expect(seen).toEqual([
      { key: 'session-before-exec', kind: 'spawn' },
      { key: 'session-before-exec', kind: 'message' },
      { key: 'session-before-exec', kind: 'done' },
    ]);
  });

  it('derives stable worker keys in workflow, session, execution, id order (task_run_id preserved separately)', () => {
    expect(deriveWorkerIdentityKey(event(1, 'dispatch', '2026-06-20T04:00:00.000Z', {
      task_id: 'task',
      workflow_id: 'workflow',
      execution_id: 'execution',
      session_id: 'session',
    }))).toBe('workflow');
    expect(deriveWorkerIdentityKey(event(6, 'dispatch', '2026-06-20T04:00:00.000Z', {
      task_run_id: 'task_a1b99341',
      task_id: 'task',
      workflow_id: 'workflow',
      execution_id: 'execution',
      session_id: 'session',
    }))).toBe('workflow');
    expect(deriveWorkerIdentityKey(event(2, 'dispatch', '2026-06-20T04:00:00.000Z', {
      workflow_id: 'workflow',
      session_id: 'session',
      execution_id: 'execution',
    }))).toBe('workflow');
    expect(deriveWorkerIdentityKey(event(3, 'dispatch', '2026-06-20T04:00:00.000Z', {
      session_id: 'session',
      execution_id: 'execution',
    }))).toBe('session');
    expect(deriveWorkerIdentityKey(event(4, 'dispatch', '2026-06-20T04:00:00.000Z', {
      execution_id: 'execution',
    }))).toBe('execution');
    expect(deriveWorkerIdentityKey(event(5, 'dispatch', '2026-06-20T04:00:00.000Z'))).toBe('5');
  });

  it('preserves task_run_id separately as foremanTaskRunID, distinct from workerIdentityKey', async () => {
    const seen: Array<{ key: string; meta: SessionMetaData }> = [];
    const poller = new ForemanEventPoller({
      request: async (_method, _params) => ({
        events: [
          event(1, 'dispatch', '2026-06-20T04:00:00.000Z', {
            task_run_id: 'task_a1b99341',
            execution_id: 'exec-1',
          }),
        ],
        count: 1,
        cursor: 1,
      }),
      onSignal: (key, _signal, meta) => seen.push({ key, meta }),
    });

    await poller.pollOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe('exec-1');
    expect(seen[0].meta.workerIdentityKey).toBe('exec-1');
    expect(seen[0].meta.foremanTaskRunID).toBe('task_a1b99341');
  });

  it('resolves the Wrenyard IPC path from WRENYARD_IPC_PATH, legacy Foreman env, then the shared wrenyard.sock default', () => {
    expect(resolveForemanIpcPath({
      WRENYARD_IPC_PATH: '/tmp/wrenyard.sock',
      FOREMAN_IPC_PATH: '/tmp/foreman.sock',
      FOREMAN_PET_FOREMAN_IPC: '/tmp/pet.sock',
    })).toBe('/tmp/wrenyard.sock');
    expect(resolveForemanIpcPath({
      FOREMAN_IPC_PATH: '/tmp/foreman.sock',
    })).toBe('/tmp/foreman.sock');
    expect(resolveForemanIpcPath({
      FOREMAN_PET_FOREMAN_IPC: '/tmp/pet.sock',
    })).toBe('/tmp/pet.sock');
    expect(resolveForemanIpcPath({})).toMatch(/wrenyard\.sock$/);
  });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function event(
  id: number,
  type: ForemanEventRecord['type'],
  timestamp: string,
  payload: Omit<Partial<ForemanEventRecord>, 'id' | 'type' | 'timestamp'> = {},
): ForemanEventRecord {
  return {
    id,
    type,
    timestamp,
    ...payload,
  };
}

function daemonFact(
  id: number,
  type: string,
  timestamp: string,
  payload: Record<string, unknown>,
): ForemanEventRecord {
  return {
    id,
    type: type as ForemanEventRecord['type'],
    timestamp,
    data: {
      schema_version: 'foreman.event.v1',
      ...payload,
    } as ForemanEventRecord['data'],
  };
}

function taskStatus(params: unknown, template: string, qualifiedName: string): unknown {
  const taskRunId = isRecord(params) && typeof params.task_run_id === 'string'
    ? params.task_run_id
    : 'task_unknown';
  return {
    task_run_id: taskRunId,
    status: 'running',
    _meta: {
      task_run_id: taskRunId,
      template,
      qualified_name: qualifiedName,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
