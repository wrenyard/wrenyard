import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import { toast } from '@/renderer/lib/notify';
import type { DesktopPreferences, PreferenceId } from '@/shell-contract';
import {
  daemonQuery,
  preferencesQuery,
  preferencesQueryKey,
  runtimeAliasesQuery,
  settingsQuery,
  settingsQueryKey,
  updateQuery,
} from '@/renderer/lib/queries';
import { applyLocalPreference, errorMessage } from './model/settings.js';

/**
 * Page-scoped queries for the Settings page. The update, daemon, runtime alias,
 * preferences and settings snapshots are shared shell queries owned by
 * `lib/queries` and refreshed by the app-level push subscriptions (see
 * `app/query-client`); the settings page only owns its quota snapshots.
 */

export {
  daemonQuery,
  preferencesQuery,
  preferencesQueryKey,
  runtimeAliasesQuery,
  settingsQuery,
  settingsQueryKey,
  updateQuery,
};

export const daemonQueryKey = daemonQuery.queryKey;
export const updateQueryKey = updateQuery.queryKey;
export const runtimeAliasesQueryKey = runtimeAliasesQuery.queryKey;

/** Provider catalog projection; drives the read-only provider count. */
export const quotaQueryKey = ['quota'] as const;

export const quotaQuery = queryOptions({
  queryKey: quotaQueryKey,
  queryFn: () => shell.getQuota(),
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

export function useRuntimeAliasesQuery() {
  return useQuery(runtimeAliasesQuery);
}

export function useQuotaQuery() {
  return useQuery(quotaQuery);
}

export function usePreferencesQuery() {
  return useQuery(preferencesQuery);
}

/**
 * The one preference write path shared by settings rows and custom controls:
 * it optimistically applies the value, persists it through the bridge, rolls
 * back and notifies on error, and adopts the authoritative snapshot on success.
 */
export function usePreferenceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: PreferenceId; value: unknown }) => shell.setPreference(input.id, input.value),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: preferencesQueryKey });
      const previous = queryClient.getQueryData<DesktopPreferences>(preferencesQueryKey);
      if (previous) {
        queryClient.setQueryData(preferencesQueryKey, applyLocalPreference(previous, input.id, input.value));
      }
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(preferencesQueryKey, context.previous);
      toast(`偏好保存失败：${errorMessage(error)}`, { level: 'error' });
    },
    onSuccess: (next) => queryClient.setQueryData(preferencesQueryKey, next),
  });
}

/** Every page query key, used by the header refresh action. */
export const SETTINGS_QUERY_KEYS = [
  settingsQueryKey,
  daemonQueryKey,
  updateQueryKey,
  runtimeAliasesQueryKey,
  quotaQueryKey,
  preferencesQueryKey,
] as const;
