import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FieldError } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { shell } from '@/renderer/lib/desktop';
import { taskSettingsQuery } from '@/renderer/lib/queries';
import type { TaskSettingsRoutingWeights } from '@/shell-contract';
import {
  CONFLICT_MESSAGE,
  ROUTING_SAVED_LABEL,
  ROUTING_SAVING_LABEL,
  ROUTING_TOTAL_PREFIX,
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
import { errorMessage } from '../model/settings.js';

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
  const queryClient = useQueryClient();
  const settings = useQuery(taskSettingsQuery());
  const revision = settings.data?.revision ?? '';

  const [inputs, setInputs] = useState<WeightInputs | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (settings.data && !dirty) {
      setInputs(routingWeightsToInput(routingWeightsToPercent(settings.data.user_global.routing_weights)));
    }
  }, [settings.data, dirty]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['taskSettings'] });
  };

  const save = useMutation({
    mutationFn: (patch: TaskSettingsRoutingWeights) => shell.saveTaskSettings({
      scope: 'global',
      expected_revision: revision,
      patch: { routing_weights: patch },
    }),
    onSuccess: () => {
      setDirty(false);
      setStatus(ROUTING_SAVED_LABEL);
      setIsError(false);
      invalidate();
    },
    onError: (error) => {
      setStatus(`${CONFLICT_MESSAGE}${errorMessage(error)}`);
      setIsError(true);
      invalidate();
    },
  });

  const total = inputs === null ? 0 : totalOf(inputs);
  const totalRounded = Math.round(total);
  const totalInvalid = totalRounded !== 100;

  // Autosave only a valid total; an invalid total stays local and unsaved.
  useEffect(() => {
    if (inputs === null || !dirty || totalInvalid || save.isPending) return;
    let patch: TaskSettingsRoutingWeights;
    try {
      patch = routingWeightsFromPercent(parseRoutingWeightsInput(inputs));
    } catch {
      return;
    }
    save.mutate(patch);
    // `save` is stable enough here; the guard on inputs/dirty drives the run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, dirty, totalInvalid]);

  if (settings.isError) {
    return <p className="text-destructive" role="alert">{`读取失败：${errorMessage(settings.error)}`}</p>;
  }
  if (settings.isPending || inputs === null) {
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
                aria-describedby="routing-weights-total"
                aria-invalid={totalInvalid}
                onChange={(event) => {
                  setDirty(true);
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
      {save.isPending && <p className="text-sm text-muted-foreground" role="status">{ROUTING_SAVING_LABEL}</p>}
      {status !== '' && !save.isPending && (
        <p className={isError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} role="status">
          {status}
        </p>
      )}
    </div>
  );
}
