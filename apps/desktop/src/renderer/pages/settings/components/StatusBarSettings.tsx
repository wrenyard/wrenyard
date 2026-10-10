import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import { shell } from '@/renderer/lib/desktop';
import { toast } from '@/renderer/lib/notify';
import { preferencesQuery, preferencesQueryKey } from '@/renderer/lib/queries';
import { STATUS_BAR_CONFIGURABLE_ITEMS } from '@/renderer/lib/statusbar';
import type { DesktopPreferences } from '@/shell-contract';
import { errorMessage } from '../model/settings.js';

/**
 * Status-bar visibility list. It reads and writes the same `statusBar.hidden`
 * value as the status bar's right-click menu, and the items come from the pure
 * `lib/statusbar` metadata contract, so the two surfaces cannot drift.
 */
export function StatusBarSettingsControl() {
  const queryClient = useQueryClient();
  const preferences = useQuery(preferencesQuery);
  const hidden = preferences.data?.statusBar.hidden ?? [];

  const save = useMutation({
    mutationFn: (value: string[]) => shell.setPreference('statusBar.hidden', value),
    onSuccess: (next: DesktopPreferences) => queryClient.setQueryData(preferencesQueryKey, next),
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
      toast(`偏好保存失败：${errorMessage(error)}`, { level: 'error' });
    },
  });

  const toggle = (id: string, visible: boolean): void => {
    const next = visible ? hidden.filter((item) => item !== id) : [...new Set([...hidden, id])];
    save.mutate(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {STATUS_BAR_CONFIGURABLE_ITEMS.map((item) => (
        <label key={item.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={!hidden.includes(item.id)}
            disabled={save.isPending}
            onCheckedChange={(checked: boolean) => toggle(item.id, checked === true)}
          />
          {item.label}
        </label>
      ))}
    </div>
  );
}
