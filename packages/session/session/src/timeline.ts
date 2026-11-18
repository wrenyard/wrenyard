import { SessionCorruptedError } from './errors.ts';
import type {
  SessionEventBase,
  SessionEventDraft,
  SessionPage,
} from './types.ts';

const verifiedSnapshots = new WeakSet<object>();

/**
 * Validate that `value` can be represented losslessly in JSON, return a
 * detached deep clone, and recursively freeze every object and array.
 */
export function snapshotJsonValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && verifiedSnapshots.has(value)) {
    return value;
  }
  const ancestors = new Set<object>();
  return snapshotInner(value, ancestors) as T;
}

function snapshotInner(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Non-finite numbers cannot be stored losslessly as JSON');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'undefined') {
    throw new TypeError('undefined is not a lossless JSON value');
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new TypeError(`Unsupported non-JSON value of type ${typeof value}`);
  }

  const obj = value as object;
  if (ancestors.has(obj)) {
    throw new TypeError('Circular reference cannot be stored as JSON');
  }
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      for (let index = 0; index < obj.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(obj, index)) {
          throw new TypeError('Sparse array holes cannot be stored losslessly as JSON');
        }
        const item = obj[index];
        if (item === undefined) {
          throw new TypeError('Array elements cannot be undefined in JSON');
        }
        out.push(snapshotInner(item, ancestors));
      }
      Object.freeze(out);
      verifiedSnapshots.add(out);
      return out;
    }

    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('Non-plain object cannot be stored losslessly as JSON');
    }
    const symbols = Object.getOwnPropertySymbols(obj);
    for (const sym of symbols) {
      if (Object.prototype.propertyIsEnumerable.call(obj, sym)) {
        throw new TypeError('Enumerable symbol properties cannot be stored losslessly as JSON');
      }
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const prop = (obj as Record<string, unknown>)[key];
      if (prop === undefined) continue;
      Object.defineProperty(out, key, {
        value: snapshotInner(prop, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    Object.freeze(out);
    verifiedSnapshots.add(out);
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/** Slice one bounded page after `afterSeq` using binary search. */
export function pageEvents<E extends SessionEventBase>(
  events: readonly E[],
  afterSeq: number,
  limit: number,
): SessionPage<E> {
  const start = firstSeqAfter(events, afterSeq);
  const width = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : events.length;
  const end = Math.min(events.length, start + width);
  return {
    events: events.slice(start, end),
    lastSeq: events.length > 0 ? events[events.length - 1]!.seq : 0,
    hasMore: end < events.length,
  };
}

function firstSeqAfter<E extends SessionEventBase>(events: readonly E[], afterSeq: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.seq <= afterSeq) low = middle + 1;
    else high = middle;
  }
  return low;
}

function assertValidEventShape(event: SessionEventBase, previousSeq: number): void {
  if (!Number.isInteger(event.seq) || event.seq < 1 || event.seq <= previousSeq) {
    throw new SessionCorruptedError(
      `Timeline event seq must be a strictly increasing positive integer (got ${String(event.seq)} after ${previousSeq})`,
    );
  }
  if (typeof event.at !== 'string' || typeof event.type !== 'string' || event.type === '') {
    throw new SessionCorruptedError('Timeline event is missing required string fields "at" or "type"');
  }
}

function isReplaceSurfaceOp(event: SessionEventBase): boolean {
  return typeof event.surfaceOp === 'object'
    && event.surfaceOp !== null
    && event.surfaceOp.op === 'replace';
}

export interface ActiveSurfaceOptions<E extends SessionEventBase> {
  isSurfaceEvent?: (event: E) => boolean;
  replaceRange?: (event: E) => { startSeq: number; endSeq: number } | undefined;
}

/**
 * Append-only event timeline preserving strict `seq` monotonicity,
 * immutable JSON snapshots, generation counters, and surface shadowing.
 */
export class Timeline<E extends SessionEventBase = SessionEventBase> {
  private items: E[] = [];
  private _appendGeneration = 0;
  private _replaceGeneration = 0;

  constructor(initialEvents: readonly E[] = []) {
    this.loadInitial(initialEvents);
  }

  get length(): number {
    return this.items.length;
  }

  get lastSeq(): number {
    return this.items.length > 0 ? this.items[this.items.length - 1]!.seq : 0;
  }

  get appendGeneration(): number {
    return this._appendGeneration;
  }

  get replaceGeneration(): number {
    return this._replaceGeneration;
  }

  read(): E[] {
    return [...this.items];
  }

  view(): readonly E[] {
    return this.items;
  }

  page(afterSeq: number, limit: number): SessionPage<E> {
    return pageEvents(this.items, afterSeq, limit);
  }

  commit(event: E): E {
    const prevSeq = this.lastSeq;
    assertValidEventShape(event, prevSeq);
    const frozen = snapshotJsonValue(event);
    this.items.push(frozen);
    this._appendGeneration += 1;
    if (isReplaceSurfaceOp(frozen)) {
      this._replaceGeneration += 1;
    }
    return frozen;
  }

  commitDraft(draft: SessionEventDraft<E>, at: string): E {
    const next = {
      ...(draft as Record<string, unknown>),
      seq: this.lastSeq + 1,
      at,
    } as unknown as E;
    return this.commit(next);
  }

  reset(events: readonly E[]): void {
    const validated: E[] = [];
    let prevSeq = 0;
    for (const event of events) {
      assertValidEventShape(event, prevSeq);
      const frozen = snapshotJsonValue(event);
      validated.push(frozen);
      prevSeq = frozen.seq;
    }
    this.items = validated;
    this._appendGeneration += 1;
    this._replaceGeneration += 1;
  }

  activeSurfaceEvents(options?: ActiveSurfaceOptions<E>): E[] {
    const replacements: Array<{ atSeq: number; startSeq: number; endSeq: number }> = [];
    for (const event of this.items) {
      const explicit = typeof event.surfaceOp === 'object' && event.surfaceOp !== null
        ? event.surfaceOp
        : undefined;
      const range = options?.replaceRange?.(event) ?? explicit;
      if (range !== undefined && range.startSeq <= range.endSeq) {
        replacements.push({
          atSeq: event.seq,
          startSeq: range.startSeq,
          endSeq: range.endSeq,
        });
      }
    }

    const active: E[] = [];
    for (const event of this.items) {
      if (event.surfaceOp === 'none') continue;
      if (options?.isSurfaceEvent !== undefined && !options.isSurfaceEvent(event)) continue;
      let shadowed = false;
      for (const replacement of replacements) {
        if (
          replacement.atSeq > event.seq
          && event.seq >= replacement.startSeq
          && event.seq <= replacement.endSeq
        ) {
          shadowed = true;
          break;
        }
      }
      if (!shadowed) active.push(event);
    }
    return active;
  }

  private loadInitial(events: readonly E[]): void {
    let prevSeq = 0;
    for (const event of events) {
      assertValidEventShape(event, prevSeq);
      const frozen = snapshotJsonValue(event);
      this.items.push(frozen);
      prevSeq = frozen.seq;
    }
  }
}
