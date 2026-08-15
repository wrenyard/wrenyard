import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_SNAPSHOT_SCHEMA_VERSION,
  deriveActivityPresence,
  normalizeActivitySnapshotV1,
  normalizeTrackedTaskgraphIds,
  type ActivityPresence,
  type ActivitySnapshotV1,
} from '../src/shared/activity-snapshot';
import { ActivitySnapshotPoller } from '../src/main/activity-snapshot-poller';
import type { DiagnosticLogger } from '../src/main/diagnostic-logger';
import { SiteModel } from '../src/main/site-model';
import { projectGraphSlipFromActivity } from '../src/main/graph-slip-snapshot-dto';
import { nodeTip, taskStatusLabelZh } from '../src/panels/observatory/graph-visuals';
import type { TaskGraphInspectResult, GraphSlipSnapshotDto } from '../src/shared/taskgraph';
import type { SessionMetaData } from '../src/main/forge-types';

// ── Wire response factories ──────────────────────────────────────────

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_run_id: 'run-1',
    status: 'running',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: 'node-a',
    state: 'running',
    ...overrides,
  };
}

function taskgraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskgraph_id: 'tg-1',
    state: 'running',
    on_node_failure: 'pause',
    cancel_requested: false,
    structure_revision: 1,
    latest_seq: 3,
    node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
    active: { running: ['node-a'], waiting: [] },
    nodes: [node()],
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: ACTIVITY_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: '2025-01-01T00:01:00.000Z',
    tasks: [task()],
    taskgraphs: [taskgraph()],
    ...overrides,
  };
}

// ── Strict normalizer ────────────────────────────────────────────────

describe('ActivitySnapshot normalizer', () => {
  it('normalizes a complete v1 payload into the strict projection', () => {
    const raw = snapshot({
      tasks: [
        task({
          task_run_id: 'run-tg',
          status: 'running',
          task_id: 'plan-review',
          task_label: '  Plan Review ',
          project: 'workspace/pet',
          worktree: true,
          requested_agent_runtime: 'codex',
          resolved_profile: 'codex-fast',
          taskgraph_id: 'tg-1',
          node_id: 'node-a',
        }),
        task({ task_run_id: 'run-queued', status: 'queued', task_id: 'doc' }),
      ],
      taskgraphs: [
        taskgraph({
          state: 'paused',
          title: '  Review PR  ',
          project: 'workspace/pet',
          cancel_requested: true,
          terminal_reason: 'node_failed',
          nodes: [
            node({
              task_run_id: 'run-tg',
              task_id: 'commit/forge-deploy/investigate',
              task_status: 'queued',
              task_category: { id: 'code-review', display_label: '代码审查' },
              display_label: '审查改动',
              description: '  Review the diff  ',
              requested_agent_runtime: 'codex',
              resolved_profile: 'codex-fast',
              tool_call_count: 3,
              tps: 12.5,
              summary: 'No regressions',
            }),
          ],
        }),
      ],
    });

    const result = normalizeActivitySnapshotV1(raw);
    expect(result.schema_version).toBe(ACTIVITY_SNAPSHOT_SCHEMA_VERSION);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      task_run_id: 'run-tg',
      status: 'running',
      task_id: 'plan-review',
      task_label: 'Plan Review',
      worktree: true,
      taskgraph_id: 'tg-1',
    });
    expect(result.tasks[1].status).toBe('queued');
    expect(result.taskgraphs[0]).toMatchObject({
      taskgraph_id: 'tg-1',
      state: 'paused',
      title: 'Review PR',
      cancel_requested: true,
      terminal_reason: 'node_failed',
      structure_revision: 1,
    });
    expect(result.taskgraphs[0].nodes[0]).toMatchObject({
      node_id: 'node-a',
      state: 'running',
      task_run_id: 'run-tg',
      task_id: 'commit/forge-deploy/investigate',
      task_status: 'queued',
      task_category: { id: 'code-review', display_label: '代码审查' },
      display_label: '审查改动',
      description: 'Review the diff',
      tool_call_count: 3,
      tps: 12.5,
      summary: 'No regressions',
    });
  });

  it('rejects the whole round on schema_version mismatch', () => {
    expect(() => normalizeActivitySnapshotV1(snapshot({ schema_version: 'foreman.activity.snapshot.v2' }))).toThrow(
      'schema_version mismatch',
    );
  });

  it('rejects the whole round on a malformed required task field', () => {
    expect(() => normalizeActivitySnapshotV1(snapshot({ tasks: [task({ status: 'done' })] }))).toThrow(
      'invalid value "done"',
    );
    expect(() => normalizeActivitySnapshotV1(snapshot({ tasks: [task({ task_run_id: 42 })] }))).toThrow();
    expect(() => normalizeActivitySnapshotV1(snapshot({ tasks: [{ status: 'running' }] }))).toThrow(
      'task_run_id',
    );
  });

  it('rejects the whole round on a malformed required graph field', () => {
    expect(() => normalizeActivitySnapshotV1(snapshot({ taskgraphs: [taskgraph({ on_node_failure: 'restart' })] }))).toThrow(
      'invalid value "restart"',
    );
    expect(() => normalizeActivitySnapshotV1(snapshot({ taskgraphs: [taskgraph({ node_counts: {} })] }))).toThrow(
      'node_counts',
    );
    expect(() => normalizeActivitySnapshotV1(snapshot({ taskgraphs: [taskgraph({ nodes: [{}] })] }))).toThrow(
      'node_id',
    );
  });

  it('rejects oversized cardinality fail-closed before element normalization', () => {
    expect(() => normalizeActivitySnapshotV1(snapshot({ tasks: new Array(600).fill(0) }))).toThrow(
      'tasks cardinality',
    );
    expect(() => normalizeActivitySnapshotV1(snapshot({ taskgraphs: new Array(200).fill(0) }))).toThrow(
      'taskgraphs cardinality',
    );
    expect(() => normalizeActivitySnapshotV1(snapshot({ taskgraphs: [taskgraph({ nodes: new Array(2048).fill(0) })] }))).toThrow(
      'nodes cardinality',
    );
  });

  it('omits out-of-bounds display strings fail-closed without rejecting the round', () => {
    const result = normalizeActivitySnapshotV1(snapshot({
      tasks: [task({ task_label: 'x'.repeat(500) })],
      taskgraphs: [taskgraph({ title: 'x'.repeat(500), nodes: [node({ summary: 'x'.repeat(500), tps: 2_000_000 })] })],
    }));
    expect(result.tasks[0].task_label).toBeUndefined();
    expect(result.taskgraphs[0].title).toBeUndefined();
    expect(result.taskgraphs[0].nodes[0].summary).toBeUndefined();
    expect(result.taskgraphs[0].nodes[0].tps).toBeUndefined();
  });

  it('rejects invalid sampled_at / missing arrays', () => {
    expect(() => normalizeActivitySnapshotV1(snapshot({ sampled_at: 42 }))).toThrow('sampled_at');
    expect(() => normalizeActivitySnapshotV1(snapshot({ tasks: {} }))).toThrow('tasks must be an array');
    expect(() => normalizeActivitySnapshotV1(snapshot({ taskgraphs: {} }))).toThrow('taskgraphs must be an array');
  });
});

describe('deriveActivityPresence', () => {
  it('projects queued/running tasks and graph nodes in camelCase', () => {
    const normalized = normalizeActivitySnapshotV1(snapshot({
      tasks: [
        task({ task_run_id: 'run-r', status: 'running', task_id: 'a' }),
        task({ task_run_id: 'run-q', status: 'queued', task_id: 'b' }),
      ],
    }));
    const presence = deriveActivityPresence(normalized, false);
    expect(presence.stale).toBe(false);
    expect(presence.tasks).toEqual([
      expect.objectContaining({ taskRunId: 'run-r', status: 'running', taskId: 'a' }),
      expect.objectContaining({ taskRunId: 'run-q', status: 'queued', taskId: 'b' }),
    ]);
    expect(presence.taskgraphs[0]).toEqual(expect.objectContaining({
      taskgraphId: 'tg-1',
      state: 'running',
      structureRevision: 1,
      latestSeq: 3,
    }));
    expect(presence.taskgraphs[0].nodes[0]).toEqual(expect.objectContaining({ nodeId: 'node-a', state: 'running' }));
  });
});

// ── Unique generation-gated poller ───────────────────────────────────

describe('ActivitySnapshotPoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes a strictly normalized fresh presence on success', async () => {
    const published: ActivityPresence[] = [];
    const poller = new ActivitySnapshotPoller({
      request: async () => snapshot(),
      onPresence: (p) => published.push(p),
    });
    await poller.pollOnce();
    expect(published).toHaveLength(1);
    expect(published[0].stale).toBe(false);
    expect(published[0].tasks[0].taskRunId).toBe('run-1');
    expect(published[0].taskgraphs[0].taskgraphId).toBe('tg-1');
  });

  it('sends tracked terminal graph ids (deduped and bounded)', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const poller = new ActivitySnapshotPoller({
      request: async (method, params) => {
        calls.push({ method, params });
        return snapshot();
      },
      getTrackedTaskgraphIds: () => ['tg-a', 'tg-b', 'tg-a'],
      onPresence: () => undefined,
    });
    await poller.pollOnce();
    expect(calls[0]).toEqual({
      method: 'activity.snapshot',
      params: { tracked_taskgraph_ids: ['tg-a', 'tg-b'] },
    });
  });

  it('discards a failed round and re-publishes the previous complete presence as uniformly stale', async () => {
    const published: ActivityPresence[] = [];
    let calls = 0;
    const poller = new ActivitySnapshotPoller({
      request: async () => {
        calls++;
        if (calls === 1) return snapshot();
        throw new Error('daemon down');
      },
      onPresence: (p) => published.push(p),
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(published).toHaveLength(2);
    expect(published[0].stale).toBe(false);
    // Previous complete state retained: counts/surfaces intact, stale marked.
    expect(published[1].stale).toBe(true);
    expect(published[1].tasks).toEqual(published[0].tasks);
    expect(published[1].taskgraphs).toEqual(published[0].taskgraphs);
  });

  it('recovers to a fresh presence after failures', async () => {
    const published: ActivityPresence[] = [];
    let calls = 0;
    const poller = new ActivitySnapshotPoller({
      request: async () => {
        calls++;
        if (calls === 2) throw new Error('transient');
        return snapshot({ sampled_at: `2025-01-01T00:0${calls}:00.000Z` });
      },
      onPresence: (p) => published.push(p),
    });

    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();

    expect(published.map((p) => p.stale)).toEqual([false, true, false]);
    expect(published[2].sampledAt).toContain('00:03');
  });

  it('does not publish stale-generation results after stop', async () => {
    let resolvePayload: (p: unknown) => void = () => undefined;
    const response = new Promise<unknown>((resolve) => {
      resolvePayload = resolve;
    });
    const published: ActivityPresence[] = [];
    const poller = new ActivitySnapshotPoller({
      request: async () => response,
      onPresence: (p) => published.push(p),
    });

    poller.start();
    poller.stop();
    resolvePayload(snapshot());
    await response;
    await Promise.resolve();
    await Promise.resolve();

    expect(published).toEqual([]);
  });

  it('polls on a fixed 2s interval by default', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const poller = new ActivitySnapshotPoller({
      request: async () => {
        calls++;
        return snapshot();
      },
      onPresence: () => undefined,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBeGreaterThanOrEqual(2);
    poller.stop();
  });
});

// ── SiteModel atomic reconcile + event demotion ──────────────────────

function presenceWith(overrides: Partial<ActivityPresence> = {}): ActivityPresence {
  return {
    sampledAt: '2025-01-01T00:01:00.000Z',
    stale: false,
    tasks: [],
    taskgraphs: [],
    ...overrides,
  };
}

function meta(workerIdentityKey: string, overrides: Partial<SessionMetaData> = {}): SessionMetaData {
  return {
    workerIdentityKey,
    profile: 'codex',
    workDir: '/tmp/test',
    isWorktree: false,
    status: 'running',
    ...overrides,
  };
}

describe('SiteModel activity reconcile', () => {
  it('[restart-recovery] first successful sample restores Wren=2, house running=3, worker=3 without events', () => {
    const m = new SiteModel({ now: () => 1000 });
    // Two running TG tasks + one direct running task.
    m.reconcileActivity(presenceWith({
      tasks: [
        { taskRunId: 'run-tg-1', status: 'running', taskgraphId: 'tg-1', nodeId: 'n1', taskId: 't1', resolvedProfile: 'codex' },
        { taskRunId: 'run-tg-2', status: 'running', taskgraphId: 'tg-2', nodeId: 'n2', taskId: 't2', resolvedProfile: 'codex' },
        { taskRunId: 'run-direct', status: 'running', taskId: 't3', resolvedProfile: 'codex' },
      ],
      taskgraphs: [
        { taskgraphId: 'tg-1', state: 'running', structureRevision: 1, latestSeq: 1, nodeCounts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: ['n1'], waiting: [] }, nodes: [] },
        { taskgraphId: 'tg-2', state: 'running', structureRevision: 1, latestSeq: 1, nodeCounts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: ['n2'], waiting: [] }, nodes: [] },
      ],
    }));

    const snap = m.snapshot();
    expect(snap.workers).toHaveLength(3);
    expect(snap.queuedCount).toBe(0);
    expect(snap.activityStale).toBeUndefined();
    // direct + TG tasks share the same worker list (no double counting).
    const workerKeys = snap.workers.map((w) => w.workerIdentityKey);
    expect(workerKeys).toEqual(expect.arrayContaining(['run-tg-1', 'run-tg-2', 'run-direct']));
    expect(snap.workers.find((w) => w.workerIdentityKey === 'run-direct')?.meta.taskId).toBe('t3');
  });

  it('queued tasks set queuedCount without creating workers; workers leave when the snapshot stops listing them', () => {
    const m = new SiteModel({ now: () => 1000 });
    m.reconcileActivity(presenceWith({
      tasks: [
        { taskRunId: 'run-q', status: 'queued', taskId: 'tq' },
        { taskRunId: 'run-r', status: 'running', taskId: 'tr' },
      ],
    }));
    let snap = m.snapshot();
    expect(snap.queuedCount).toBe(1);
    expect(snap.workers).toHaveLength(1);

    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-q', status: 'queued', taskId: 'tq' }],
    }));
    snap = m.snapshot();
    expect(snap.queuedCount).toBe(1);
    expect(snap.workers).toHaveLength(0);
  });

  it('[atomic-stale] a failed round keeps the previous complete state and marks it stale without clearing any surface', () => {
    const m = new SiteModel({ now: () => 1000 });
    m.reconcileActivity(presenceWith({
      tasks: [
        { taskRunId: 'run-a', status: 'running', taskId: 'ta' },
        { taskRunId: 'run-q', status: 'queued', taskId: 'tq' },
      ],
    }));
    const before = m.snapshot();

    m.reconcileActivity(presenceWith({ stale: true }));

    const after = m.snapshot();
    expect(after.workers).toHaveLength(before.workers.length);
    expect(after.queuedCount).toBe(before.queuedCount);
    expect(after.activityStale).toBe(true);
    expect(after.workers[0].workerIdentityKey).toBe('run-a');

    // Recovery clears stale and publishes the fresh round.
    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-b', status: 'running', taskId: 'tb' }],
    }));
    expect(m.snapshot().activityStale).toBeUndefined();
    expect(m.snapshot().workers[0].workerIdentityKey).toBe('run-b');
  });

  it('[event-demotion] transient events enrich existing workers but never create/delete workers or change counts', () => {
    const m = new SiteModel({ now: () => 1000 });
    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-a', status: 'running', taskId: 'ta' }],
    }));
    expect(m.snapshot().workers).toHaveLength(1);

    // A message event keyed by session reaches the snapshot worker via task_run_id.
    m.ingestTransient(
      { kind: 'message', role: 'assistant', text: 'Checking the repo.', ts: 2000 },
      meta('session-1', { foremanTaskRunID: 'run-a', taskId: 'ta' }),
    );
    let snap = m.snapshot();
    expect(snap.workers).toHaveLength(1);
    expect(snap.workers[0].lastText).toBe('Checking the repo.');
    expect(snap.queuedCount).toBe(0);

    // Lifecycle signals are ignored entirely by ingestTransient.
    m.ingestTransient({ kind: 'done', ts: 3000, summary: 'done' }, meta('session-1', { foremanTaskRunID: 'run-a' }));
    m.ingestTransient({ kind: 'queued', ts: 3000 }, meta('session-1', { foremanTaskRunID: 'run-a' }));
    snap = m.snapshot();
    expect(snap.workers).toHaveLength(1);
    expect(snap.workers[0].phase).toBe('working');
    expect(snap.queuedCount).toBe(0);

    // A message for an unknown worker creates nothing.
    m.ingestTransient(
      { kind: 'message', role: 'assistant', text: 'orphan', ts: 4000 },
      meta('session-orphan', { foremanTaskRunID: 'run-missing' }),
    );
    expect(m.snapshot().workers).toHaveLength(1);
  });

  it('[taskgraph-count-chain] the same snapshot drives house running/queued and 图纸 count', () => {
    const m = new SiteModel({ now: () => 1000 });
    m.reconcileActivity(presenceWith({
      tasks: [
        { taskRunId: 'run-direct', status: 'running', taskId: 't3' },
        { taskRunId: 'run-tg-1', status: 'running', taskgraphId: 'tg-1' },
        { taskRunId: 'run-q', status: 'queued', taskId: 'tq' },
      ],
      taskgraphs: [
        graphPresencePresence('tg-1', 'running'),
        graphPresencePresence('tg-2', 'paused'),
        graphPresencePresence('tg-done', 'done'),
      ],
    }));
    const snap = m.snapshot();
    // running worker count = 2 (direct + TG task share one task list, no double count)
    expect(snap.workers).toHaveLength(2);
    expect(snap.queuedCount).toBe(1);
    // 图纸 count counts non-terminal graphs only (tg-1, tg-2).
    expect(snap.taskgraphCount).toBe(2);
    // A stale round keeps counts and marks stale without clearing the graph count.
    m.reconcileActivity(presenceWith({ stale: true }));
    const stale = m.snapshot();
    expect(stale.taskgraphCount).toBe(2);
    expect(stale.workers).toHaveLength(2);
    expect(stale.activityStale).toBe(true);
  });

  it('[cold-start-notification] first snapshot shows one recovery summary card via the model broadcast', () => {
    const m = new SiteModel({ now: () => 1000 });
    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-1', status: 'running' }],
      taskgraphs: [graphPresencePresence('tg-1', 'running')],
    }));
    expect(m.snapshot().broadcast?.text).toBe('已恢复：1 个任务运行中 · 1 张图纸');
    expect(m.snapshot().broadcast?.intensity).toBe('transient');
    expect(m.snapshot().broadcast?.untilMs).toBe(1000 + 8000);
  });

  it('[notifications] transient card expires after 8s', () => {
    let t = 1000;
    const m = new SiteModel({ now: () => t });
    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-1', status: 'running' }],
      taskgraphs: [graphPresencePresence('tg-1', 'running')],
    }));
    expect(m.snapshot().broadcast).toBeDefined();
    // Before expiry the card persists across ticks.
    m.tick();
    expect(m.snapshot().broadcast).toBeDefined();
    // At/after untilMs (1000 + 8000) the transient card expires.
    t = 9000;
    m.tick();
    expect(m.snapshot().broadcast).toBeUndefined();
  });

  it('[notifications] error pause is sticky; dismiss or recovery revokes it', () => {
    const m = new SiteModel({ now: () => 1000 });
    // Cold start with a running graph, then clear the summary slot.
    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-1', status: 'running' }],
      taskgraphs: [graphPresencePresence('tg-1', 'running')],
    }));
    m.clearBroadcast(m.snapshot().broadcast?.id);
    expect(m.snapshot().broadcast).toBeUndefined();

    // Graph hits an error pause → sticky card.
    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-1', status: 'running' }],
      taskgraphs: [graphPresencePresence('tg-1', 'paused', { failed: 1 })],
    }));
    const paused = m.snapshot().broadcast;
    expect(paused).toBeDefined();
    expect(paused!.text).toBe('图纸遇到错误，已暂停：未命名任务图');
    expect(paused!.intensity).toBe('sticky');

    // Recovery revokes the sticky card and shows 图纸已恢复.
    m.reconcileActivity(presenceWith({
      tasks: [{ taskRunId: 'run-1', status: 'running' }],
      taskgraphs: [graphPresencePresence('tg-1', 'running')],
    }));
    expect(m.snapshot().broadcast?.text).toBe('图纸已恢复：未命名任务图');
  });
});

function graphPresencePresence(
  id: string,
  state: 'created' | 'running' | 'paused' | 'done' | 'cancelled',
  overrides: { failed?: number } = {},
): import('../src/shared/activity-snapshot').ActivityTaskGraphPresence {
  return {
    taskgraphId: id,
    state,
    structureRevision: 1,
    latestSeq: 1,
    nodeCounts: {
      planned: 0,
      running: state === 'running' ? 1 : 0,
      waiting: 0,
      done: state === 'done' ? 1 : 0,
      failed: overrides.failed ?? (state === 'paused' ? 1 : 0),
      interrupted: 0,
      cancelled: 0,
    },
    active: { running: state === 'running' ? ['n1'] : [], waiting: [] },
    nodes: [],
  };
}

// ── task-status precedence (node/task two-level semantics) ───────────

describe('Graph Slip task-status precedence', () => {
  const structure: TaskGraphInspectResult = {
    graph: {
      id: 'tg-1',
      revision: 1,
      nodes: {
        'node-a': { id: 'node-a', action: { type: 'task' }, deps: [] },
        'node-b': { id: 'node-b', action: { type: 'task' }, deps: ['node-a'] },
      },
    },
  };

  it('[task-status-precedence] a running node with a queued task run renders 排队中 from the same snapshot', () => {
    const graph = {
      taskgraphId: 'tg-1',
      state: 'running' as const,
      structureRevision: 1,
      latestSeq: 1,
      nodeCounts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
      active: { running: ['node-a'] as string[], waiting: [] as string[] },
      nodes: [
        { nodeId: 'node-a', state: 'running' as const, taskRunId: 'run-a', taskStatus: 'queued' as const },
        { nodeId: 'node-b', state: 'waiting' as const, taskRunId: 'run-b' },
      ],
    };
    const dto = projectGraphSlipFromActivity(structure, graph);
    expect(dto.nodes['node-a'].state).toBe('running');
    expect(dto.nodes['node-a'].task_status).toBe('queued');
    const tip = nodeTip(dto.nodes['node-a'], 'task');
    expect(tip!.rows.find((r) => r.label === '状态')!.value).toBe('排队中');
    // No separate status/slip source: the node without task_status falls back
    // to its node state label.
    expect(nodeTip(dto.nodes['node-b'], 'task')!.rows[0].value).toBe('等待中');
  });

  it('taskStatusLabelZh prefers task status and falls back to node state', () => {
    expect(taskStatusLabelZh('queued', 'running')).toBe('排队中');
    expect(taskStatusLabelZh('running', 'running')).toBe('运行中');
    expect(taskStatusLabelZh(undefined, 'waiting')).toBe('等待中');
  });
});

// ── Pet-only static task_title projection ────────────────────────────
// The cached same-revision static node.name is validated (single-line/CJK/
// 48 UTF-16) and projected as task_title; the activity snapshot remains the
// sole dynamic SSOT and never supplies the heading directly.

describe('Graph Slip static task_title projection', () => {
  const structure: TaskGraphInspectResult = {
    graph: {
      id: 'tg-1',
      revision: 1,
      nodes: {
        'node-a': { id: 'node-a', name: '接收订单', action: { type: 'task' }, deps: [] },
        'node-b': { id: 'node-b', name: 'Analyze', action: { type: 'task' }, deps: [] },
        'node-c': { id: 'node-c', action: { type: 'task' }, deps: [] },
      },
    },
  };

  const graph = {
    taskgraphId: 'tg-1',
    state: 'running' as const,
    structureRevision: 1,
    latestSeq: 1,
    nodeCounts: { planned: 0, running: 3, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
    active: { running: ['node-a', 'node-b', 'node-c'] as string[], waiting: [] as string[] },
    nodes: [
      { nodeId: 'node-a', state: 'running' as const, taskRunId: 'run-a', taskCategoryLabel: '订单接收' },
      { nodeId: 'node-b', state: 'running' as const, taskRunId: 'run-b', taskCategoryLabel: '代码审查' },
      { nodeId: 'node-c', state: 'running' as const, taskRunId: 'run-c', taskCategoryLabel: '终审' },
    ],
  };

  it('projects a valid Chinese static name as task_title and omits invalid ones', () => {
    const dto = projectGraphSlipFromActivity(structure, graph);
    expect(dto.nodes['node-a'].task_title).toBe('接收订单');
    expect(dto.nodes['node-b'].task_title).toBeUndefined(); // English-only name
    expect(dto.nodes['node-c'].task_title).toBeUndefined(); // no static name
    // Heading precedence: task_title → display_label → 任务.
    expect(nodeTip(dto.nodes['node-a'], 'task')!.firstLine).toBe('接收订单');
    expect(nodeTip(dto.nodes['node-b'], 'task')!.firstLine).toBe('代码审查');
    expect(nodeTip(dto.nodes['node-c'], 'task')!.firstLine).toBe('终审');
  });
});

// ── Graph Slip task identity + running profile from the activity snapshot ──
// The snapshot node carries both the Foreman task definition name (task_id)
// and the runtime instance id (task_run_id). The tip's 任务 ID row shows
// exactly the definition name; a legacy node without task_id omits the row.
// A resolved profile renders for a running node — no completion gate.

describe('Graph Slip task identity and running profile projection', () => {
  const structure: TaskGraphInspectResult = {
    graph: {
      id: 'tg-1',
      revision: 1,
      nodes: {
        'node-deploy': { id: 'node-deploy', name: '部署', action: { type: 'task' }, deps: [] },
        'node-legacy': { id: 'node-legacy', action: { type: 'task' }, deps: [] },
      },
    },
  };

  function projectWith(nodes: unknown[]): GraphSlipSnapshotDto {
    const normalized = normalizeActivitySnapshotV1(snapshot({
      tasks: [],
      taskgraphs: [taskgraph({ nodes })],
    }));
    const presence = deriveActivityPresence(normalized, false);
    const graph = presence.taskgraphs[0];
    if (!graph) throw new Error('expected a taskgraph presence');
    return projectGraphSlipFromActivity(structure, graph);
  }

  it('[task_id] shows the Foreman task definition name in the 任务 ID row and never the runtime instance id', () => {
    const dto = projectWith([
      node({ node_id: 'node-deploy', task_run_id: 'task_x', task_id: 'forge-deploy' }),
    ]);
    expect(dto.nodes['node-deploy'].task_id).toBe('forge-deploy');
    expect(dto.nodes['node-deploy'].task_run_id).toBe('task_x');
    const tip = nodeTip(dto.nodes['node-deploy'], 'task')!;
    expect(tip.rows.find((r) => r.label === '任务 ID')!.value).toBe('forge-deploy');
    // task_x is the runtime instance id and is never exposed as 任务 ID.
    expect(tip.rows.some((r) => r.value === 'task_x')).toBe(false);
    expect(JSON.stringify(tip)).not.toContain('task_x');
  });

  it('[legacy] omits the 任务 ID row entirely when the node lacks task_id', () => {
    const dto = projectWith([
      node({ node_id: 'node-legacy', task_run_id: 'task_x' }),
    ]);
    expect(dto.nodes['node-legacy'].task_id).toBeUndefined();
    const tip = nodeTip(dto.nodes['node-legacy'], 'task')!;
    expect(tip.rows.some((r) => r.label === '任务 ID')).toBe(false);
    expect(tip.rows.map((r) => r.label)).toEqual(['状态']);
    expect(JSON.stringify(tip)).not.toContain('task_x');
  });

  it('[running_profile] renders 运行配置 for a running task node as soon as the snapshot provides resolved_profile', () => {
    const dto = projectWith([
      node({
        node_id: 'node-deploy',
        task_run_id: 'task_x',
        task_id: 'forge-deploy',
        resolved_profile: 'codex-spark',
      }),
    ]);
    expect(dto.nodes['node-deploy'].profile).toBe('codex-spark');
    const tip = nodeTip(dto.nodes['node-deploy'], 'task')!;
    expect(tip.rows.find((r) => r.label === '运行配置')!.value).toBe('codex-spark');
    // Running state is not a blocker — no completion gate around the profile.
    expect(dto.nodes['node-deploy'].state).toBe('running');
    expect(tip.firstLine).toBe('部署');
  });
});

// ── Tracked terminal graph ids ───────────────────────────────────────

describe('normalizeTrackedTaskgraphIds', () => {
  it('deduplicates, drops non-strings, and bounds at 128', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `tg-${i}`);
    const result = normalizeTrackedTaskgraphIds(['a', 'a', 'b', 42, undefined, ...ids]);
    expect(result).toHaveLength(128);
    expect(new Set(result).size).toBe(result.length);
    expect(result[0]).toBe('a');
    expect(result).toContain('b');
  });
});

// ── Content-free failure classification (poller owns the closed class) ─
// The unique poller reduces every thrown round to a closed failure_class on
// the logger — raw error name/message, tokens and hostile proxies never leak.

describe('ActivitySnapshotPoller content-free failure classification', () => {
  interface ThrowCase {
    name: string;
    expectedClass: string;
    make: () => { value: unknown; traps: () => number };
    expectedProbes?: number;
  }

  const throwCases: ThrowCase[] = [
    { name: 'null', expectedClass: 'non_error_null', make: () => ({ value: null, traps: () => 0 }) },
    { name: 'undefined', expectedClass: 'non_error_undefined', make: () => ({ value: undefined, traps: () => 0 }) },
    { name: 'number', expectedClass: 'non_error_number', make: () => ({ value: 42, traps: () => 0 }) },
    { name: 'boolean', expectedClass: 'non_error_boolean', make: () => ({ value: true, traps: () => 0 }) },
    { name: 'bigint', expectedClass: 'non_error_bigint', make: () => ({ value: 9007199254740993n, traps: () => 0 }) },
    { name: 'symbol', expectedClass: 'non_error_symbol', make: () => ({ value: Symbol('symbol-secret'), traps: () => 0 }) },
    { name: 'function', expectedClass: 'non_error_function', make: () => ({ value: function hostileFunction(): void {}, traps: () => 0 }) },
    {
      name: 'long secret string',
      expectedClass: 'non_error_string',
      make: () => ({ value: `daemon exploded ${'S3CRET-'.repeat(50)}`, traps: () => 0 }),
    },
    {
      name: 'nested object/token payload',
      expectedClass: 'non_error_object',
      make: () => ({ value: { untrusted: 'raw-snapshot-secret', nested: { token: 'leak-me' } }, traps: () => 0 }),
    },
    {
      name: 'hostile Proxy (get trap throws)',
      expectedClass: 'non_error_object',
      make: () => {
        const counter = { traps: 0 };
        return {
          value: new Proxy({}, {
            get() {
              counter.traps++;
              throw new Error('PROXY-LEAK');
            },
          }),
          traps: () => counter.traps,
        };
      },
    },
    {
      name: 'hostile Proxy (getPrototypeOf trap throws)',
      expectedClass: 'non_error_object',
      expectedProbes: 1,
      make: () => {
        const counter = { traps: 0 };
        return {
          value: new Proxy({}, {
            getPrototypeOf() {
              counter.traps++;
              throw new Error('PROTO-LEAK');
            },
          }),
          traps: () => counter.traps,
        };
      },
    },
    {
      name: 'coercion bomb (toString/valueOf throw)',
      expectedClass: 'non_error_object',
      make: () => {
        const counter = { traps: 0 };
        return {
          value: {
            toString() {
              counter.traps++;
              throw new Error('COERCION-LEAK');
            },
            valueOf() {
              counter.traps++;
              throw new Error('COERCION-LEAK');
            },
          },
          traps: () => counter.traps,
        };
      },
    },
  ];

  const SECRET_FRAGMENTS = [
    'S3CRET',
    'raw-snapshot-secret',
    'leak-me',
    'PROXY-LEAK',
    'PROTO-LEAK',
    'COERCION-LEAK',
    'hostileFunction',
    'symbol-secret',
    'top-secret-message',
  ];

  it.each(throwCases.map((tc) => [tc.name, tc]))(
    'classifies a thrown %s into a closed { failureClass } record without leaking',
    async (_name, tc: ThrowCase) => {
      const logger: DiagnosticLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), path: null };
      const { value, traps } = tc.make();
      const poller = new ActivitySnapshotPoller({
        request: async () => {
          throw value;
        },
        logger,
        onPresence: () => undefined,
      });

      await poller.pollOnce();

      const failureCalls = logger.warn.mock.calls.filter((c: any[]) => c[0] === 'foreman_activity_poll_failed');
      expect(failureCalls.length).toBeGreaterThan(0);
      for (const call of failureCalls) {
        expect(call[1]).toEqual({ failureClass: tc.expectedClass });
      }
      const diagnosticsJson = JSON.stringify(logger.warn.mock.calls);
      for (const fragment of SECRET_FRAGMENTS) {
        expect(diagnosticsJson, fragment).not.toContain(fragment);
      }
      expect(traps()).toBe(tc.expectedProbes ?? 0);
    },
  );

  it('logs an Error class only as { failureClass: "error" } without the secret name/message', async () => {
    const logger: DiagnosticLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), path: null };
    const secret = Object.assign(new Error('top-secret-message'), { name: 'top-secret-name' });
    const poller = new ActivitySnapshotPoller({
      request: async () => {
        throw secret;
      },
      logger,
      onPresence: () => undefined,
    });

    await poller.pollOnce();

    const failureCalls = logger.warn.mock.calls.filter((c: any[]) => c[0] === 'foreman_activity_poll_failed');
    expect(failureCalls.length).toBeGreaterThan(0);
    for (const call of failureCalls) {
      expect(call.length).toBe(2);
      expect(call[1]).toEqual({ failureClass: 'error' });
    }
    const diagnosticsJson = JSON.stringify(logger.warn.mock.calls);
    expect(diagnosticsJson).not.toContain('top-secret-message');
    expect(diagnosticsJson).not.toContain('top-secret-name');
  });
});
