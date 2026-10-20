import { queryOptions, useQuery } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import type { StatsSnapshot } from '@/shell-contract';
import type { TaskDefinitionListResult } from '@wrenyard/protocol/task';

/** The ledger polls while its page is mounted; unmounting stops the timer. */
const STATS_REFETCH_INTERVAL_MS = 5_000;

export const statsQuery = queryOptions<StatsSnapshot>({
  queryKey: ['stats'],
  queryFn: () => shell.getStats(),
  refetchInterval: STATS_REFETCH_INTERVAL_MS,
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
