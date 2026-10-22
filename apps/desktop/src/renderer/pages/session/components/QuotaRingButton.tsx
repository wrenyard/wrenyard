import { useEffect, useMemo, useState } from 'react';
import { InputGroupButton } from '@/renderer/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { UsageRing } from '@/renderer/components/usage/UsageRing';
import { paceView, quotaLevel, quotaPoolLevel, resetView } from '@/renderer/components/usage/QuotaBar';
import { openSessionInspector } from '@/renderer/lib/session-inspector';
import { useQuotaQuery } from '@/renderer/lib/queries';
import { getCurrentSession, restoreMain, useMiniMode } from '@/renderer/lib/mini';
import { selectTightestQuotaWindow } from '@/renderer/lib/quota-focus';
import { useComposerSelection, useSessionUsage } from '../state/session-usage.js';

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Inline composer quota ring for the selected model's provider. */
export function QuotaRingButton() {
  const mini = useMiniMode();
  const { models, modelId } = useSessionUsage();
  const { modelId: selectedId } = useComposerSelection();
  const activeModelId = selectedId || modelId;
  const selected = models.find((entry) => entry.publicId === activeModelId);
  const providerId = selected?.quotaProvider;
  const quota = useQuotaQuery();
  const now = useMinuteNow();

  const provider = useMemo(() => {
    const data = quota.data;
    if (data === undefined || providerId === undefined) return undefined;
    return data.providers.find((entry) => entry.id === providerId)
      ?? data.catalog.find((entry) => entry.id === providerId);
  }, [quota.data, providerId]);

  const window = useMemo(() => {
    if (provider === undefined || !('windows' in provider)) return null;
    const snapshot = quota.data;
    if (snapshot === undefined) return null;
    const full = snapshot.providers.find((entry) => entry.id === provider.id);
    if (full === undefined) return null;
    return selectTightestQuotaWindow([full])?.window ?? null;
  }, [provider, quota.data]);

  const unknownByDesign = selected?.quotaEvidence === 'unknown_by_design';

  const ringStatus = quota.isPending ? 'loading' : unknownByDesign ? 'unknown' : 'ready';
  const remainingPct = window?.remainingPct;
  const usedRatio = remainingPct !== undefined && Number.isFinite(remainingPct)
    ? Math.max(0, Math.min(1, (100 - remainingPct) / 100))
    : undefined;

  let level = 'normal' as 'normal' | 'warning' | 'destructive';
  if (window !== null && Number.isFinite(window.remainingPct)) {
    level = quotaPoolLevel(window);
    if (level === 'normal' && paceView(window.remainingPct, window.expectedRemainingPct)?.warn === true) {
      level = 'warning';
    }
    if (quotaLevel(window.remainingPct) === 'destructive') level = 'destructive';
    else if (quotaLevel(window.remainingPct) === 'warning' && level === 'normal') level = 'warning';
  }

  const ringClass = level === 'destructive'
    ? 'text-destructive'
    : level === 'warning'
      ? 'text-warning'
      : 'text-muted-foreground';

  const providerLabel = provider && 'label' in provider ? (provider.label || provider.id) : providerId ?? '';
  const windowLabel = window?.poolLabel ?? window?.name ?? '';
  const reset = window ? resetView(window.resetsAt, now) : null;

  const tooltip = unknownByDesign
    ? '按量计费 · 用量未知'
    : [
      providerLabel,
      windowLabel,
      remainingPct !== undefined && Number.isFinite(remainingPct) ? `剩余 ${Math.round(remainingPct)}%` : undefined,
      reset?.label,
    ].filter(Boolean).join(' · ');

  const onClick = (): void => {
    if (mini) {
      restoreMain(getCurrentSession(), { id: 'quota.showPanel' });
      return;
    }
    openSessionInspector();
  };

  if (providerId === undefined) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <InputGroupButton
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="额度"
            className="shrink-0"
            onClick={onClick}
          />
        )}
      >
        <UsageRing
          ratio={usedRatio}
          status={ringStatus}
          className={`size-4 [&_svg]:size-4 ${ringClass}`}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
