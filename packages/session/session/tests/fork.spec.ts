import { describe, expect, it } from 'vitest';

import {
  buildForkSeed,
  repairInterruptedTail,
  type SessionEventBase,
} from '../src/index.ts';

// Source: 2026-11-18-session-module-architecture.md
interface ForkTestEvent extends SessionEventBase {
  kind?: string;
  action?: { type: string };
  request?: { taskRunId?: string };
  status?: string;
  reason?: string;
  result?: string;
  afterInterrupt?: boolean;
  text?: string;
}

describe('repairInterruptedTail', () => {
  it('closes dangling spans, actions, steps, and turns in child-first order and collects task run ids', () => {
    const events: ForkTestEvent[] = [
      { seq: 1, at: '2026-11-18T00:00:00Z', type: 'session.created' },
      { seq: 2, at: '2026-11-18T00:00:01Z', type: 'turn.started', turn: 1, id: 't1', text: 'done' },
      { seq: 3, at: '2026-11-18T00:00:02Z', type: 'turn.finished', turn: 1, id: 't1', status: 'completed' },
      { seq: 4, at: '2026-11-18T00:00:03Z', type: 'turn.started', turn: 2, id: 't2', text: 'crashed' },
      { seq: 5, at: '2026-11-18T00:00:04Z', type: 'step.started', turn: 2, step: 1, id: 't2.1', parent: 't2' },
      { seq: 6, at: '2026-11-18T00:00:05Z', type: 'action.started', turn: 2, step: 1, id: 'a1', parent: 't2.1', action: { type: 'dispatch' } },
      // Repeated action.started id must only be closed once.
      { seq: 7, at: '2026-11-18T00:00:06Z', type: 'action.started', turn: 2, step: 1, id: 'a1', parent: 't2.1', action: { type: 'dispatch' } },
      {
        seq: 8,
        at: '2026-11-18T00:00:07Z',
        type: 'span.started',
        turn: 2,
        step: 1,
        id: 's2.1',
        parent: 'a1',
        kind: 'task',
        request: { taskRunId: 'run-42' },
      },
      {
        seq: 9,
        at: '2026-11-18T00:00:08Z',
        type: 'span.started',
        turn: 2,
        step: 1,
        id: 's2.2',
        parent: 't2.1',
        kind: 'reasoning',
      },
      { seq: 10, at: '2026-11-18T00:00:09Z', type: 'span.finished', turn: 2, step: 1, id: 's2.2', status: 'ok' },
    ];

    const repaired = repairInterruptedTail(events, { reason: 'shutdown' });
    expect(repaired.plans).toEqual([
      {
        turn: 2,
        turnId: 't2',
        danglingSpanIds: ['s2.1'],
        danglingActionIds: ['a1'],
        danglingStepIds: ['t2.1'],
        danglingTaskRunIds: ['run-42'],
      },
    ]);

    expect(repaired.drafts.map((draft) => `${draft.type}:${draft.id ?? draft.parent ?? ''}`)).toEqual([
      'span.finished:s2.1',
      'action.finished:a1',
      'step.finished:t2.1',
      'turn.interrupted:t2',
      'turn.finished:t2',
    ]);
    expect((repaired.drafts[1] as unknown as ForkTestEvent).afterInterrupt).toBe(true);
    expect((repaired.drafts[3] as unknown as ForkTestEvent).reason).toBe('shutdown');
  });
});

describe('buildForkSeed', () => {
  it('slices up to upToSeq and appends fork closers without mutating source events', () => {
    const events: ForkTestEvent[] = [
      { seq: 1, at: '2026-11-18T00:00:00Z', type: 'session.created' },
      { seq: 2, at: '2026-11-18T00:00:01Z', type: 'turn.started', turn: 1, id: 't1', text: 'first' },
      { seq: 3, at: '2026-11-18T00:00:02Z', type: 'step.started', turn: 1, step: 1, id: 't1.1', parent: 't1' },
      { seq: 4, at: '2026-11-18T00:00:03Z', type: 'step.finished', turn: 1, step: 1, id: 't1.1', status: 'done' },
      { seq: 5, at: '2026-11-18T00:00:04Z', type: 'turn.finished', turn: 1, id: 't1', status: 'completed' },
    ];

    const fork = buildForkSeed(events, 3);
    expect(fork.inheritedSeq).toBe(3);
    expect(fork.prefix.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(fork.closers.map((d) => d.type)).toEqual([
      'step.finished',
      'turn.interrupted',
      'turn.finished',
    ]);
    expect((fork.closers[1] as unknown as ForkTestEvent).reason).toBe('fork');
    expect(fork.seed).toHaveLength(6);
    expect(events).toHaveLength(5);
  });
});
