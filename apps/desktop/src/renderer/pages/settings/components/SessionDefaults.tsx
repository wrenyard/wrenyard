import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EffortPicker, ModelPicker, modelBadges, modelRuntimeDescription, type ModelOption } from '@/renderer/components/chat/model-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { shell } from '@/renderer/lib/desktop';
import { getSessionBridge } from '@/renderer/lib/session';
import { notify } from '@/renderer/lib/notify';
import { preferencesQuery, preferencesQueryKey } from '@/renderer/lib/queries';
import { SESSION_DEFAULT_MODEL_OPTIONS, type DesktopPreferences, type PreferenceId } from '@/shell-contract';
import { errorMessage } from '../model/settings.js';

/**
 * New-session model default. "沿用上次发送的模型" keeps the last sent model and
 * effort; "指定模型" pins an explicit model and reasoning effort. The model list
 * and its thinking levels come from the same session bridge the composer uses,
 * so a pinned value resolves to the same model.
 */
export function SessionDefaultsControl() {
  const queryClient = useQueryClient();
  const preferences = useQuery(preferencesQuery);
  const session = preferences.data?.session;
  const mode = session?.defaultModel ?? 'last';

  const save = useMutation({
    mutationFn: (input: { id: PreferenceId; value: unknown }) => shell.setPreference(input.id, input.value),
    onSuccess: (next: DesktopPreferences) => queryClient.setQueryData(preferencesQueryKey, next),
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
      notify({ level: 'error', source: 'settings', title: '偏好保存失败', description: errorMessage(error) });
    },
  });

  const models = useQuery({
    queryKey: ['session', 'models'] as const,
    queryFn: () => getSessionBridge().models(),
    enabled: mode === 'specified',
    staleTime: 60_000,
  });

  const available = models.data ?? [];
  const options: ModelOption[] = available.map((model) => ({
    value: model.publicId,
    label: model.displayName,
    group: model.providerDisplayName,
    description: modelRuntimeDescription(model.runtime),
    badges: modelBadges(model),
  }));
  const levels = available.find((model) => model.publicId === session?.model)?.thinkingLevels ?? [];

  return (
    <div className="flex flex-col gap-3">
      <Select
        value={mode}
        disabled={save.isPending}
        onValueChange={(value: string | null) => {
          if (value !== null) save.mutate({ id: 'session.defaultModel', value });
        }}
      >
        <SelectTrigger className="max-w-80">
          <SelectValue>
            {(value) => SESSION_DEFAULT_MODEL_OPTIONS.find((option) => option.value === value)?.label ?? value}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SESSION_DEFAULT_MODEL_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === 'specified' && (
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            models={options}
            value={session?.model ?? ''}
            disabled={models.isLoading}
            onChange={(value) => save.mutate({ id: 'session.model', value: value === '' ? null : value })}
          />
          <EffortPicker
            levels={levels}
            value={session?.effort ?? ''}
            onChange={(value) => save.mutate({ id: 'session.effort', value: value === '' ? null : value })}
          />
        </div>
      )}
    </div>
  );
}
