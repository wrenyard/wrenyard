import { describe, expect, it } from 'vitest';

import {
  SessionCorruptedError,
  Timeline,
  pageEvents,
  snapshotJsonValue,
  type SessionEventBase,
} from '../src/index.ts';

// Source: 2026-11-18-session-module-architecture.md
interface TestEvent extends SessionEventBase {
  text?: string;
  throughSeq?: number;
}

describe('snapshotJsonValue', () => {
  it('deeply clones, omits undefined object properties, and freezes plain JSON values', () => {
    const source = { a: 1, b: [2, { c: 'ok' }], opt: undefined as string | undefined };
    const snap = snapshotJsonValue(source);

    expect(snap).toEqual({ a: 1, b: [2, { c: 'ok' }] });
    expect('opt' in snap).toBe(false);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.b)).toBe(true);

    source.a = 99;
    (source.b[1] as { c: string }).c = 'mutated';
    expect(snap.a).toBe(1);
    expect((snap.b[1] as { c: string }).c).toBe('ok');
  });

  it('rejects cycles, non-finite numbers, symbols, bigints, functions, and non-plain objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => snapshotJsonValue(cyclic)).toThrow(TypeError);
    expect(() => snapshotJsonValue(undefined)).toThrow(TypeError);
    expect(() => snapshotJsonValue([1, undefined])).toThrow(TypeError);
    expect(() => snapshotJsonValue({ bad: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => snapshotJsonValue({ bad: Number.NaN })).toThrow(TypeError);
    expect(() => snapshotJsonValue({ bad: () => 1 })).toThrow(TypeError);
    expect(() => snapshotJsonValue({ bad: Symbol('x') })).toThrow(TypeError);
    expect(() => snapshotJsonValue({ bad: BigInt(1) })).toThrow(TypeError);
    expect(() => snapshotJsonValue({ bad: new Date() })).toThrow(TypeError);
  });
});

describe('pageEvents', () => {
  const events: TestEvent[] = [1, 2, 4, 7, 9].map((seq) => ({
    seq,
    at: '2026-11-18T00:00:00.000Z',
    type: 'note',
  }));

  it('slices bounded pages via binary search over sparse or dense sequences', () => {
    expect(pageEvents(events, 0, 2)).toEqual({
      events: events.slice(0, 2),
      lastSeq: 9,
      hasMore: true,
    });
    expect(pageEvents(events, 2, 2)).toEqual({
      events: events.slice(2, 4),
      lastSeq: 9,
      hasMore: true,
    });
    expect(pageEvents(events, 7, 5)).toEqual({
      events: events.slice(4, 5),
      lastSeq: 9,
      hasMore: false,
    });
    expect(pageEvents(events, 9, 5)).toEqual({
      events: [],
      lastSeq: 9,
      hasMore: false,
    });
    expect(pageEvents([], 0, 10)).toEqual({
      events: [],
      lastSeq: 0,
      hasMore: false,
    });
  });
});

describe('Timeline', () => {
  it('enforces strictly monotonic sequence numbers and tracks generations', () => {
    const timeline = new Timeline<TestEvent>([
      { seq: 1, at: '2026-11-18T00:00:00.000Z', type: 'session.created' },
    ]);
    expect(timeline.lastSeq).toBe(1);
    expect(timeline.appendGeneration).toBe(0);
    expect(timeline.replaceGeneration).toBe(0);

    const e2 = timeline.commitDraft({ type: 'note', text: 'hi' }, '2026-11-18T00:00:01.000Z');
    expect(e2.seq).toBe(2);
    expect(timeline.appendGeneration).toBe(1);
    expect(timeline.replaceGeneration).toBe(0);

    const e3 = timeline.commit({
      seq: 3,
      at: '2026-11-18T00:00:02.000Z',
      type: 'summary',
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    });
    expect(e3.seq).toBe(3);
    expect(timeline.appendGeneration).toBe(2);
    expect(timeline.replaceGeneration).toBe(1);

    expect(() =>
      timeline.commit({ seq: 3, at: '2026-11-18T00:00:03.000Z', type: 'dup' }),
    ).toThrow(SessionCorruptedError);
    expect(() =>
      new Timeline<TestEvent>([
        { seq: 2, at: '2026-11-18T00:00:00.000Z', type: 'a' },
        { seq: 1, at: '2026-11-18T00:00:01.000Z', type: 'b' },
      ]),
    ).toThrow(SessionCorruptedError);
  });

  it('computes activeSurfaceEvents for explicit surfaceOps and custom replaceRange hooks', () => {
    const timeline = new Timeline<TestEvent>();
    timeline.commitDraft({ type: 'turn.started', text: 'u1' }, '2026-11-18T00:00:01.000Z');
    timeline.commitDraft({ type: 'span.started', surfaceOp: 'none' }, '2026-11-18T00:00:02.000Z');
    timeline.commitDraft({ type: 'reply.sent', text: 'r1' }, '2026-11-18T00:00:03.000Z');
    timeline.commitDraft({ type: 'context.compacted', throughSeq: 3, text: 'summary-1' }, '2026-11-18T00:00:04.000Z');
    timeline.commitDraft({ type: 'turn.started', text: 'u2' }, '2026-11-18T00:00:05.000Z');

    const active = timeline.activeSurfaceEvents({
      isSurfaceEvent: (event) => event.type !== 'span.started',
      replaceRange: (event) =>
        event.type === 'context.compacted' && event.throughSeq !== undefined
          ? { startSeq: 1, endSeq: event.throughSeq }
          : undefined,
    });

    expect(active.map((event) => event.seq)).toEqual([4, 5]);
    // Underlying durable timeline remains complete and unmutated.
    expect(timeline.length).toBe(5);
  });
});
