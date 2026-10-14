import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduleState } from '@/shell-contract';
import { shell } from '@/renderer/lib/desktop';

/** Polled schedule list; the daemon owns creation, persistence and firing. */
export const schedulesQuery = queryOptions({
  queryKey: ['schedules'],
  queryFn: () => shell.listSchedules(),
  refetchInterval: 5000,
});

export function useSchedulesQuery() {
  return useQuery(schedulesQuery);
}

/** Invalidate the list after a schedule mutation so it refetches. */
function useSchedulesInvalidator(): () => void {
  const queryClient = useQueryClient();
  return () => { void queryClient.invalidateQueries({ queryKey: schedulesQuery.queryKey }); };
}

/** Pause or resume one schedule. */
export function useUpdateScheduleMutation() {
  const invalidate = useSchedulesInvalidator();
  return useMutation({
    mutationFn: ({ id, state }: { id: string; state: ScheduleState }) => shell.updateSchedule(id, state),
    onSuccess: invalidate,
  });
}

/** Fire one schedule immediately. */
export function useRunScheduleMutation() {
  const invalidate = useSchedulesInvalidator();
  return useMutation({
    mutationFn: (id: string) => shell.runSchedule(id),
    onSuccess: invalidate,
  });
}

/** Delete one schedule. */
export function useDeleteScheduleMutation() {
  const invalidate = useSchedulesInvalidator();
  return useMutation({
    mutationFn: (id: string) => shell.deleteSchedule(id),
    onSuccess: invalidate,
  });
}
