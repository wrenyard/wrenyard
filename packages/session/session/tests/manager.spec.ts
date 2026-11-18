import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SessionBusyError,
  SessionManager,
  SessionNotFoundError,
  createSessionManager,
  type SessionEventBase,
  type SessionEventDraft,
  type SessionSummaryBase,
} from '../src/index.ts';
import { createMemoryPersistence } from './memory-persistence.ts';
import { runSessionPersistenceContract } from './persistence-contract.ts';
import { ScriptedDriver } from './scripted-driver.ts';

// Source: 2026-11-18-session-module-architecture.md
runSessionPersistenceContract('MemorySessionPersistence', (options) => ({
  persistence: createMemoryPersistence(options),
}));

describe('SessionManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers interrupted tails on ensureSession and deduplicates concurrent ensureSession calls', async () => {
    const persistence = createMemoryPersistence<SessionEventBase>();
    const handle = await persistence.create('s-recover', [
      { type: 'session.created' },
      { type: 'turn.started', turn: 1, id: 't1' },
      {
        type: 'span.started',
        turn: 1,
        step: 1,
        id: 's1.1',
        parent: 't1.1',
        kind: 'task',
        request: { taskRunId: 'orphan-run-1' },
      } as unknown as SessionEventDraft<SessionEventBase>,
    ]);
    await handle.close();

    const driver = new ScriptedDriver<SessionEventBase, { text: string }>();
    const recoverCalls: string[] = [];
    const manager = createSessionManager({
      persistence,
      driver,
      onRecover: async ({ sessionId, repair }) => {
        recoverCalls.push(`${sessionId}:${repair.danglingTaskRunIds.join(',')}`);
      },
    });

    const [r1, r2] = await Promise.all([
      manager.ensureSession('s-recover'),
      manager.ensureSession('s-recover'),
    ]);

    expect(r1).toBe(r2);
    expect(recoverCalls).toEqual(['s-recover:orphan-run-1']);
    expect(driver.recovered).toHaveLength(1);
    expect(driver.recovered[0]!.repair.danglingTaskRunIds).toEqual(['orphan-run-1']);
    expect(r1.read().some((e) => e.type === 'turn.finished' && e.turn === 1)).toBe(true);
    expect(r1.nextTurn).toBe(2);

    await manager.close();
  });

  it('coalesces same-tick sendTurn via PendingSendLatch and RecoveryWaitLatch', async () => {
    let releaseTurn!: () => void;
    const driver = new ScriptedDriver<SessionEventBase, { text: string }>({
      onTurn: async (ctx) => {
        if (ctx.turn === 1) {
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        }
      },
    });
    const manager = createSessionManager<SessionEventBase, SessionSummaryBase, { text: string }>({ driver });
    const runtime = await manager.createSession('s-latch');

    const [first, second] = await Promise.all([
      manager.sendTurn('s-latch', { text: 'go' }, { dedupKey: 'go:model-a' }),
      manager.sendTurn('s-latch', { text: 'go' }, { dedupKey: 'go:model-a' }),
    ]);

    expect(first).toEqual({ turn: 1 });
    expect(second).toEqual({ turn: 1 });
    expect(driver.turnCalls).toHaveLength(1);

    runtime.recoveryWait.set(1, 'model-a:continue');
    const repeated = await manager.sendTurn(
      's-latch',
      { text: 'continue' },
      { recoveryKey: 'model-a:continue' },
    );
    expect(repeated).toEqual({ turn: 1 });
    expect(driver.turnCalls).toHaveLength(1);

    releaseTurn();
    await runtime.whenIdle();
    await manager.close();
  });

  it('supports steer, inject, forkSession, and cross-manager peerGroup interrupts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous manager peer group
    const peerGroup = new Set<SessionManager<any, any, any, any>>();
    let turnStarted!: () => void;
    const turnStartedPromise = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });

    const driverA = new ScriptedDriver<SessionEventBase, { text: string }>({
      onTurn: async (ctx) => {
        turnStarted();
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const managerA = createSessionManager({ driver: driverA, peerGroup });
    const managerB = createSessionManager({ peerGroup });

    const runtimeA = await managerA.createSession('s-peer', [{ type: 'session.created' }]);
    const sent = await managerA.sendTurn('s-peer', { text: 'work' });
    await turnStartedPromise;

    const steered = await managerA.steer('s-peer', { text: 'refine' });
    const injected = await managerA.inject('s-peer', { text: 'hint' });
    expect(steered).toEqual({ turn: 1 });
    expect(injected).toEqual({ turn: 1 });
    expect(runtimeA.inbox.peek('steer')).toHaveLength(1);
    expect(runtimeA.inbox.peek('inject')).toHaveLength(1);

    // Interrupt originating on managerB routes across peerGroup to managerA.
    await managerB.interruptTurn('s-peer', sent.turn, 'user');
    await runtimeA.whenIdle();

    expect(driverA.interrupted).toEqual([{ sessionId: 's-peer', turn: 1, reason: 'user' }]);
    expect(runtimeA.read().some((e) => e.type === 'turn.interrupted')).toBe(true);
    expect(runtimeA.read().some((e) => e.type === 'turn.finished')).toBe(true);

    const forked = await managerA.forkSession('s-peer', 's-fork', 2);
    expect(forked.read().map((e) => e.type)).toEqual([
      'session.created',
      'turn.started',
      'turn.interrupted',
      'turn.finished',
    ]);

    await managerB.close();
    await managerA.close();
  });

  it('guards deleteSession against running turns and evicts idle runtimes cleanly', async () => {
    vi.useFakeTimers();
    let nowMs = 1_000_000;
    const now = (): Date => new Date(nowMs);

    let finishTurn!: () => void;
    const driver = new ScriptedDriver<SessionEventBase, { text: string }>({
      onTurn: async () => {
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
      },
    });
    const manager = createSessionManager({
      driver,
      now,
      idleTimeoutMs: 10_000,
      sweepIntervalMs: 5_000,
    });

    const runtime = await manager.createSession('s-idle');
    await manager.sendTurn('s-idle', { text: 'active' });

    await expect(manager.deleteSession('s-idle')).rejects.toThrow(SessionBusyError);

    finishTurn();
    await runtime.whenIdle();
    expect(runtime.isQuiescent()).toBe(true);

    // First sweep stamps idleSince; advancing past idleTimeoutMs evicts and closes handle.
    await manager.sweepIdleSessions();
    expect(manager.getRuntime('s-idle')).toBeDefined();

    nowMs += 11_000;
    await manager.sweepIdleSessions();
    expect(manager.getRuntime('s-idle')).toBeUndefined();

    // Evicted single-writer handle can be cleanly reopened.
    const reopened = await manager.ensureSession('s-idle');
    expect(reopened).not.toBe(runtime);

    await manager.deleteSession('s-idle');
    await expect(manager.ensureSession('s-idle')).rejects.toThrow(SessionNotFoundError);

    await manager.close();
  });

  it('syncs out-of-band persistence appends into resident timelines and unsubscribes on close', async () => {
    vi.useFakeTimers();
    let nowMs = 1_000_000;
    const persistence = createMemoryPersistence<SessionEventBase>();
    let unsubCalls = 0;
    const origSubscribe = persistence.subscribe.bind(persistence);
    persistence.subscribe = (sessionId, listener) => {
      const unsub = origSubscribe(sessionId, listener);
      return () => {
        unsubCalls += 1;
        unsub();
      };
    };

    const manager = createSessionManager({
      persistence,
      now: () => new Date(nowMs),
      idleTimeoutMs: 5_000,
      sweepIntervalMs: 5_000,
    });
    const runtime = await manager.createSession('s-sync', [{ type: 'session.created' }]);

    await persistence.appendFromHandle('s-sync', {
      type: 'external.note',
      text: 'out-of-band',
    } as unknown as SessionEventDraft<SessionEventBase>);
    expect(runtime.read().map((e) => e.type)).toEqual(['session.created', 'external.note']);
    expect(runtime.timeline.lastSeq).toBe(2);

    // Idle eviction unsubscribes the evicted runtime cleanly.
    await manager.sweepIdleSessions();
    nowMs += 6_000;
    await manager.sweepIdleSessions();
    expect(unsubCalls).toBe(1);

    // Recovery re-subscribes and tracks subsequent out-of-band appends.
    const recovered = await manager.ensureSession('s-sync');
    await persistence.appendFromHandle('s-sync', {
      type: 'external.note',
      text: 'after-recover',
    } as unknown as SessionEventDraft<SessionEventBase>);
    expect(recovered.read().map((e) => e.type)).toEqual([
      'session.created',
      'external.note',
      'external.note',
    ]);
    await manager.deleteSession('s-sync');
    expect(unsubCalls).toBe(2);

    await manager.createSession('s-close', [{ type: 'session.created' }]);
    await manager.close();
    expect(unsubCalls).toBe(3);
  });

  it('blocks concurrent deleteSession while withAdmission is held', async () => {
    const manager = createSessionManager();
    await manager.createSession('s-admit', [{ type: 'session.created' }]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inside!: () => void;
    const entered = new Promise<void>((resolve) => {
      inside = resolve;
    });

    const admission = manager.withAdmission('s-admit', async () => {
      inside();
      await gate;
      return 'done';
    });

    await entered;
    await expect(manager.deleteSession('s-admit')).rejects.toThrow(SessionBusyError);

    release();
    await expect(admission).resolves.toBe('done');
    await manager.deleteSession('s-admit');
    await expect(manager.ensureSession('s-admit')).rejects.toThrow(SessionNotFoundError);
    await manager.close();
  });

  it('awaits onTurnAdmitted after startDraft and before executeTurn launches', async () => {
    const order: string[] = [];
    const driver = new ScriptedDriver<SessionEventBase, { text: string }>({
      onTurn: async (ctx) => {
        order.push(`driver:${ctx.read().map((e) => e.type).join(',')}`);
      },
    });
    const manager = createSessionManager({ driver });
    const runtime = await manager.createSession('s-hook', [{ type: 'session.created' }]);

    await manager.sendTurn(
      's-hook',
      { text: 'hello' },
      {
        onTurnAdmitted: async ({ runtime: rt, turn }) => {
          order.push(`admitted:${turn}:${rt.read().map((e) => e.type).join(',')}`);
          await rt.append({
            type: 'files.attached',
            turn,
            files: ['a.txt'],
          } as unknown as SessionEventDraft<SessionEventBase>);
        },
      },
    );

    await runtime.whenIdle();
    expect(order).toEqual([
      'admitted:1:session.created,turn.started',
      'driver:session.created,turn.started,files.attached',
    ]);

    await manager.close();
  });

  it('runs beforeDelete with read events after handle close and rolls back deletedSessions on failure', async () => {
    const manager = createSessionManager();
    await manager.createSession('s-before-del', [{ type: 'session.created' }]);

    const seen: Array<{ id: string; types: string[] }> = [];
    await expect(
      manager.deleteSession('s-before-del', {
        beforeDelete: async (sessionId, events) => {
          seen.push({ id: sessionId, types: events.map((e) => e.type) });
          throw new Error('cleanup failed');
        },
      }),
    ).rejects.toThrow('cleanup failed');

    expect(seen).toEqual([{ id: 's-before-del', types: ['session.created'] }]);
    expect(manager.getRuntime('s-before-del')).toBeUndefined();

    // Rolling back deletedSessions allows recovery after failed cleanup.
    const recovered = await manager.ensureSession('s-before-del');
    expect(recovered.read().map((e) => e.type)).toEqual(['session.created']);

    await manager.deleteSession('s-before-del', {
      beforeDelete: async (sessionId, events) => {
        seen.push({ id: sessionId, types: events.map((e) => e.type) });
      },
    });
    expect(seen).toHaveLength(2);
    await expect(manager.ensureSession('s-before-del')).rejects.toThrow(SessionNotFoundError);
    await manager.close();
  });

  it('runs driver interruptTurn cleanup and awaits tracked late work even when signal aborts synchronously', async () => {
    let cleanupRan = false;
    let lateResolved = false;
    let releaseLate!: () => void;
    const lateWork = new Promise<void>((resolve) => {
      releaseLate = () => {
        lateResolved = true;
        resolve();
      };
    });

    let enteredDriver!: () => void;
    const inDriver = new Promise<void>((resolve) => {
      enteredDriver = resolve;
    });

    let manager!: SessionManager<SessionEventBase, SessionSummaryBase, { text: string }>;
    const driver = new ScriptedDriver<SessionEventBase, { text: string }>({
      onTurn: async (ctx) => {
        let localFinished = false;
        ctx.signal.addEventListener('abort', () => {
          localFinished = true;
        }, { once: true });
        enteredDriver();
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        expect(localFinished).toBe(true);
      },
      onInterrupt: async ({ sessionId, turn }) => {
        cleanupRan = true;
        const runtime = manager.getRuntime(sessionId);
        const record = runtime?.turns.get(turn);
        record?.trackWork(lateWork.then(async () => {
          await runtime!.append({
            type: 'action.finished',
            turn,
            id: 'a1',
          } as unknown as SessionEventDraft<SessionEventBase>);
        }));
      },
    });

    manager = createSessionManager({ driver });
    const runtime = await manager.createSession('s-int-late', [{ type: 'session.created' }]);
    await manager.sendTurn('s-int-late', { text: 'run' });
    await inDriver;

    let interruptDone = false;
    const interrupting = manager.interruptTurn('s-int-late', 1, 'user').then(() => {
      interruptDone = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(cleanupRan).toBe(true);
    expect(lateResolved).toBe(false);
    expect(interruptDone).toBe(false);
    expect(runtime.read().some((e) => e.type === 'turn.finished')).toBe(false);

    releaseLate();
    await interrupting;
    expect(runtime.read().map((e) => e.type)).toEqual([
      'session.created',
      'turn.started',
      'turn.interrupted',
      'action.finished',
      'turn.finished',
    ]);
    await manager.close();
  });

  it('defers idle eviction while external isQuiescent returns false', async () => {
    let clock = 1_000;
    const busy = new Set<string>(['s-ext-busy']);
    const manager = createSessionManager({
      now: () => new Date(clock),
      idleTimeoutMs: 50,
      sweepIntervalMs: 0,
      isQuiescent: (sessionId) => !busy.has(sessionId),
    });

    await manager.createSession('s-ext-busy', [{ type: 'session.created' }]);

    await manager.sweepIdleSessions();
    clock += 100;
    await manager.sweepIdleSessions();
    expect(manager.getRuntime('s-ext-busy')).toBeDefined();

    busy.delete('s-ext-busy');
    await manager.sweepIdleSessions();
    clock += 100;
    await manager.sweepIdleSessions();
    expect(manager.getRuntime('s-ext-busy')).toBeUndefined();

    await manager.close();
  });
});
