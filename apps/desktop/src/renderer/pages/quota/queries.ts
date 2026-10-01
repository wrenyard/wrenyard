import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  configureProviderKey,
  getQuota,
  requestTaskRoutingTest,
  requestRoutingTestTasks,
  saveProviderOrder,
} from '@/renderer/lib/desktop';
import type { QuotaSnapshot, TaskRoutingTestParams } from '@/shell-contract';

/**
 * Typed quota queries/actions for the Model Supply page. Every bridge call goes
 * through `lib/desktop`; the shared query client is read from React Query's
 * provider context so the page never owns global cache state.
 */

/** Snapshots refresh on a slow interval and whenever the window regains focus. */
const QUOTA_REFETCH_INTERVAL_MS = 60_000;
/** Raw task definitions change rarely; once imported they stay fresh for the session. */
const ROUTING_TASKS_STALE_MS = 5 * 60_000;

export const quotaQuery = queryOptions<QuotaSnapshot>({
  queryKey: ['quota'],
  queryFn: () => getQuota(false),
  staleTime: 30_000,
  refetchInterval: QUOTA_REFETCH_INTERVAL_MS,
  refetchOnWindowFocus: true,
});

export function useQuotaQuery() {
  return useQuery(quotaQuery);
}

/** Force-refresh from the header button: bypass the cache, then seed it with the fresh snapshot. */
export function useQuotaRefresh() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getQuota(true),
    onSuccess: (snapshot) => {
      client.setQueryData(quotaQuery.queryKey, snapshot);
    },
  });
}

/** Persist one complete provider order; the daemon returns the reordered snapshot. */
export function useSaveProviderOrder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (providerIds: string[]) => saveProviderOrder(providerIds),
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
      configureProviderKey(input.providerId, input.key),
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
  queryFn: () => requestRoutingTestTasks(),
  staleTime: ROUTING_TASKS_STALE_MS,
});

export function useRoutingTestTasksQuery(enabled: boolean) {
  return useQuery({ ...routingTestTasksQuery, enabled });
}

/** One routing-test run. Invoked only from an explicit user click. */
export function useRoutingTestRun() {
  return useMutation({
    mutationFn: (params: TaskRoutingTestParams) => requestTaskRoutingTest(params),
  });
}
