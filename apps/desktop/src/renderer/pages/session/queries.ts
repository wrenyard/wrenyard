import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { ContextInspection } from '@/shell-contract';
import { getSessionApi } from './api.js';

/**
 * Session context-inspection query (usage spec 3.4). The key carries the
 * session, selected model and ledger `seq`, so switching session or model
 * fetches immediately while new ledger events are throttled to at most one
 * request per second by {@link useThrottledSeq}. `keepPreviousData` keeps the
 * last numbers on screen until the next result arrives, so the ring never
 * flashes back to zero.
 */

/** New ledger events trigger at most one inspection request per second. */
export const CONTEXT_REFETCH_THROTTLE_MS = 1_000;

/** Draft sessions are inspected without a `sessionId` (resident layers + snapshot). */
export function contextInspectSessionId(sessionKey: string): string | undefined {
  return sessionKey === '' || sessionKey === 'draft' ? undefined : sessionKey;
}

export function contextQuery(sessionKey: string, model: string, seq: number) {
  const sessionId = contextInspectSessionId(sessionKey);
  return queryOptions<ContextInspection>({
    queryKey: ['session', 'context', sessionKey, model, seq] as const,
    queryFn: () => getSessionApi().contextInspect({
      ...(sessionId === undefined ? {} : { sessionId }),
      model,
    }),
    enabled: model !== '',
    placeholderData: keepPreviousData,
    staleTime: CONTEXT_REFETCH_THROTTLE_MS,
  });
}

/**
 * Trailing throttle for a rapidly changing value. Leading changes apply
 * immediately; a burst within the interval collapses to one trailing update, so
 * a streaming turn cannot issue an inspection request per ledger event.
 */
export function useThrottledSeq(seq: number, intervalMs = CONTEXT_REFETCH_THROTTLE_MS): number {
  const [throttled, setThrottled] = useState(seq);
  const lastAppliedRef = useRef(0);

  useEffect(() => {
    if (seq === throttled) return;
    const now = Date.now();
    const elapsed = now - lastAppliedRef.current;
    if (elapsed >= intervalMs) {
      lastAppliedRef.current = now;
      setThrottled(seq);
      return;
    }
    const timer = setTimeout(() => {
      lastAppliedRef.current = Date.now();
      setThrottled(seq);
    }, intervalMs - elapsed);
    return () => clearTimeout(timer);
  }, [seq, throttled, intervalMs]);

  return throttled;
}
