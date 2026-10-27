import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import type { StatsSnapshot } from '@/shell-contract';
import type { TaskDefinitionListResult } from '@wrenyard/protocol/task';

/**
 * Full-summary poll cadence while at least one stats consumer is mounted.
 * 20s keeps the ledger reasonably live without paying the 365-day summary
 * read every few seconds; unmounting the last consumer stops the timer, and
 * React Query's default `refetchIntervalInBackground: false` pauses polling
 * while the page is hidden.
 */
export const STATS_REFETCH_INTERVAL_MS = 20_000;

/**
 * Bounded exponential backoff applied to the poll interval after consecutive
 * failures: the interval doubles from {@link STATS_REFETCH_INTERVAL_MS} on
 * each failure, capped at {@link STATS_REFETCH_MAX_INTERVAL_MS}, and resets to
 * the base interval on the next success. First failure is retryable on the
 * base cadence; sustained failures degrade to the cap instead of hammering
 * the daemon.
 */
export const STATS_REFETCH_MAX_INTERVAL_MS = 120_000;

export const statsQuery = queryOptions<StatsSnapshot>({
  queryKey: ['stats'],
  queryFn: () => shell.getStats(),
  // A genuine rejection keeps serving the last snapshot instead of blanking
  // the page; the main bridge already converts read failures into retained
  // `stale` payloads, this covers transport-level IPC rejections.
  placeholderData: keepPreviousData,
  // React Query deduplicates same-key observers and in-flight requests:
  // EmptyStats, EmptyActivity and StatsPage sharing this key, plus a manual
  // retry racing the timer, never stack a second `stats.summary` call.
  refetchInterval: (query) => {
    // React Query already stops interval refetches when no observer is
    // mounted, and the default `refetchIntervalInBackground: false` pauses
    // polling while the page is hidden — no explicit visibility check is
    // needed here (a `false` return would not be re-evaluated on visibility
    // restore, and `refetchOnWindowFocus` stays disabled).
    // A resolved stale/unavailable snapshot clears `fetchFailureCount`, so
    // the payload-carried consecutive-failure count covers that path; the
    // two are mutually exclusive per read.
    const failureCount = Math.max(query.state.fetchFailureCount, query.state.data?.consecutiveFailures ?? 0);
    if (failureCount <= 0) return STATS_REFETCH_INTERVAL_MS;
    const backoff = STATS_REFETCH_INTERVAL_MS * 2 ** Math.min(failureCount - 1, 4);
    return Math.min(backoff, STATS_REFETCH_MAX_INTERVAL_MS);
  },
});

/** Authoritative task definition names for ledger display tables. */
export const taskDefinitionListQuery = queryOptions<TaskDefinitionListResult>({
  queryKey: ['taskDefinitionList'] as const,
  queryFn: () => shell.getTaskDefinitionList(),
  staleTime: 60_000,
});

export function useStatsQuery() {
  return useQuery(statsQuery);
}
