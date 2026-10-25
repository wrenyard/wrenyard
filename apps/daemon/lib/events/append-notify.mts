import { getDb } from '../db/connection.mts'
import type { ForemanDatabase } from '../db/types.mts'

/**
 * Minimal shared append-notification primitive: event.list waiters sleep
 * without any timed DB polling and are woken only by committed event inserts.
 * State is keyed per database object (WeakMap), so a DB replacement starts a
 * fresh generation and old waiters simply run out of their bounded deadline
 * instead of observing rows from a different database.
 */

/** Hard bound on concurrent waiters per database; oldest is evicted first. */
const MAX_WAITERS = 128

interface AppendWaiter {
  settled: boolean
  resolve: (notified: boolean) => void
  settle: (notified: boolean) => void
}

interface AppendNotifyState {
  /** Monotonic counter bumped once per committed-insert wake. */
  generation: number
  waiters: Set<AppendWaiter>
  deferredScheduled: boolean
  /**
   * Single bounded watermark: the last cursor confirmed caught up (an
   * exhausted read) together with the generation at record time. Any
   * committed append bumps `generation`, which invalidates it.
   */
  caughtUp: { cursor: number; generation: number } | null
}

const states = new WeakMap<ForemanDatabase, AppendNotifyState>()

function stateFor(db: ForemanDatabase): AppendNotifyState {
  let state = states.get(db)
  if (!state) {
    state = { generation: 0, waiters: new Set(), deferredScheduled: false, caughtUp: null }
    states.set(db, state)
  }
  return state
}

/** Current committed-append generation of the active database. */
export function appendGeneration(): number {
  return stateFor(getDb()).generation
}

/**
 * True when `cursor` was already confirmed caught up and no committed append
 * has landed since. Database identity resolves exactly like
 * `subscribeAppendWaiter` (the active `getDb()` object's WeakMap state), so a
 * replaced database has its own watermark.
 */
export function isCaughtUpCursor(cursor: number): boolean {
  const state = stateFor(getDb())
  return state.caughtUp !== null && state.caughtUp.generation === state.generation && state.caughtUp.cursor === cursor
}

/**
 * Record `cursor` as caught up at the current generation. Callers must only
 * record after an exhausted read while the generation stayed stable across
 * that read. One slot per database; recording replaces the previous entry.
 */
export function recordCaughtUpCursor(cursor: number): void {
  const state = stateFor(getDb())
  state.caughtUp = { cursor, generation: state.generation }
}

export interface AppendWaitHandle {
  /**
   * Resolve `true` when a committed append wakes the waiter, `false` when the
   * deadline passes, the signal aborts, or the waiter is cancelled/evicted.
   */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean>
  /** Remove the waiter immediately (request finished, disconnect, dispose). */
  cancel(): void
}

/** Subscribe to the next committed-append wake for the active database. */
export function subscribeAppendWaiter(): AppendWaitHandle {
  const state = stateFor(getDb())
  const waiter: AppendWaiter = {
    settled: false,
    resolve: () => {},
    settle: () => {},
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const settle = (notified: boolean): void => {
    if (waiter.settled) return
    waiter.settled = true
    state.waiters.delete(waiter)
    if (timer !== null) clearTimeout(timer)
    waiter.resolve(notified)
  }
  waiter.settle = settle
  if (state.waiters.size >= MAX_WAITERS) {
    // Bounded waiter set: evict the oldest rather than growing without limit.
    const oldest = state.waiters.values().next().value
    oldest?.settle(false)
  }
  state.waiters.add(waiter)
  return {
    wait: (timeoutMs, signal) =>
      new Promise<boolean>((resolve) => {
        waiter.resolve = resolve
        if (signal?.aborted) {
          settle(false)
          return
        }
        timer = setTimeout(() => settle(false), Math.max(0, timeoutMs))
        signal?.addEventListener('abort', () => settle(false), { once: true })
      }),
    cancel: () => settle(false),
  }
}

/**
 * Wake waiters after an event row insert commits. Safe to call inside a
 * transaction: better-sqlite3 transactions commit synchronously before the
 * microtask queue drains, so the wake is deferred to a microtask and waiters
 * never observe uncommitted or rolled-back rows. Ignored inserts (duplicate
 * rows) must not call this.
 */
export function notifyAppendCommitted(db: ForemanDatabase = getDb()): void {
  const state = stateFor(db)
  if (db.inTransaction) {
    if (state.deferredScheduled) return
    state.deferredScheduled = true
    queueMicrotask(() => {
      state.deferredScheduled = false
      if (db.inTransaction) {
        notifyAppendCommitted(db)
        return
      }
      wakeWaiters(state)
    })
    return
  }
  wakeWaiters(state)
}

function wakeWaiters(state: AppendNotifyState): void {
  state.generation += 1
  state.caughtUp = null
  const pending = [...state.waiters]
  state.waiters.clear()
  for (const waiter of pending) waiter.settle(true)
}
