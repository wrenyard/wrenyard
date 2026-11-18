import { describe, expect, it } from 'vitest';

import {
  LiveStreamHub,
  ManagedSession,
  PendingSendLatch,
  RecoveryWaitLatch,
  SessionInbox,
  TurnRecord,
  type SessionEventBase,
} from '../src/index.ts';
import { createMemoryPersistence } from './memory-persistence.ts';

// Source: 2026-11-18-session-module-architecture.md
describe('SessionInbox', () => {
  it('enqueues, peeks, drains FIFO per mode, and selectively clears on interrupt', () => {
    const inbox = new SessionInbox<string>();
    const t0 = new Date('2026-11-18T00:00:00Z');

    inbox.enqueue('steer', 's1', 'adjust', t0);
    inbox.enqueue('inject', 'i1', 'note', t0);
    inbox.enqueue('followup', 'f1', 'next', t0);
    inbox.enqueue('steer', 's2', 'adjust-2', t0);

    expect(inbox.has('steer')).toBe(true);
    expect(inbox.peek('steer').map((e) => e.input)).toEqual(['adjust', 'adjust-2']);
    expect(inbox.drain('steer').map((e) => e.input)).toEqual(['adjust', 'adjust-2']);
    expect(inbox.has('steer')).toBe(false);

    inbox.enqueue('steer', 's3', 'again', t0);
    inbox.clearOnInterrupt(true);
    expect(inbox.has('steer')).toBe(false);
    expect(inbox.has('inject')).toBe(false);
    expect(inbox.has('followup')).toBe(true);

    inbox.clearOnInterrupt(false);
    expect(inbox.has()).toBe(false);
  });
});

describe('PendingSendLatch and RecoveryWaitLatch', () => {
  it('deduplicates same-tick identical sends and cleans up on settlement', async () => {
    const latch = new PendingSendLatch<number>();
    let runs = 0;

    const p1 = latch.run('k1', async () => {
      runs += 1;
      await Promise.resolve();
      return 42;
    });
    const p2 = latch.run('k1', async () => {
      runs += 1;
      return 99;
    });
    const p3 = latch.run('k2', async () => {
      runs += 1;
      return 7;
    });

    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(await Promise.all([p1, p2, p3])).toEqual([42, 42, 7]);
    expect(runs).toBe(2);
    expect(latch.size).toBe(0);
  });

  it('fences RecoveryWaitLatch clear by owning turn number', () => {
    const wait = new RecoveryWaitLatch();
    wait.set(2, 'openai/gpt-4o:high');

    expect(wait.matches('openai/gpt-4o:high')).toEqual({ turn: 2, key: 'openai/gpt-4o:high' });
    expect(wait.clear(1)).toBe(false);
    expect(wait.current).toEqual({ turn: 2, key: 'openai/gpt-4o:high' });

    expect(wait.clear(2)).toBe(true);
    expect(wait.current).toBeUndefined();
  });
});

describe('LiveStreamHub', () => {
  it('publishes live frames, ignores empty deltas, and isolates failing listeners', () => {
    const hub = new LiveStreamHub();
    const snapshots: Array<Array<{ spanId: string; text: string; reasoning: string }>> = [];

    const unsub = hub.subscribe('s1', (frames) => {
      snapshots.push(frames);
    });
    hub.subscribe('s1', () => {
      throw new Error('broken ui listener');
    });

    hub.begin('s1', 'span-1');
    hub.append('s1', 'span-1', 'reasoning', 'think ');
    hub.append('s1', 'span-1', 'text', '');
    hub.append('s1', 'span-1', 'text', 'hello');
    expect(hub.read('s1')).toEqual([{ spanId: 'span-1', text: 'hello', reasoning: 'think ' }]);

    hub.end('s1', 'span-1');
    expect(hub.read('s1')).toEqual([]);
    expect(snapshots).toHaveLength(4);

    unsub();
    hub.clear();
  });
});

describe('ManagedSession and TurnRecord', () => {
  it('tracks turn lifecycle, late work, status, quiescence, and sub-sessions', async () => {
    const persistence = createMemoryPersistence<SessionEventBase>();
    const handle = await persistence.create('s-runtime');
    const session = new ManagedSession({ sessionId: 's-runtime', handle });

    expect(session.status).toBe('idle');
    expect(session.isQuiescent()).toBe(true);

    const turn = session.createTurn(1, { text: 'hello' });
    expect(session.status).toBe('running');
    expect(session.hasRunningTurns()).toBe(true);
    expect(session.activeTurnCount()).toBe(1);
    expect(session.isQuiescent()).toBe(false);

    session.recoveryWait.set(1, 'key-1');
    expect(session.status).toBe('waiting');

    let resolveLate!: () => void;
    const latePromise = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    void turn.trackWork(latePromise);
    expect(turn.lateWorkCount).toBe(1);

    session.markTurnDurableTerminal(1, 'completed');
    expect(session.status).toBe('idle');
    expect(session.hasRunningTurns()).toBe(false);
    // Still non-quiescent while lateWork is in flight.
    expect(session.isQuiescent()).toBe(false);

    let idleResolved = false;
    const idleWait = session.whenIdle().then(() => {
      idleResolved = true;
    });
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    resolveLate();
    await idleWait;
    expect(idleResolved).toBe(true);
    expect(session.isQuiescent()).toBe(true);

    const subResult = await session.spawnSubSession(
      { parentEventId: 'e1', input: 'sub-task' },
      async (subSessionId, signal) => {
        expect(subSessionId).toBe('s-runtime__sub_1');
        expect(signal.aborted).toBe(false);
        return 'ok';
      },
    );
    expect(subResult).toBe('ok');

    await session.close();
    await persistence.close();
  });
});

describe('TurnRecord standalone', () => {
  it('resolves whenIdle only after durableTerminal and tracked work settle', async () => {
    const record = new TurnRecord(1, 'input');
    let release!: () => void;
    void record.trackWork(new Promise<void>((resolve) => {
      release = resolve;
    }));
    record.markDurableTerminal('completed');
    let settled = false;
    const p = record.whenIdle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await p;
    expect(settled).toBe(true);
  });
});
