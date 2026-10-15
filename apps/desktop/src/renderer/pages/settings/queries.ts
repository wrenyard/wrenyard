import { useCallback, useEffect, useRef, useState } from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shell } from '@/renderer/lib/desktop';
import { toast } from '@/renderer/lib/notify';
import type { DesktopPreferences, PreferenceId, StorageUsageSnapshot, TaskSettingsPatch, TaskSettingsSnapshot } from '@/shell-contract';
import {
  daemonQuery,
  preferencesQuery,
  preferencesQueryKey,
  runtimeAliasesQuery,
  settingsQuery,
  settingsQueryKey,
  taskSettingsQuery,
  updateQuery,
} from '@/renderer/lib/queries';
import { mergeSnapshots } from '@/renderer/pages/tasks/model/settings.js';
import { applyLocalPreference, draftMatchesBaseline, errorMessage } from './model/settings.js';

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

/** How a committed global task setting was applied; drives the caller's copy. */
export type GlobalTaskSettingCommitResult =
  | { status: 'noop' }
  | { status: 'pending' }
  | { status: 'saved' }
  | { status: 'conflict'; message: string }
  | { status: 'failed'; message: string };

export interface GlobalTaskSettingOptions<T> {
  /** Selects this setting's current value from a task-settings snapshot. */
  select: (snapshot: TaskSettingsSnapshot) => T;
  /** Semantic equality so an untouched draft or an equivalent value is a no-op. */
  equals: (current: T, next: T) => boolean;
  /** The global-scope patch for one committed value. */
  patch: (value: T) => TaskSettingsPatch;
}

export interface GlobalTaskSettingSave<T> {
  /** Authoritative value, or undefined until the snapshot loads. */
  value: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  /** True after the first genuine edit; a clean draft keeps following the server. */
  dirty: boolean;
  /** A save is in flight; callers disable the control to prevent double submits. */
  saving: boolean;
  /** Marks the draft dirty, pinning the baseline and revision on the first edit. */
  markDirty: () => void;
  /** Commits a parsed draft; a no-op when it equals the pinned baseline. */
  commit: (next: T) => Promise<GlobalTaskSettingCommitResult>;
}

/**
 * Failure copy for a CAS conflict whose follow-up configuration refresh could
 * not be completed: the conflict happened, the retry revision could not be
 * verified, and the draft is still held for a deliberate retry.
 */
const CONFLICT_REFRESH_FAILED_MESSAGE = '保存冲突：刷新最新配置失败，你填写的值仍保留，请稍后重试。';

/**
 * One shared save path for the global, daemon-backed numeric settings. It pins
 * the baseline value and `expected_revision` on the first genuine change and
 * never rebases them while dirty, so a background refresh cannot overwrite a
 * dirty draft. Commits short-circuit when the parsed value equals the pinned
 * baseline, then CAS on the pinned revision; a success adopts the returned
 * snapshot before clearing dirty, and a conflict is never auto-retried.
 */
export function useGlobalTaskSettingSave<T>(
  options: GlobalTaskSettingOptions<T>,
): GlobalTaskSettingSave<T> {
  const queryClient = useQueryClient();
  const settings = useQuery(taskSettingsQuery());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const pinRef = useRef<{ ready: boolean; baseline: T | undefined; revision: string }>({
    ready: false,
    baseline: undefined,
    revision: '',
  });

  const snapshot = settings.data;
  const value = snapshot === undefined ? undefined : options.select(snapshot);

  // A clean draft follows the authoritative snapshot; a dirty draft keeps the
  // baselines pinned on its first genuine change. `dirty` is a dependency so a
  // semantic no-op (dirty → false) re-pins the baseline and revision from the
  // latest snapshot instead of leaving the old pin behind.
  useEffect(() => {
    if (dirtyRef.current) return;
    pinRef.current = {
      ready: snapshot !== undefined,
      baseline: value,
      revision: snapshot?.revision ?? '',
    };
  }, [snapshot, value, dirty]);

  const markDirty = useCallback((): void => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
  }, []);

  const commit = useCallback(
    async (next: T): Promise<GlobalTaskSettingCommitResult> => {
      // Synchronous guard first: a same-tick Enter+blur or a second blur cannot
      // issue a duplicate request while one save is already in flight.
      if (inFlightRef.current) return { status: 'pending' };
      const pin = pinRef.current;
      // Only a genuine, dirty edit writes; an untouched or not-yet-loaded draft
      // never touches the daemon.
      if (!dirtyRef.current || !pin.ready) return { status: 'noop' };
      // A draft that resolves back to the pinned baseline is a semantic no-op:
      // drop dirtiness so the clean draft follows the authoritative snapshot
      // again, and leave no invalid state behind (the hook owns no separate
      // invalid-status field; callers reset their own status before committing).
      if (draftMatchesBaseline(optionsRef.current.equals, pin.baseline, next)) {
        dirtyRef.current = false;
        setDirty(false);
        return { status: 'noop' };
      }

      inFlightRef.current = true;
      setSaving(true);

      // Snapshot the immutable request before awaiting.
      const request = {
        scope: 'global' as const,
        expected_revision: pin.revision,
        patch: optionsRef.current.patch(next),
      };

      try {
        const saved = await shell.saveTaskSettings(request);
        // Drop any in-flight background fetch so its stale payload cannot land
        // on top of the authoritative snapshot we are about to adopt.
        await queryClient.cancelQueries({ queryKey: taskSettingsQuery().queryKey });
        queryClient.setQueryData(
          taskSettingsQuery().queryKey,
          (base: TaskSettingsSnapshot | undefined) => mergeSnapshots(base, saved),
        );
        // Advance the pinned baseline and revision to the saved value *before*
        // clearing dirty, so a following edit is not rebound to a stale
        // baseline/revision.
        pinRef.current = {
          ready: true,
          baseline: optionsRef.current.select(saved),
          revision: saved.revision,
        };
        dirtyRef.current = false;
        setDirty(false);
        void queryClient.invalidateQueries({
          queryKey: ['taskSettings'],
          predicate: (query) => query.queryKey[1] !== null || query.queryKey[2] !== null,
        });
        return { status: 'saved' };
      } catch (error) {
        const message = errorMessage(error);
        if (!message.includes('冲突')) {
          void queryClient.invalidateQueries({ queryKey: ['taskSettings'] });
          return { status: 'failed', message };
        }
        // A true CAS conflict: keep the draft and the original comparison
        // baseline, and stay locked (saving/inFlight held by `finally`) while
        // configuration is refetched. Only the retry revision moves to the
        // freshly refreshed authoritative revision; there is no auto-resubmit —
        // an explicit retry (Enter/blur or a deliberate edit) must come first.
        try {
          await queryClient.refetchQueries(
            { queryKey: taskSettingsQuery().queryKey },
            { throwOnError: true },
          );
          const refreshed = queryClient.getQueryData<TaskSettingsSnapshot>(taskSettingsQuery().queryKey);
          const revision = refreshed?.revision;
          // Advance the retry revision only once the refetch returned a usable
          // one; a missing revision cannot be retried, so report the failed
          // refresh instead of claiming success.
          if (typeof revision !== 'string' || revision === '') {
            return { status: 'failed', message: CONFLICT_REFRESH_FAILED_MESSAGE };
          }
          pinRef.current = { ...pinRef.current, revision };
        } catch {
          // The refresh threw: keep the previous revision (do not adopt an
          // unverified one) and report the conflict without claiming a refresh.
          return { status: 'failed', message: CONFLICT_REFRESH_FAILED_MESSAGE };
        }
        return { status: 'conflict', message };
      } finally {
        inFlightRef.current = false;
        setSaving(false);
      }
    },
    [queryClient],
  );

  return {
    value,
    isPending: settings.isPending,
    isError: settings.isError,
    error: settings.error,
    dirty,
    saving,
    markDirty,
    commit,
  };
}

/**
 * Storage usage snapshot for the 存储 page. Read-only, and gated by the page's
 * `active` flag so opening Settings never starts a scan. While the daemon
 * reports `scanning` the query polls once a second; otherwise it stays idle.
 */
const STORAGE_SCAN_POLL_MS = 1_000;

export const storageUsageQueryKey = ['storage', 'usage'] as const;

export function useStorageUsageQuery(enabled: boolean) {
  const queryClient = useQueryClient();
  const scanning = queryClient.getQueryData<StorageUsageSnapshot>(storageUsageQueryKey)?.status === 'scanning';
  return useQuery({
    queryKey: storageUsageQueryKey,
    queryFn: () => shell.getStorageUsage(false),
    enabled,
    // A plain value (not a function) so a snapshot written by the refresh
    // mutation re-arms polling on the next render.
    refetchInterval: enabled && scanning ? STORAGE_SCAN_POLL_MS : false,
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
