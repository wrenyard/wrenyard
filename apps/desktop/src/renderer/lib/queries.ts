import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import type { QuotaSnapshot } from '@/shell-contract';

/**
 * Shared shell snapshot queries. These are the single cache owners for the
 * update, daemon and runtime-alias bridge reads: the app-level query client
 * invalidates the same keys on push events (see `app/query-client`), so the app
 * and pages consume these options instead of re-declaring the bridge call.
 */
export const updateQuery = queryOptions({
  queryKey: ['update'] as const,
  queryFn: () => shell.getUpdate(),
  staleTime: 5_000,
});

export const daemonQuery = queryOptions({
  queryKey: ['daemon'] as const,
  queryFn: () => shell.getDaemon(),
  staleTime: 5_000,
});

export const runtimeAliasesQuery = queryOptions({
  queryKey: ['runtimeAliases'] as const,
  queryFn: () => shell.runtimeAliasSnapshot(),
  staleTime: 60_000,
});

/**
 * Full shell settings snapshot. Shared because both the settings page and the
 * status bar read service health and version details, so a single cache owner
 * avoids a second bridge fetch.
 */
export const settingsQueryKey = ['shell', 'settings'] as const;

export const settingsQuery = queryOptions({
  queryKey: settingsQueryKey,
  queryFn: () => shell.getSettings(),
  staleTime: 30_000,
});

/**
 * Version 3 Desktop preference partitions, owned by the main process. Shared
 * because the settings page and the status bar both read the same snapshot; a
 * `preferences-changed` push invalidates this key once at module load.
 */
export const preferencesQueryKey = ['preferences'] as const;

export const preferencesQuery = queryOptions({
  queryKey: preferencesQueryKey,
  queryFn: () => shell.getPreferences(),
  staleTime: 30_000,
});

/**
 * Shared task-settings snapshot used by the tasks and stats pages. The daemon
 * owns merge/persistence, so the cached snapshot is treated as fresh for one
 * minute before a background refetch. Page-specific queries live with their
 * own page.
 */
export function taskSettingsQuery(project?: string, taskId?: string) {
  return queryOptions({
    queryKey: ['taskSettings', project ?? null, taskId ?? null] as const,
    queryFn: () => shell.getTaskSettings(project, taskId),
    staleTime: 60_000,
  });
}

/**
 * Shared quota snapshot. Hoisted from the Model Supply page so the status-bar
 * quota panel and the session usage panel read the same cache entry instead of
 * importing another page's module (usage spec 5.1, 6). Snapshots refresh on a
 * slow interval and whenever the window regains focus.
 */
const QUOTA_REFETCH_INTERVAL_MS = 60_000;

export const quotaQuery = queryOptions<QuotaSnapshot>({
  queryKey: ['quota'],
  queryFn: () => shell.getQuota(false),
  staleTime: 30_000,
  refetchInterval: QUOTA_REFETCH_INTERVAL_MS,
  refetchOnWindowFocus: true,
});

export function useQuotaQuery() {
  return useQuery(quotaQuery);
}

/** Force-refresh from a refresh button: bypass the cache, then seed it with the fresh snapshot. */
export function useQuotaRefresh() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => shell.getQuota(true),
    onSuccess: (snapshot) => {
      client.setQueryData(quotaQuery.queryKey, snapshot);
    },
  });
}
