import { useEffect, useState } from 'react';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Switch } from '@/renderer/components/ui/switch';
import {
  CONFLICT_MESSAGE,
  ROUTING_SAVED_LABEL,
  ROUTING_SAVING_LABEL,
  SETTING_SAVE_FAILED_PREFIX,
} from '../describe.js';
import { errorMessage } from '../settings.js';
import { useGlobalTaskSettingSave } from '../../queries.js';

/** An absent switch is on, so a null value and a true value are the same. */
function retrySwitchEqual(a: boolean | null | undefined, b: boolean | null | undefined): boolean {
  return (a ?? true) === (b ?? true);
}

function RetrySwitch({ id, field }: { id: string; field: 'retry_sessions' | 'retry_bots' }) {
  const setting = useGlobalTaskSettingSave<boolean | null>({
    select: (snapshot) => snapshot.user_global[field] ?? null,
    equals: retrySwitchEqual,
    patch: (enabled) => ({ [field]: enabled }),
  });

  const [draft, setDraft] = useState(true);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (!setting.dirty && setting.value !== undefined) {
      setDraft(setting.value ?? true);
    }
  }, [setting.dirty, setting.value]);

  const commit = (checked: boolean): void => {
    setDraft(checked);
    setting.markDirty();
    void setting.commit(checked).then((result) => {
      if (result.status === 'saved') {
        setStatus(ROUTING_SAVED_LABEL);
        setIsError(false);
      } else if (result.status === 'conflict') {
        setStatus(CONFLICT_MESSAGE);
        setIsError(true);
      } else if (result.status === 'failed') {
        setStatus(`${SETTING_SAVE_FAILED_PREFIX}${result.message}`);
        setIsError(true);
      }
    });
  };

  if (setting.isError && setting.value === undefined) {
    return <p className="text-destructive" role="alert">{`读取失败：${errorMessage(setting.error)}`}</p>;
  }
  if (setting.isPending) {
    return <Skeleton className="h-5 w-8" />;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Switch
        id={id}
        checked={draft}
        disabled={setting.saving}
        onCheckedChange={(checked: boolean) => commit(checked)}
      />
      {isError && status !== '' ? (
        <p className="text-xs text-destructive" role="alert">{status}</p>
      ) : setting.saving ? (
        <p className="text-xs text-muted-foreground" role="status">{ROUTING_SAVING_LABEL}</p>
      ) : status !== '' ? (
        <p className="text-xs text-muted-foreground" role="status">{status}</p>
      ) : null}
    </div>
  );
}

/** Global session main-reasoning retry switch (`tasks.settings.global`). */
export function SessionRetryControl() {
  return <RetrySwitch id="retry-sessions" field="retry_sessions" />;
}

/** Global bot turn retry switch (`tasks.settings.global`). */
export function BotRetryControl() {
  return <RetrySwitch id="retry-bots" field="retry_bots" />;
}
