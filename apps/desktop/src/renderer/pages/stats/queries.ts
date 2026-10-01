import { queryOptions, useQuery } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import type { StatsSnapshot } from '@/shell-contract';

/** The ledger polls while its page is mounted; unmounting stops the timer. */
const STATS_REFETCH_INTERVAL_MS = 5_000;

export const statsQuery = queryOptions<StatsSnapshot>({
  queryKey: ['stats'],
  queryFn: () => shell.getStats(),
  refetchInterval: STATS_REFETCH_INTERVAL_MS,
});

export function useStatsQuery() {
  return useQuery(statsQuery);
}
