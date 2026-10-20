import { useEffect, useState } from 'react';
import { BrandIcon } from '@/renderer/components/brand-icon';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { providerBrand } from '@/renderer/lib/model-brand';
import { errorMessage } from '../model/settings.js';
import { useGlobalTaskSettingSave, useQuotaQuery } from '../queries.js';
import {
  CONFLICT_MESSAGE,
  ROUTING_SAVING_LABEL,
  SETTING_SAVE_FAILED_PREFIX,
  SETTING_SAVED_LABEL,
} from '../model/describe.js';

/** Order-independent equality so a toggled-back list is a no-op save. */
function exclusionsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

const EMPTY_EXCLUSIONS: readonly string[] = [];

/**
 * The global automatic-routing provider exclusion list. Each checkbox toggles a
 * provider id in `user_global.automatic.exclude_provider_ids`: checking writes
 * the id into the list, unchecking removes it. Saves autosave through the shared
 * global task-setting save hook, the same path `RoutingWeightsSettings` uses.
 */
export function RoutingExclusionsSettings() {
  const quota = useQuotaQuery();
  const exclusions = useGlobalTaskSettingSave<readonly string[]>({
    select: (snapshot) => snapshot.user_global?.automatic?.exclude_provider_ids ?? EMPTY_EXCLUSIONS,
    equals: exclusionsEqual,
    patch: (ids) => ({ automatic: { exclude_provider_ids: ids } }),
  });

  const [selected, setSelected] = useState<readonly string[] | null>(null);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);

  // A clean draft follows the authoritative list; a dirty draft keeps its
  // locally toggled selection pinned (handled by the hook). `value` is a stable
  // snapshot-array reference until the snapshot is replaced, so this only writes
  // when the list actually changes.
  useEffect(() => {
    if (!exclusions.dirty && exclusions.value !== undefined) setSelected(exclusions.value);
  }, [exclusions.dirty, exclusions.value]);

  // Autosave on each toggle once the draft is dirty.
  useEffect(() => {
    if (selected === null || !exclusions.dirty) return;
    void exclusions.commit(selected).then((result) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, exclusions.dirty]);

  if (exclusions.isError && exclusions.value === undefined) {
    return <p className="text-destructive" role="alert">{`读取失败：${errorMessage(exclusions.error)}`}</p>;
  }
  if (exclusions.isPending || selected === null || quota.isPending || quota.data === undefined) {
    return <Skeleton className="h-16 w-full" />;
  }

  const providers = quota.data.catalog;
  const duplicateDisplayLabels = new Set<string>();
  const displayLabelCounts = new Map<string, number>();
  for (const provider of providers) {
    const label = provider.label || provider.id;
    displayLabelCounts.set(label, (displayLabelCounts.get(label) ?? 0) + 1);
  }
  for (const [label, count] of displayLabelCounts) {
    if (count > 1) duplicateDisplayLabels.add(label);
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-muted-foreground">自动路由排除供应商</h3>
        <p className="text-sm text-muted-foreground">
          勾选的供应商不会在自动路由（辅助、机器人、会话派发、任务派发等）中被选中；你在会话中显式选择的模型与网关路由不受影响。
        </p>
      </div>
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无可用的供应商目录。</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-col divide-y">
            {providers.map((provider) => {
              const id = provider.id;
              const displayLabel = provider.label || id;
              const showRawId = duplicateDisplayLabels.has(displayLabel);
              const checked = selected.includes(id);
              return (
                <div key={id} className="flex items-center gap-2 px-3 py-2">
                  <BrandIcon brand={providerBrand(id)} />
                  <Label
                    htmlFor={`routing-exclude-provider-${id}`}
                    className="min-w-0 flex-1 cursor-pointer"
                  >
                    <span className="truncate">{displayLabel}</span>
                    {showRawId && (
                      <span className="block truncate text-xs text-muted-foreground">{id}</span>
                    )}
                  </Label>
                  <Checkbox
                    id={`routing-exclude-provider-${id}`}
                    checked={checked}
                    disabled={exclusions.saving}
                    onCheckedChange={(next: boolean) => {
                      exclusions.markDirty();
                      setStatus('');
                      setIsError(false);
                      setSelected(
                        next ? [...selected, id] : selected.filter((existing) => existing !== id),
                      );
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {exclusions.saving && (
        <p className="text-sm text-muted-foreground" role="status">{ROUTING_SAVING_LABEL}</p>
      )}
      {status !== '' && !exclusions.saving && (
        <p className={isError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} role="status">
          {status}
        </p>
      )}
    </section>
  );
}
