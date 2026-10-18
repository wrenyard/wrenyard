/**
 * Bounded memory for recently opened sessions.
 *
 * Re-opening a conversation should paint what it already showed and fetch only
 * the delta, but retaining every opened history would make memory grow without
 * bound. This cache therefore keeps a small least-recently-used window: at most
 * {@link MAX_SESSIONS} sessions and {@link MAX_EVENTS} ledger events in total.
 * Writing past either cap evicts the least recently used entry, and a session
 * that alone exceeds the whole event budget is never retained.
 */
import type { LedgerEvent, LiveCall, SessionBridgeTaskBrief } from '../model/types.js';
import type { PendingTurn } from './session-reducer.js';

/** The conversation slice a cached session restores on switch. */
export interface RecentSessionSlice {
  events: LedgerEvent[];
  live: LiveCall[];
  tasks: Record<string, SessionBridgeTaskBrief>;
  pending: PendingTurn[];
  interrupting: number[];
  /** Highest ledger sequence contained in `events`. */
  lastSeq: number;
}

/** Most sessions kept at once. */
const MAX_SESSIONS = 6;
/** Most ledger events kept across every cached session. */
const MAX_EVENTS = 20_000;

const slices = new Map<string, RecentSessionSlice>();
let eventsInUse = 0;

/** Read one cached slice and mark it most recently used. */
export function readRecentSession(sessionId: string): RecentSessionSlice | undefined {
  const slice = slices.get(sessionId);
  if (slice === undefined) return undefined;
  slices.delete(sessionId);
  slices.set(sessionId, slice);
  return slice;
}

/** Store the latest view of one session, evicting least recently used entries. */
export function writeRecentSession(sessionId: string, slice: RecentSessionSlice): void {
  const size = slice.events.length;
  // A session bigger than the whole budget would still exceed the cap after
  // evicting everything else, so it is simply not retained.
  if (size > MAX_EVENTS) {
    dropRecentSession(sessionId);
    return;
  }
  const previous = slices.get(sessionId);
  if (previous !== undefined) {
    slices.delete(sessionId);
    eventsInUse -= previous.events.length;
  }
  slices.set(sessionId, slice);
  eventsInUse += size;
  // Map iteration is insertion order, so the first entry is the least recently
  // used; the entry just written is last and survives its own eviction pass.
  for (const [id, cached] of slices) {
    if (slices.size <= MAX_SESSIONS && eventsInUse <= MAX_EVENTS) break;
    slices.delete(id);
    eventsInUse -= cached.events.length;
  }
}

/** Forget one session, e.g. when its cached view no longer matches the daemon. */
export function dropRecentSession(sessionId: string): void {
  const slice = slices.get(sessionId);
  if (slice === undefined) return;
  slices.delete(sessionId);
  eventsInUse -= slice.events.length;
}

/** Forget every cached session. */
export function clearRecentSessions(): void {
  slices.clear();
  eventsInUse = 0;
}
