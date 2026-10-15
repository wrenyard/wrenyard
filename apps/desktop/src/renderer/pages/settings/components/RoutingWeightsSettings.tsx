import { useEffect, useState } from 'react';
import { FieldError } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import type { TaskSettingsRoutingWeights } from '@/shell-contract';
import {
  CONFLICT_MESSAGE,
  ROUTING_SAVED_LABEL,
  ROUTING_SAVING_LABEL,
  ROUTING_TOTAL_PREFIX,
  SETTING_SAVE_FAILED_PREFIX,
} from '../model/describe.js';
import {
  ROUTING_WEIGHT_KEYS,
  ROUTING_WEIGHT_LABELS,
  parseRoutingWeightsInput,
  routingWeightsFromPercent,
  routingWeightsToInput,
  routingWeightsToPercent,
  type RoutingWeightKey,
} from '../model/routing-weights.js';
import { errorMessage, routingWeightsEqual } from '../model/settings.js';
import { useGlobalTaskSettingSave } from '../queries.js';

type WeightInputs = Record<RoutingWeightKey, string>;

function totalOf(inputs: WeightInputs): number {
  return ROUTING_WEIGHT_KEYS.reduce((sum, key) => {
    const value = Number(inputs[key]);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

/**
 * The global routing-weights override. Edits autosave only while the four
 * factors total 100; any other total shows a `FieldError` and is not saved.
 */
export function RoutingWeightsControl() {
  const weights = useGlobalTaskSettingSave<TaskSettingsRoutingWeights | null>({
    select: (snapshot) => snapshot.user_global.routing_weights ?? null,
    equals: routingWeightsEqual,
    patch: (value) => ({ routing_weights: value }),
  });

  const [inputs, setInputs] = useState<WeightInputs | null>(null);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (!weights.dirty) setInputs(routingWeightsToInput(routingWeightsToPercent(weights.value)));
  }, [weights.dirty, weights.value]);

  const total = inputs === null ? 0 : totalOf(inputs);
  const totalRounded = Math.round(total);
  const totalInvalid = totalRounded !== 100;

  // Autosave only a valid total; an invalid total stays local and unsaved. The
  // hook makes equivalent weights a no-op and a conflict never auto-retries, so
  // the effect settles after a failure instead of looping.
  useEffect(() => {
    if (inputs === null || !weights.dirty || totalInvalid) return;
    let patch: TaskSettingsRoutingWeights;
    try {
      patch = routingWeightsFromPercent(parseRoutingWeightsInput(inputs));
    } catch {
      return;
    }
    void weights.commit(patch).then((result) => {
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
    // The guard on inputs/dirty/totalInvalid drives the run; `weights.commit` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, weights.dirty, totalInvalid]);

  // A fatal read error only replaces the control before any snapshot (cached or
  // initial) has loaded; a background refetch that fails while a value exists
  // keeps the control and any draft visible.
  if (weights.isError && weights.value === undefined) {
    return <p className="text-destructive" role="alert">{`读取失败：${errorMessage(weights.error)}`}</p>;
  }
  if (weights.isPending || inputs === null) {
    return <Skeleton className="h-16 w-full" />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3 @2xl/main:grid-cols-4">
        {ROUTING_WEIGHT_KEYS.map((key) => (
          <div key={key} className="flex flex-col gap-1.5">
            <Label htmlFor={`routing-weight-${key}`}>{ROUTING_WEIGHT_LABELS[key]}</Label>
            <div className="flex items-center gap-1">
              <Input
                id={`routing-weight-${key}`}
                type="number"
                min={0}
                max={100}
                step={1}
                className="w-24"
                value={inputs[key]}
                disabled={weights.saving}
                aria-describedby="routing-weights-total"
                aria-invalid={totalInvalid}
                onChange={(event) => {
                  weights.markDirty();
                  setStatus('');
                  setIsError(false);
                  setInputs({ ...inputs, [key]: event.target.value });
                }}
              />
              <span className="text-muted-foreground" aria-hidden="true">%</span>
            </div>
          </div>
        ))}
      </div>

      <p
        id="routing-weights-total"
        className={totalInvalid ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
        role="status"
      >
        {`${ROUTING_TOTAL_PREFIX} ${totalRounded}%`}
      </p>
      {totalInvalid && <FieldError>{`四项权重之和必须为 100（当前 ${totalRounded}）`}</FieldError>}
      {weights.saving && <p className="text-sm text-muted-foreground" role="status">{ROUTING_SAVING_LABEL}</p>}
      {status !== '' && !weights.saving && (
        <p className={isError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} role="status">
          {status}
        </p>
      )}
    </div>
  );
}
