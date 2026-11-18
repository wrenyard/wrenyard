/**
 * Thin sub-session adapter binding auxiliary action execution onto
 * `@wrenyard/session`'s {@link ManagedSession.spawnSubSession} when a resident
 * runtime exists.
 */

import type { ManagedSession, SubSessionSpec } from '@wrenyard/session';
import type { LedgerEvent, SessionSummary } from '../events.ts';
import type { HarnessTurnInput } from '../types.ts';

export type ManagedSessionLookup = (
  sessionId: string,
) => ManagedSession<LedgerEvent, HarnessTurnInput, SessionSummary> | undefined;

/**
 * Run one auxiliary invocation inside `managed.spawnSubSession` when bound to a
 * resident `ManagedSession` runtime, preserving abort propagation and idle-eviction
 * fencing while falling back cleanly when called standalone.
 */
export async function runInAuxiliarySubSession<TInput, TResult>(
  managed: ManagedSession<LedgerEvent, HarnessTurnInput, SessionSummary> | undefined,
  spec: SubSessionSpec<TInput>,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<TResult>,
): Promise<TResult> {
  if (managed === undefined) {
    return run(signal);
  }
  return managed.spawnSubSession(
    spec,
    async (_subSessionId, subSignal) => run(subSignal),
    { signal },
  );
}
