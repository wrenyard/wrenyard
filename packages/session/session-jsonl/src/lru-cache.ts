import type { LedgerEvent } from '@wrenyard/protocol/session';

export const MAX_CACHED_SESSIONS = 16;
export const MAX_CACHED_BYTES = 64 * 1024 * 1024;
export const MAX_CACHED_EVENTS = 60_000;

/** One resident timeline: its frozen events plus their serialized byte size. */
export interface LoadedSession {
  events: LedgerEvent[];
  bytes: number;
}

/**
 * 3-cap LRU cache (session count, serialized bytes, event count) for loaded
 * session timelines, with pinning to protect in-flight appends.
 */
export class SessionLruCache {
  private readonly entries = new Map<string, LoadedSession>();
  private readonly pinned = new Set<string>();
  private cachedBytes = 0;
  private cachedEvents = 0;

  pin(sessionId: string): void {
    this.pinned.add(sessionId);
  }

  unpin(sessionId: string): void {
    this.pinned.delete(sessionId);
    this.evict();
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  get(sessionId: string): LoadedSession | undefined {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return undefined;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return entry;
  }

  set(sessionId: string, events: LedgerEvent[], bytes: number): void {
    this.drop(sessionId);
    this.entries.set(sessionId, { events, bytes });
    this.cachedBytes += bytes;
    this.cachedEvents += events.length;
    this.evict();
  }

  updateBytes(
    sessionId: string,
    deltaBytes: number,
    deltaEvents = 0,
    expectedEvents?: readonly LedgerEvent[],
  ): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (expectedEvents !== undefined && entry.events !== expectedEvents) return;
    entry.bytes += deltaBytes;
    this.cachedBytes += deltaBytes;
    this.cachedEvents += deltaEvents;
  }

  drop(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    this.entries.delete(sessionId);
    this.cachedBytes -= entry.bytes;
    this.cachedEvents -= entry.events.length;
  }

  clear(): void {
    this.entries.clear();
    this.cachedBytes = 0;
    this.cachedEvents = 0;
  }

  evict(): void {
    while (
      this.entries.size > MAX_CACHED_SESSIONS
      || this.cachedBytes > MAX_CACHED_BYTES
      || this.cachedEvents > MAX_CACHED_EVENTS
    ) {
      let oldest: string | undefined;
      for (const sessionId of this.entries.keys()) {
        if (this.pinned.has(sessionId)) continue;
        oldest = sessionId;
        break;
      }
      if (oldest === undefined) return;
      this.drop(oldest);
    }
  }
}
