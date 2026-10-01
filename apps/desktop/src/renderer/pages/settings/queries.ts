import { queryOptions, useQuery } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import { daemonQuery, runtimeAliasesQuery, updateQuery } from '@/renderer/lib/queries';

/**
 * Page-scoped queries for the Settings page. The update, daemon and runtime
 * alias snapshots are shared shell queries owned by `lib/queries` and refreshed
 * by the app-level push subscriptions (see `app/query-client`); the settings
 * page only owns its own settings snapshot.
 */

export { daemonQuery, runtimeAliasesQuery, updateQuery };

export const settingsQueryKey = ['shell', 'settings'] as const;
export const summarySettingsQueryKey = ['shell', 'summary-settings'] as const;
export const daemonQueryKey = daemonQuery.queryKey;
export const updateQueryKey = updateQuery.queryKey;
export const runtimeAliasesQueryKey = runtimeAliasesQuery.queryKey;

export const settingsQuery = queryOptions({
  queryKey: settingsQueryKey,
  queryFn: () => shell.getSettings(),
  staleTime: 30_000,
});

export const summarySettingsQuery = queryOptions({
  queryKey: summarySettingsQueryKey,
  queryFn: () => shell.getSummarySettings(),
  staleTime: 30_000,
});

export function useSettingsQuery() {
  return useQuery(settingsQuery);
}

export function useDaemonQuery() {
  return useQuery(daemonQuery);
}

export function useUpdateQuery() {
  return useQuery(updateQuery);
}

export function useSummarySettingsQuery() {
  return useQuery(summarySettingsQuery);
}

export function useRuntimeAliasesQuery() {
  return useQuery(runtimeAliasesQuery);
}

/** Every page query key, used by the header refresh action. */
export const SETTINGS_QUERY_KEYS = [
  settingsQueryKey,
  daemonQueryKey,
  updateQueryKey,
  summarySettingsQueryKey,
  runtimeAliasesQueryKey,
] as const;
