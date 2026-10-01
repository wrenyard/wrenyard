import { queryOptions } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';

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
