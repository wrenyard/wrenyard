import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent } from '@/renderer/components/ui/card';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/renderer/components/ui/combobox';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { shell } from '@/renderer/lib/desktop';
import type { SummarySettingsSnapshot } from '@/shell-contract';
import { SUMMARY_EMPTY, SUMMARY_PLACEHOLDER, SUMMARY_UNRESOLVED } from '../model/describe.js';
import { errorMessage } from '../model/settings.js';
import { summarySettingsQueryKey, useSummarySettingsQuery } from '../queries.js';

interface SummaryOption {
  value: string;
  label: string;
  provider: string;
  available: boolean;
}

interface SummaryGroup {
  provider: string;
  items: SummaryOption[];
}

function toOptions(snapshot: SummarySettingsSnapshot | undefined): SummaryOption[] {
  if (!snapshot) return [];
  return snapshot.options.map((option) => ({
    value: option.canonicalModel,
    label: option.displayName,
    provider: option.providerLabel ?? '其他',
    available: option.available,
  }));
}

function groupByProvider(options: SummaryOption[]): SummaryGroup[] {
  const groups = new Map<string, SummaryOption[]>();
  for (const option of options) {
    const bucket = groups.get(option.provider);
    if (bucket) bucket.push(option);
    else groups.set(option.provider, [option]);
  }
  return [...groups.entries()].map(([provider, items]) => ({ provider, items }));
}

/**
 * The conversation summary model picker. The option list is the backend
 * projection SSOT; a selected-but-unavailable canonical model stays visible and
 * is surfaced as an explicit warning instead of being silently substituted.
 */
export function SummarySettings() {
  const queryClient = useQueryClient();
  const settings = useSummarySettingsQuery();
  const snapshot = settings.data;

  const options = useMemo(() => toOptions(snapshot), [snapshot]);
  const groups = useMemo(() => groupByProvider(options), [options]);

  const selected = useMemo(() => {
    const value = snapshot?.selectedCanonicalModel ?? '';
    if (value === '') return null;
    return options.find((option) => option.value === value)
      ?? { value, label: value, provider: '', available: false };
  }, [options, snapshot?.selectedCanonicalModel]);

  const save = useMutation({
    mutationFn: (canonicalModel: string) => shell.saveSummaryModel(canonicalModel),
    onSuccess: (next) => queryClient.setQueryData(summarySettingsQueryKey, next),
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: summarySettingsQueryKey });
    },
  });

  if (settings.isPending) {
    return (
      <Card>
        <CardContent><Skeleton className="h-9 w-full" /></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Label htmlFor="summary-model">{SUMMARY_PLACEHOLDER}</Label>
        <Combobox
          items={groups}
          value={selected}
          onValueChange={(next) => {
            if (!next || next.value === selected?.value) return;
            save.mutate(next.value);
          }}
          itemToStringLabel={(option) => option.label}
          itemToStringValue={(option) => option.value}
          isItemEqualToValue={(a, b) => a.value === b.value}
          disabled={save.isPending}
        >
          <ComboboxTrigger render={<Button id="summary-model" variant="outline" className="w-full justify-between" />}>
            <ComboboxValue>{(current) => current?.label ?? SUMMARY_PLACEHOLDER}</ComboboxValue>
          </ComboboxTrigger>
          <ComboboxContent className="min-w-72">
            <ComboboxInput showTrigger={false} placeholder={SUMMARY_PLACEHOLDER} disabled={save.isPending} />
            <ComboboxEmpty>{SUMMARY_EMPTY}</ComboboxEmpty>
            <ComboboxList>
              {(group: SummaryGroup) => (
                <ComboboxGroup key={group.provider} items={group.items}>
                  <ComboboxLabel>{group.provider}</ComboboxLabel>
                  <ComboboxCollection>
                    {(option: SummaryOption) => (
                      <ComboboxItem key={option.value} value={option} disabled={!option.available}>
                        {option.available ? option.label : `${option.label}（不可用）`}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>

        {snapshot?.unresolved === true && (
          <p className="text-destructive" role="alert">{SUMMARY_UNRESOLVED}</p>
        )}
        {snapshot?.message !== undefined && snapshot.message !== '' && (
          <Alert variant="destructive">
            <AlertDescription>{snapshot.message}</AlertDescription>
          </Alert>
        )}
        {save.isError && (
          <p className="text-destructive" role="alert">{`保存失败：${errorMessage(save.error)}`}</p>
        )}
      </CardContent>
    </Card>
  );
}
