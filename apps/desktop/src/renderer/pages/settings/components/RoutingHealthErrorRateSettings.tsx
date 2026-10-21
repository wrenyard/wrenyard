import { useEffect, useState } from 'react';
import { FieldError } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import {
  CONFLICT_MESSAGE,
  ROUTING_SAVED_LABEL,
  ROUTING_SAVING_LABEL,
  SETTING_SAVE_FAILED_PREFIX,
} from '../model/describe.js';
import { errorMessage } from '../model/settings.js';
import { useGlobalTaskSettingSave } from '../queries.js';

const DEFAULT_PERCENT = 50;
const MIN_PERCENT = 1;
const MAX_PERCENT = 100;

function parseThreshold(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_PERCENT || parsed > MAX_PERCENT) {
    throw new Error(`健康错误率阈值须为 ${MIN_PERCENT}–${MAX_PERCENT} 的整数`);
  }
  return parsed;
}

function thresholdEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  return (a ?? DEFAULT_PERCENT) === (b ?? DEFAULT_PERCENT);
}

/** Global health-avoidance error-rate threshold for automatic routing. */
export function RoutingHealthErrorRateControl() {
  const threshold = useGlobalTaskSettingSave<number | null>({
    select: (snapshot) => snapshot.user_global.health_error_rate_threshold ?? null,
    equals: thresholdEqual,
    patch: (value) => ({ health_error_rate_threshold: value }),
  });

  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (!threshold.dirty && threshold.value !== undefined) {
      setInput(threshold.value === null ? '' : String(threshold.value));
    }
  }, [threshold.dirty, threshold.value]);

  const invalid = (() => {
    if (input.trim() === '') return false;
    try {
      parseThreshold(input);
      return false;
    } catch {
      return true;
    }
  })();

  useEffect(() => {
    if (!threshold.dirty || invalid) return;
    let parsed: number | null;
    try {
      parsed = parseThreshold(input);
    } catch {
      return;
    }
    void threshold.commit(parsed).then((result) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, threshold.dirty, invalid]);

  if (threshold.isError && threshold.value === undefined) {
    return <p className="text-destructive" role="alert">{`读取失败：${errorMessage(threshold.error)}`}</p>;
  }
  if (threshold.isPending) {
    return <Skeleton className="h-16 w-full" />;
  }

  const placeholder = threshold.value === null || threshold.value === undefined
    ? String(DEFAULT_PERCENT)
    : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="routing-health-error-rate">健康错误率阈值（%）</Label>
        <p className="text-xs text-muted-foreground">
          最近 1 小时请求 ≥100 且错误率不低于该值的路线将被自动选路避开；全部候选被避开时按错误率排序。
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Input
          id="routing-health-error-rate"
          type="number"
          min={MIN_PERCENT}
          max={MAX_PERCENT}
          step={1}
          className="w-24"
          placeholder={placeholder}
          value={input}
          disabled={threshold.saving}
          aria-invalid={invalid}
          onChange={(event) => {
            threshold.markDirty();
            setStatus('');
            setIsError(false);
            setInput(event.target.value);
          }}
        />
        <span className="text-muted-foreground" aria-hidden="true">%</span>
      </div>
      {invalid ? (
        <FieldError>{`须为 ${MIN_PERCENT}–${MAX_PERCENT} 的整数`}</FieldError>
      ) : null}
      {status ? (
        <p className={`text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
          {threshold.saving ? ROUTING_SAVING_LABEL : status}
        </p>
      ) : null}
    </div>
  );
}
