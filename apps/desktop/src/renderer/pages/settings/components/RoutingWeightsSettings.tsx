import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { saveTaskSettings } from '@/renderer/lib/desktop';
import { taskSettingsQuery } from '@/renderer/lib/queries';
import type { TaskSettingsRoutingWeights } from '@/shell-contract';
import {
  CONFLICT_MESSAGE,
  ROUTING_RESET_DONE_LABEL,
  ROUTING_RESET_LABEL,
  ROUTING_SAVE_LABEL,
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

/**
 * The global routing-weights override. Saving and resetting write only the
 * `routing_weights` field at global scope; every other setting is untouched.
 * A refetch never overwrites a draft the user is still editing.
 */
export function RoutingWeightsSettings() {
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
    mutationFn: (patch: TaskSettingsRoutingWeights) => saveTaskSettings({
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
      setStatus(`${CONFLICT_MESSAGE}\n${errorMessage(error)}`);
      setIsError(true);
      invalidate();
    },
  });

  const reset = useMutation({
    mutationFn: () => saveTaskSettings({
      scope: 'global',
      expected_revision: revision,
      patch: { routing_weights: null },
    }),
    onSuccess: () => {
      setDirty(false);
      setStatus(ROUTING_RESET_DONE_LABEL);
      setIsError(false);
      invalidate();
    },
    onError: (error) => {
      setStatus(`恢复失败：${errorMessage(error)}`);
      setIsError(true);
      invalidate();
    },
  });

  const pending = save.isPending || reset.isPending;

  const onSave = (): void => {
    if (inputs === null) return;
    let patch: TaskSettingsRoutingWeights;
    try {
      patch = routingWeightsFromPercent(parseRoutingWeightsInput(inputs));
    } catch (error) {
      setStatus(errorMessage(error));
      setIsError(true);
      return;
    }
    setIsError(false);
    setStatus('');
    save.mutate(patch);
  };

  const total = inputs === null
    ? 0
    : ROUTING_WEIGHT_KEYS.reduce((sum, key) => {
        const value = Number(inputs[key]);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
  const totalRounded = Math.round(total);
  const totalInvalid = totalRounded !== 100;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {settings.isError && (
          <p className="text-destructive" role="alert">{`读取失败：${errorMessage(settings.error)}`}</p>
        )}
        {settings.isPending || inputs === null ? (
          <Skeleton className="h-16 w-full" />
        ) : (
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
                    value={inputs[key]}
                    aria-describedby="routing-weights-total"
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
        )}

        <div className="flex items-center justify-between gap-3">
          <p
            id="routing-weights-total"
            className={totalInvalid ? 'text-destructive' : 'text-muted-foreground'}
            role="status"
          >
            {`${ROUTING_TOTAL_PREFIX} ${totalRounded}%`}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={pending || inputs === null} onClick={() => reset.mutate()}>
              {ROUTING_RESET_LABEL}
            </Button>
            <Button disabled={pending || inputs === null} onClick={onSave}>
              {pending ? ROUTING_SAVING_LABEL : ROUTING_SAVE_LABEL}
            </Button>
          </div>
        </div>

        {status !== '' && (
          <p className={isError ? 'text-destructive' : 'text-muted-foreground'} role="status">
            {status}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
