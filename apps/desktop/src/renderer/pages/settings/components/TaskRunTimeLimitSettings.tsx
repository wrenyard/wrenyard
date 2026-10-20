import { useEffect, useState } from 'react';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { errorMessage } from '../model/settings.js';
import { useGlobalTaskSettingSave } from '../queries.js';
import {
  CONFLICT_MESSAGE,
  ROUTING_SAVING_LABEL,
  SETTING_SAVE_FAILED_PREFIX,
  SETTING_SAVED_LABEL,
} from '../model/describe.js';

const DEFAULT_MINUTES = 60;
const MIN_MINUTES = 5;
const MAX_MINUTES = 600;

function parseMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_MINUTES || parsed > MAX_MINUTES) {
    throw new Error(`任务运行时限须为 ${MIN_MINUTES}–${MAX_MINUTES} 分钟的整数`);
  }
  return parsed;
}

function minutesEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** Global task run time limit (minutes), stored in tasks.settings.global. */
export function TaskRunTimeLimitSettings() {
  const limit = useGlobalTaskSettingSave<number | null>({
    select: (snapshot) => snapshot.user_global?.run_time_limit_minutes ?? null,
    equals: minutesEqual,
    patch: (minutes) => ({ run_time_limit_minutes: minutes }),
  });

  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (!limit.dirty && limit.value !== undefined) {
      setDraft(limit.value === null ? '' : String(limit.value));
    }
  }, [limit.dirty, limit.value]);

  const commitDraft = (): void => {
    try {
      const minutes = parseMinutes(draft);
      void limit.commit(minutes).then((result) => {
        if (result.status === 'saved') {
          setStatus(SETTING_SAVED_LABEL);
          setIsError(false);
        } else if (result.status === 'conflict') {
          setStatus(CONFLICT_MESSAGE);
          setIsError(true);
        } else if (result.status === 'failed') {
          setStatus(`${SETTING_SAVE_FAILED_PREFIX}${result.message}`);
          setIsError(true);
        }
      });
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
      setIsError(true);
    }
  };

  if (limit.isError && limit.value === undefined) {
    return <p className="text-destructive" role="alert">{`读取失败：${errorMessage(limit.error)}`}</p>;
  }
  if (limit.isPending) {
    return <Skeleton className="h-16 w-full" />;
  }

  const displayPlaceholder = limit.value === null || limit.value === undefined ? String(DEFAULT_MINUTES) : undefined;

  return (
    <section className="flex flex-col gap-2 overflow-hidden rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="task-run-time-limit">任务运行时限（分钟）</Label>
        <p className="text-xs text-muted-foreground">默认 60 分钟，可设置范围 5–600。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="task-run-time-limit"
          type="number"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          step={1}
          inputMode="numeric"
          className="w-28"
          placeholder={displayPlaceholder}
          value={draft}
          disabled={limit.isPending}
          onChange={(event) => {
            setDraft(event.target.value);
            limit.markDirty();
          }}
          onBlur={() => {
            if (limit.dirty) commitDraft();
          }}
        />
        <span className="text-sm text-muted-foreground">{limit.isPending ? ROUTING_SAVING_LABEL : status}</span>
      </div>
      {isError && status !== '' ? <p className="text-xs text-destructive" role="alert">{status}</p> : null}
    </section>
  );
}
