import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import { shell } from '@/renderer/lib/desktop';
import { notify } from '@/renderer/lib/notify';
import { preferencesQuery, preferencesQueryKey } from '@/renderer/lib/queries';
import { NOTIFICATION_EVENT_IDS, NOTIFICATION_EVENT_LABELS, type DesktopPreferences, type PreferenceId } from '@/shell-contract';
import { errorMessage } from '../model/settings.js';

/**
 * Per-event notification toggles. Each row writes its own
 * `notifications.events.<id>` preference immediately; the main-process
 * notification center drops a disabled family before it is recorded.
 */
export function NotificationEventsControl() {
  const queryClient = useQueryClient();
  const preferences = useQuery(preferencesQuery);
  const events = preferences.data?.notifications.events;

  const save = useMutation({
    mutationFn: (input: { id: PreferenceId; value: boolean }) => shell.setPreference(input.id, input.value),
    onSuccess: (next: DesktopPreferences) => queryClient.setQueryData(preferencesQueryKey, next),
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
      notify({ level: 'error', source: 'settings', title: '偏好保存失败', description: errorMessage(error) });
    },
  });

  return (
    <div className="flex flex-col gap-2">
      {NOTIFICATION_EVENT_IDS.map((event) => (
        <label key={event} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={events?.[event] ?? true}
            disabled={events === undefined || save.isPending}
            onCheckedChange={(checked: boolean) => {
              save.mutate({ id: `notifications.events.${event}` as PreferenceId, value: checked === true });
            }}
          />
          {NOTIFICATION_EVENT_LABELS[event]}
        </label>
      ))}
    </div>
  );
}
