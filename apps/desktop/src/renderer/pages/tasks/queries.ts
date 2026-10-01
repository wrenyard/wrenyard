import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { saveTaskSettings } from '@/renderer/lib/desktop';
import { runtimeAliasesQuery, taskSettingsQuery } from '@/renderer/lib/queries';
import type { TaskSettingsSaveRequest, TaskSettingsSnapshot } from '@/shell-contract';
import { mergeSnapshots } from './model/settings.js';

/** Full task directory. Shares the cached snapshot the ledger page also reads. */
export function useTaskSettingsQuery() {
  return useQuery(taskSettingsQuery());
}

/**
 * Scoped authoritative row for the current selection. Disabled until a task is
 * selected so the daemon only re-reads the one row the user opened.
 */
export function useTaskDetailQuery(project: string | undefined, taskId: string | null) {
  return useQuery({ ...taskSettingsQuery(project, taskId ?? undefined), enabled: taskId !== null });
}

/** Runtime alias projection, fetched only while editing an explicit reference. */
export function useRuntimeAliasesQuery(enabled: boolean) {
  return useQuery({ ...runtimeAliasesQuery, enabled });
}

/** Save one task layer patch, then refresh the shared snapshot and alias store. */
export function useSaveTaskSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: TaskSettingsSaveRequest) => saveTaskSettings(request),
    onSuccess: (saved) => {
      queryClient.setQueryData(
        taskSettingsQuery().queryKey,
        (base: TaskSettingsSnapshot | undefined) => mergeSnapshots(base, saved),
      );
      void queryClient.invalidateQueries({ queryKey: ['taskSettings'] });
      void queryClient.invalidateQueries({ queryKey: runtimeAliasesQuery.queryKey });
    },
  });
}
