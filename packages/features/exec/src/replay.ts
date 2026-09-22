import type { ExecEventEnvelope, ExecSeq } from '@wrenyard/protocol';

/**
 * Result of reading a slice of an execution's retained event history.
 *
 * A gap is reported instead of silently skipped: the caller asked for events
 * after `requestedAfter`, but the oldest record still retained is newer than
 * the next expected sequence, so events in between exist and are gone forever.
 */
export type ExecReplayResult =
  | { readonly kind: 'events'; readonly events: readonly ExecEventEnvelope[]; readonly nextSeq: ExecSeq }
  | { readonly kind: 'cursor-expired'; readonly oldestRetainedSeq: ExecSeq };

/** Why a retention bound forced an eviction. */
export type ExecReplayEviction = 'count' | 'bytes';

export interface ExecReplayBufferOptions {
  /** Maximum number of retained event records. */
  readonly maxEvents: number;
  /** Maximum number of retained event-record bytes. */
  readonly maxBytes: number;
  /** Called once per eviction, with the sequence number that was dropped. */
  readonly onEvict?: (seq: ExecSeq, reason: ExecReplayEviction) => void;
}

/**
 * Bounded replay history for exactly one execution.
 *
 * History is append-only and evicted oldest-first under two independent
 * ceilings — record count and approximated payload bytes — so a single
 * runaway execution cannot grow the process without bound. Eviction is the
 * only reason a sequence number can be missing; `nextSeq` therefore stays a
 * faithful "one past the last assigned sequence" counter even after the
 * records themselves are gone.
 *
 * This class is deliberately not thread-safe and not synchronised: one
 * execution owns one buffer and the service appends to it from the single
 * drain loop.
 */
export class ExecReplayBuffer {
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #onEvict: ((seq: ExecSeq, reason: ExecReplayEviction) => void) | undefined;
  readonly #records: ExecEventEnvelope[] = [];
  #bytes = 0;
  #nextSeq: ExecSeq = 1;

  constructor(options: ExecReplayBufferOptions) {
    this.#maxEvents = Math.max(1, Math.trunc(options.maxEvents));
    this.#maxBytes = Math.max(1, Math.trunc(options.maxBytes));
    this.#onEvict = options.onEvict;
  }

  /** Sequence number that will be assigned to the next appended event. */
  get nextSeq(): ExecSeq {
    return this.#nextSeq;
  }

  /** Sequence number of the oldest retained record, or `nextSeq` when empty. */
  get oldestRetainedSeq(): ExecSeq {
    return this.#records[0]?.seq ?? this.#nextSeq;
  }

  /** Number of retained records. */
  get size(): number {
    return this.#records.length;
  }

  /**
   * Append one event record under the next sequence number and trim history
   * back within both ceilings. Returns the assigned sequence number.
   *
   * The record is treated as opaque JSON: it is only measured and retained,
   * never rewritten.
   */
  append(id: string, event: Record<string, unknown>): ExecSeq {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    const envelope: ExecEventEnvelope = { id, seq, event: JSON.parse(JSON.stringify(event)) };
    this.#records.push(envelope);
    this.#bytes += estimateBytes(envelope.event);
    this.#trim();
    return seq;
  }

  /**
   * Read every retained event after `afterSeq`, ascending.
   *
   * `afterSeq` is an EXCLUSIVE lower bound. `0` means "from the beginning of
   * retained history", and succeeds only while the first retained record is
   * still sequence 1. An `afterSeq` that has been trimmed past — including a
   * nonzero value older than the oldest retained record — reports a gap so the
   * caller resynchronises instead of silently losing events. Note that reading
   * NEVER evicts; only `append` does, so two consecutive reads with the same
   * cursor always return the same slice.
   */
  read(afterSeq: ExecSeq): ExecReplayResult {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq >= this.#nextSeq) throw new RangeError('Invalid execution event cursor');
    const oldest = this.oldestRetainedSeq;
    if (afterSeq < oldest - 1) {
      return { kind: 'cursor-expired', oldestRetainedSeq: oldest };
    }
    const events = this.#records.filter((record) => record.seq > afterSeq);
    return {
      kind: 'events',
      events,
      nextSeq: events.length > 0 ? events[events.length - 1]!.seq : afterSeq,
    };
  }

  #trim(): void {
    while (this.#records.length > this.#maxEvents) {
      this.#evictOldest('count');
    }
    while (this.#bytes > this.#maxBytes && this.#records.length > 0) {
      this.#evictOldest('bytes');
    }
  }

  #evictOldest(reason: ExecReplayEviction): void {
    const dropped = this.#records.shift();
    if (!dropped) return;
    this.#bytes -= estimateBytes(dropped.event);
    if (this.#bytes < 0) this.#bytes = 0;
    this.#onEvict?.(dropped.seq, reason);
  }
}

/**
 * Cheap upper bound on the retained size of one event record.
 *
 * The value is used only to decide when to evict, so it approximates rather
 * than serialises: string payloads (the overwhelming majority of agent output)
 * are measured at their UTF-16 length, and containers contribute a small fixed
 * overhead per entry. A record that cannot be walked contributes one unit so
 * it can never be evicted for free.
 */
export function estimateBytes(value: unknown): number {
  return measure(value, 0);
}

function measure(value: unknown, depth: number): number {
  if (depth > 8) return 1;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return 8;
  if (typeof value === 'bigint') return 16;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) total += measure(item, depth + 1) + 1;
    return total;
  }
  if (typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return byteLengthOf(value);
    let total = 2;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += key.length + measure(item, depth + 1) + 2;
    }
    return total;
  }
  return 1;
}

function byteLengthOf(value: Uint8Array | ArrayBuffer): number {
  return value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
}
