import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import { quotaQuery } from '@/renderer/lib/queries';
import type { TaskRoutingTestParams } from '@/shell-contract';

/**
 * Typed quota queries/actions for the Model Supply page. Every bridge call goes
 * through `lib/desktop`; the shared query client is read from React Query's
 * provider context so the page never owns global cache state.
 *
 * The quota snapshot itself lives in `lib/queries` because the status-bar quota
 * panel and the session usage panel read the same cache entry; it is re-exported
 * here so existing Model Supply consumers keep one import site.
 */
export { quotaQuery, useQuotaQuery, useQuotaRefresh } from '@/renderer/lib/queries';

/** Raw task definitions change rarely; once imported they stay fresh for the session. */
const ROUTING_TASKS_STALE_MS = 5 * 60_000;

/** Persist one complete provider order; the daemon returns the reordered snapshot. */
export function useSaveProviderOrder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (providerIds: string[]) => shell.saveProviderOrder(providerIds),
    onSuccess: (snapshot) => {
      client.setQueryData(quotaQuery.queryKey, snapshot);
    },
  });
}

/** Write one provider API key; the daemon returns the refreshed snapshot. */
export function useConfigureProviderKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { providerId: string; key: string }) =>
      shell.configureProviderKey(input.providerId, input.key),
    onSuccess: (snapshot) => {
      client.setQueryData(quotaQuery.queryKey, snapshot);
    },
  });
}

/**
 * Raw task definitions for the routing-test importer. Disabled until the picker
 * is first opened so entering the page never fetches task definitions.
 */
export const routingTestTasksQuery = queryOptions({
  queryKey: ['quota', 'routingTestTasks'] as const,
  queryFn: () => shell.requestRoutingTestTasks(),
  staleTime: ROUTING_TASKS_STALE_MS,
});

export function useRoutingTestTasksQuery(enabled: boolean) {
  return useQuery({ ...routingTestTasksQuery, enabled });
}

/** One routing-test run. Invoked only from an explicit user click. */
export function useRoutingTestRun() {
  return useMutation({
    mutationFn: (params: TaskRoutingTestParams) => shell.requestTaskRoutingTest(params),
  });
}
