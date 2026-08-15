import { describe, expect, it } from 'vitest';
import {
  ActivityNotificationQueue,
  NOTIFICATION_DURATION_MS,
  buildColdStartSummary,
  detectGraphTransitions,
  transitionTextZh,
  type GraphTransition,
} from '../src/main/activity-notifications';
import type { ActivityPresence, ActivityTaskGraphPresence } from '../src/shared/activity-snapshot';

// ── Presence factories ────────────────────────────────────────────────

function graphPresence(
  id: string,
  state: ActivityTaskGraphPresence['state'],
  overrides: Partial<ActivityTaskGraphPresence> = {},
): ActivityTaskGraphPresence {
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
      failed: state === 'paused' ? 1 : 0,
      interrupted: 0,
      cancelled: 0,
    },
    active: { running: state === 'running' ? ['n1'] : [], waiting: [] },
    nodes: [],
    ...overrides,
  };
}

function presence(taskgraphs: ActivityTaskGraphPresence[], tasks: ActivityPresence['tasks'] = []): ActivityPresence {
  return { sampledAt: '2025-01-01T00:00:00.000Z', stale: false, tasks, taskgraphs };
}

function runningTask(id: string): ActivityPresence['tasks'][number] {
  return { taskRunId: id, status: 'running' };
}

function queuedTask(id: string): ActivityPresence['tasks'][number] {
  return { taskRunId: id, status: 'queued' };
}

function makeQueue(nowMs = 10000): ActivityNotificationQueue {
  return new ActivityNotificationQueue({ now: () => nowMs });
}

// ── Pure transition detection ─────────────────────────────────────────

describe('detectGraphTransitions', () => {
  it('detects every notification boundary for one graph', () => {
    const seq = (n: number) => ({ latestSeq: n });
    // created → running
    let prev = presence([graphPresence('tg-a', 'created', seq(1))]);
    let next = presence([graphPresence('tg-a', 'running', seq(1))]);
    let transitions = detectGraphTransitions(prev, next);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe('started');
    // running → paused with failed node
    prev = next;
    next = presence([graphPresence('tg-a', 'paused')]);
    transitions = detectGraphTransitions(prev, next);
    expect(transitions[0].kind).toBe('error_paused');
    // paused → running
    prev = next;
    next = presence([graphPresence('tg-a', 'running')]);
    transitions = detectGraphTransitions(prev, next);
    expect(transitions[0].kind).toBe('resumed');
    // running → done
    prev = next;
    next = presence([graphPresence('tg-a', 'done')]);
    transitions = detectGraphTransitions(prev, next);
    expect(transitions[0].kind).toBe('completed');
  });

  it('emits created for a brand-new non-terminal graph and nothing for an already-terminal one', () => {
    const prev = presence([graphPresence('tg-a', 'running')]);
    const created = detectGraphTransitions(prev, presence([graphPresence('tg-a', 'running'), graphPresence('tg-b', 'created')]));
    expect(created.map((t) => t.kind)).toEqual(['created']);
    // A terminal graph first appearing is a cold-start replay — never notified.
    const replay = detectGraphTransitions(prev, presence([graphPresence('tg-a', 'running'), graphPresence('tg-b', 'done')]));
    expect(replay).toEqual([]);
  });

  it('distinguishes cancelled exit reasons', () => {
    const prev = presence([graphPresence('tg-a', 'running')]);
    const exit = detectGraphTransitions(prev, presence([graphPresence('tg-a', 'cancelled', { terminalReason: 'node_failed' })]));
    expect(exit[0].kind).toBe('error_exit');
    const cancel = detectGraphTransitions(prev, presence([graphPresence('tg-a', 'cancelled', { terminalReason: 'cancelled' })]));
    expect(cancel[0].kind).toBe('cancelled');
  });
});

describe('transitionTextZh / buildColdStartSummary', () => {
  it('produces the Chinese notification text with title fallback', () => {
    const base = (kind: GraphTransition['kind'], title?: string): GraphTransition => ({
      taskgraphId: 'tg-a', fromState: 'running', toState: 'done', latestSeq: 1, kind, title,
    });
    expect(transitionTextZh(base('created'))).toBe('图纸已创建：未命名任务图');
    expect(transitionTextZh(base('started', '演示图'))).toBe('图纸已启动：演示图');
    expect(transitionTextZh(base('completed', '演示图'))).toBe('图纸已完成：演示图');
    expect(transitionTextZh(base('error_paused', '演示图'))).toBe('图纸遇到错误，已暂停：演示图');
    expect(transitionTextZh(base('resumed', '演示图'))).toBe('图纸已恢复：演示图');
    expect(transitionTextZh(base('error_exit', '演示图'))).toBe('图纸因错误退出：演示图');
    expect(transitionTextZh(base('cancelled', '演示图'))).toBe('图纸已取消：演示图');
  });

  it('[cold-start-notification] first snapshot builds one recovery summary and no history replay', () => {
    expect(buildColdStartSummary(presence([graphPresence('tg-a', 'running')], [runningTask('r1'), runningTask('r2'), queuedTask('q1')])))
      .toBe('已恢复：2 个任务运行中 · 1 个排队 · 1 张图纸');
    expect(buildColdStartSummary(presence([], []))).toBeNull();
  });
});

// ── Bounded serial queue + sticky error semantics ─────────────────────

describe('ActivityNotificationQueue', () => {
  it('cold start emits exactly one recovery summary card and no transitions', () => {
    const q = makeQueue();
    const card = q.applyPresence(presence([graphPresence('tg-a', 'running')], [runningTask('r1')]));
    expect(card).not.toBeNull();
    expect(card!.text).toBe('已恢复：1 个任务运行中 · 1 张图纸');
    expect(card!.intensity).toBe('transient');
    expect(card!.untilMs).toBe(10000 + NOTIFICATION_DURATION_MS);
  });

  it('cold start with nothing active shows no card', () => {
    const q = makeQueue();
    expect(q.applyPresence(presence([], []))).toBeNull();
  });

  it('a new graph after cold start emits 图纸已创建', () => {
    const q = makeQueue();
    q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    q.dismiss(q.getCurrent()!.id); // clear the recovery summary slot
    const card = q.applyPresence(presence([graphPresence('tg-a', 'running'), graphPresence('tg-b', 'created')]));
    expect(card?.text).toBe('图纸已创建：未命名任务图');
  });

  it('[notifications] created→running emits 图纸已启动 once (dedup by graph/from/to/latest_seq)', () => {
    const q = makeQueue();
    q.applyPresence(presence([graphPresence('tg-a', 'created')]));
    q.dismiss(q.getCurrent()!.id); // clear the recovery summary slot
    const started = q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    expect(started?.text).toBe('图纸已启动：未命名任务图');
    // Identical transition with the same latest_seq is not re-emitted.
    const again = q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    expect(again).toBeNull();
  });

  it('first error pause is a sticky card that survives polls; resume revokes it and emits 图纸已恢复', () => {
    const q = makeQueue();
    q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    q.dismiss(q.getCurrent()!.id); // clear the recovery summary slot
    const paused = q.applyPresence(presence([graphPresence('tg-a', 'paused')]));
    expect(paused).not.toBeNull();
    expect(paused!.intensity).toBe('sticky');
    expect(paused!.text).toBe('图纸遇到错误，已暂停：未命名任务图');
    // While still error-paused the same card stays; nothing re-emits.
    expect(q.applyPresence(presence([graphPresence('tg-a', 'paused')]))).toBeNull();
    // Resume revokes the sticky and shows the recovery transition.
    const resumed = q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    expect(resumed?.text).toBe('图纸已恢复：未命名任务图');
    expect(resumed!.intensity).toBe('transient');
  });

  it('terminal revokes the sticky error and emits the completion card', () => {
    const q = makeQueue();
    q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    q.dismiss(q.getCurrent()!.id);
    q.applyPresence(presence([graphPresence('tg-a', 'paused')]));
    const done = q.applyPresence(presence([graphPresence('tg-a', 'done')]));
    expect(done?.text).toBe('图纸已完成：未命名任务图');
  });

  it('serial display: a later transition queues behind the current transient card', () => {
    const q = makeQueue();
    q.applyPresence(presence([graphPresence('tg-a', 'created')]));
    // The recovery summary occupies the slot; the started card queues behind.
    q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    // Second transition while a card is shown queues (returns null).
    const queued = q.applyPresence(presence([graphPresence('tg-a', 'running'), graphPresence('tg-b', 'created')]));
    expect(queued).toBeNull();
    expect(q.getPendingCount()).toBe(2);
    // Expiry of the transient current card promotes the next one.
    const next = q.advanceAfterExpiry();
    expect(next?.text).toBe('图纸已启动：未命名任务图');
  });

  it('bounded: the queue never grows beyond the fixed cap and drops the oldest pending card', () => {
    const q = makeQueue();
    q.applyPresence(presence([graphPresence('tg-a', 'created')]));
    // Fill the current slot.
    q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    // Flood with new graphs; the queue stays capped.
    for (let i = 0; i < 10; i++) {
      q.applyPresence(presence([graphPresence('tg-a', 'running'), graphPresence(`tg-${i}`, 'created')]));
    }
    expect(q.getPendingCount()).toBeLessThanOrEqual(5);
  });

  it('dismiss promotes the next queued card; sticky can be dismissed too', () => {
    const q = makeQueue();
    q.applyPresence(presence([graphPresence('tg-a', 'created')]));
    q.applyPresence(presence([graphPresence('tg-a', 'running')]));
    q.applyPresence(presence([graphPresence('tg-a', 'running'), graphPresence('tg-b', 'created')]));
    const current = q.getCurrent();
    const next = q.dismiss(current!.id);
    expect(next).not.toBeNull();
  });
});
