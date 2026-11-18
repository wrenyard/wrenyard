import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionClosedError,
  SessionNotFoundError,
  SessionReadOnlyError,
  type SessionEventBase,
  type SessionEventDraft,
  type SessionPersistencePort,
  type SessionSummaryBase,
} from '../src/index.ts';

// Source: 2026-11-18-session-module-architecture.md
export interface PersistenceContractFixture<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
> {
  persistence: SessionPersistencePort<E, TSummary>;
  cleanup?: () => Promise<void>;
}

export function runSessionPersistenceContract<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
>(
  name: string,
  factory: (options?: { now?: () => Date }) =>
    | PersistenceContractFixture<E, TSummary>
    | Promise<PersistenceContractFixture<E, TSummary>>,
): void {
  describe(`${name} persistence contract`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      while (cleanups.length > 0) {
        const fn = cleanups.pop()!;
        await fn();
      }
    });

    async function setup(now?: () => Date): Promise<SessionPersistencePort<E, TSummary>> {
      const fixture = await factory(now === undefined ? undefined : { now });
      await fixture.persistence.init?.();
      cleanups.push(async () => {
        await fixture.persistence.close();
        await fixture.cleanup?.();
      });
      return fixture.persistence;
    }

    const draft = (value: Record<string, unknown>): SessionEventDraft<E> =>
      value as unknown as SessionEventDraft<E>;

    it('creates, appends, reads, and pages timelines with binary search boundaries', async () => {
      const persistence = await setup();
      const handle = await persistence.create('s-page', [
        draft({ type: 'session.titled', text: 'Initial' }),
      ]);

      const e2 = await handle.append(draft({
        type: 'turn.started',
        turn: 1,
        id: 't1',
        text: 'hello',
        model: { provider: 'openai', model: 'gpt-4o' },
      }));
      const batch = await handle.appendBatch?.([
        draft({ type: 'system.info', turn: 1, source: 'system', code: 'step', message: 'one' }),
        draft({ type: 'turn.finished', turn: 1, id: 't1', status: 'completed' }),
      ]);
      expect(e2.seq).toBe(2);
      if (batch !== undefined) {
        expect(batch.map((item) => item.seq)).toEqual([3, 4]);
      }

      const all = handle.read();
      expect(all.map((item) => item.seq)).toEqual(batch === undefined ? [1, 2] : [1, 2, 3, 4]);
      expect(persistence.read('s-page')).toEqual(all);

      const page1 = handle.readPage(0, 2);
      expect(page1.events.map((item) => item.seq)).toEqual([1, 2]);
      expect(page1.lastSeq).toBe(all.length);
      expect(page1.hasMore).toBe(all.length > 2);

      const page2 = handle.readPage(2, 10);
      expect(page2.events.map((item) => item.seq)).toEqual(batch === undefined ? [] : [3, 4]);
      expect(page2.hasMore).toBe(false);

      const emptyPage = handle.readPage(99, 5);
      expect(emptyPage).toEqual({ events: [], lastSeq: all.length, hasMore: false });

      await handle.close();
    });

    it('derives summaries and orders list() by updatedAt desc then sessionId asc', async () => {
      let epoch = 1_700_000_000_000;
      const now = (): Date => new Date(epoch);
      const persistence = await setup(now);

      const hA = await persistence.create('s-a');
      epoch += 1_000;
      const hB = await persistence.create('s-b');
      epoch += 1_000;
      await hA.append(draft({ type: 'session.titled', text: 'First Session' }));
      await hA.append(draft({
        type: 'turn.started',
        turn: 1,
        id: 't1',
        text: 'go',
        model: { provider: 'openai', model: 'gpt-4o' },
      }));

      const statA = persistence.stat('s-a');
      expect(statA?.title).toBe('First Session');
      expect(statA?.lastSeq).toBe(2);
      expect(statA?.pendingTurns).toEqual([1]);
      expect((statA?.bytes ?? 0) > 0).toBe(true);

      await hB.append(draft({ type: 'session.titled', text: 'Second Session' }));
      expect(persistence.stat('s-b')?.updatedAt).toBe(statA?.updatedAt);

      // Equal updatedAt falls back to sessionId ascending.
      expect(persistence.list().map((item) => item.sessionId)).toEqual(['s-a', 's-b']);

      epoch += 1_000;
      await hB.append(draft({ type: 'system.info', source: 'system', code: 'bump', message: 'newer' }));
      expect(persistence.list().map((item) => item.sessionId)).toEqual(['s-b', 's-a']);

      await hA.close();
      await hB.close();
    });

    it('enforces single-writer exclusion and SessionAlreadyExistsError', async () => {
      const persistence = await setup();
      const writer = await persistence.create('s-own');

      await expect(persistence.create('s-own')).rejects.toThrow(SessionAlreadyExistsError);
      await expect(persistence.open('s-own', 'write')).rejects.toThrow(SessionAlreadyOwnedError);

      // Concurrent read handles remain allowed alongside an active writer.
      const reader = await persistence.open('s-own', 'read');
      expect(reader.mode).toBe('read');

      await writer.close();
      const writer2 = await persistence.open('s-own', 'write');
      expect(writer2.mode).toBe('write');

      await reader.close();
      await writer2.close();
    });

    it('refuses writes on read handles and all operations on closed handles', async () => {
      const persistence = await setup();
      const writer = await persistence.create('s-guards');
      await writer.close();

      const reader = await persistence.open('s-guards', 'read');
      await expect(
        reader.append(draft({ type: 'system.info', source: 'system', code: 'x', message: 'y' })),
      ).rejects.toThrow(SessionReadOnlyError);
      if (reader.appendBatch !== undefined) {
        await expect(
          reader.appendBatch([draft({ type: 'system.info', source: 'system', code: 'x', message: 'y' })]),
        ).rejects.toThrow(SessionReadOnlyError);
      }
      await expect(reader.flush()).rejects.toThrow(SessionReadOnlyError);
      await reader.close();
      await reader.close();

      expect(() => reader.read()).toThrow(SessionClosedError);
      expect(() => reader.readPage(0, 10)).toThrow(SessionClosedError);
      expect(() => reader.summary()).toThrow(SessionClosedError);
      await expect(
        reader.append(draft({ type: 'system.info', source: 'system', code: 'x', message: 'y' })),
      ).rejects.toThrow(SessionClosedError);
      await expect(reader.flush()).rejects.toThrow(SessionClosedError);
    });

    it('rejects non-JSON values losslessly and freezes stored events', async () => {
      const persistence = await setup();
      const handle = await persistence.create('s-json');

      const cyclic: Record<string, unknown> = {
        type: 'system.info',
        source: 'system',
        code: 'c',
        message: 'cycle',
      };
      cyclic.self = cyclic;

      await expect(handle.append(draft(cyclic))).rejects.toThrow();
      await expect(
        handle.append(draft({
          type: 'system.info',
          source: 'system',
          code: 'fn',
          message: 'bad',
          fn: () => 'nope',
        })),
      ).rejects.toThrow();
      await expect(
        handle.append(draft({
          type: 'system.info',
          source: 'system',
          code: 'nan',
          message: 'bad',
          val: Number.NaN,
        })),
      ).rejects.toThrow();
      await expect(
        handle.append(draft({
          type: 'system.info',
          source: 'system',
          code: 'sym',
          message: 'bad',
          sym: Symbol('s'),
        })),
      ).rejects.toThrow();

      const payload = { nested: { count: 1 } };
      const appended = await handle.append(draft({
        type: 'system.info',
        source: 'system',
        code: 'ok',
        message: 'frozen',
        payload,
      }));
      payload.nested.count = 999;

      expect(Object.isFrozen(appended)).toBe(true);
      expect((handle.read()[0] as unknown as { payload: { nested: { count: number } } }).payload.nested.count).toBe(1);
      await handle.close();
    });

    it('notifies subscribers, isolates listener errors, supports flush, and deletes sessions', async () => {
      const persistence = await setup();
      const seen: number[] = [];
      const unsubGood = persistence.subscribe('s-sub', (event) => {
        seen.push(event.seq);
      });
      const unsubBad = persistence.subscribe('s-sub', () => {
        throw new Error('listener failure');
      });

      const handle = await persistence.create('s-sub');
      await handle.append(draft({ type: 'session.titled', text: 'Live' }));
      await handle.append(draft({ type: 'system.info', source: 'system', code: 'x', message: 'y' }));
      await handle.flush();
      expect(seen).toEqual([1, 2]);

      unsubGood();
      unsubBad();
      await handle.append(draft({ type: 'system.info', source: 'system', code: 'x', message: 'z' }));
      expect(seen).toEqual([1, 2]);

      await handle.close();
      await persistence.deleteSession('s-sub');

      expect(persistence.stat('s-sub')).toBeUndefined();
      expect(persistence.list()).toEqual([]);
      await expect(persistence.open('s-sub', 'read')).rejects.toThrow(SessionNotFoundError);
      await expect(persistence.deleteSession('s-sub')).rejects.toThrow(SessionNotFoundError);
    });
  });
}
