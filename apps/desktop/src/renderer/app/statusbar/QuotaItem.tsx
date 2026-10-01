import { useEffect, useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import type { StatusBarTone } from '@/renderer/components/status-bar-button';
import {
  formatWindowName,
  paceView,
  quotaLevel,
  resetView,
} from '@/renderer/components/usage/QuotaBar';
import type { QuotaLevel } from '@/renderer/components/usage/QuotaBar';
import { onQuotaPanelOpen } from '@/renderer/lib/statusbar';
import { quotaQuery } from '@/renderer/lib/queries';
import { QuotaPanel } from '@/renderer/app/statusbar/QuotaPanel';
import type { QuotaProviderSnapshot, QuotaWindowSnapshot } from '@/shell-contract';

/**
 * Status-bar quota item (usage spec 6.2). It picks the most severe quota window
 * across the enabled providers and shows its provider, window and remaining
 * percentage; clicking opens {@link QuotaPanel}. The global `quota.showPanel`
 * command opens the same panel through {@link onQuotaPanelOpen}.
 */

const SEVERITY: Readonly<Record<QuotaLevel, number>> = { normal: 0, warning: 1, destructive: 2 };

const LEVEL_TONE: Readonly<Record<QuotaLevel, StatusBarTone>> = {
  normal: 'default',
  warning: 'warning',
  destructive: 'destructive',
};

interface QuotaCandidate {
  provider: QuotaProviderSnapshot;
  window: QuotaWindowSnapshot;
  level: QuotaLevel;
}

/** Alert level for a window: the remaining-percentage level, or a bad pace. */
function windowLevel(window: QuotaWindowSnapshot): QuotaLevel {
  const level = quotaLevel(window.remainingPct);
  if (level !== 'normal') return level;
  return paceView(window.remainingPct, window.expectedRemainingPct)?.warn === true ? 'warning' : 'normal';
}

/** Most severe window; ties go to the lowest remaining percentage. */
function selectWindow(providers: readonly QuotaProviderSnapshot[]): QuotaCandidate | null {
  let best: QuotaCandidate | null = null;
  for (const provider of providers) {
    for (const window of provider.windows) {
      if (!Number.isFinite(window.remainingPct)) continue;
      const candidate: QuotaCandidate = { provider, window, level: windowLevel(window) };
      if (best === null) {
        best = candidate;
        continue;
      }
      const severity = SEVERITY[candidate.level] - SEVERITY[best.level];
      if (severity > 0 || (severity === 0 && window.remainingPct < best.window.remainingPct)) best = candidate;
    }
  }
  return best;
}

/** Re-renders once a minute so the reset countdown stays current. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function quotaTooltip(candidate: QuotaCandidate, now: number): string {
  const { provider, window } = candidate;
  const name = provider.label || provider.id;
  const parts = [
    `${name} ${formatWindowName(window.name, window.windowMinutes)} 剩余 ${Math.floor(window.remainingPct)}%`,
  ];
  const pace = paceView(window.remainingPct, window.expectedRemainingPct);
  if (pace !== null) parts.push(pace.label);
  const reset = resetView(window.resetsAt, now);
  if (reset !== null) parts.push(reset.label);
  return parts.join(' · ');
}

export interface QuotaItemProps {
  /** Notified when the panel opens or closes (used to release a forced-visible slot). */
  onOpenChange?: (open: boolean) => void;
}

export function QuotaItem({ onOpenChange }: QuotaItemProps = {}) {
  const quota = useQuery(quotaQuery);
  const [open, setOpen] = useState(false);
  const now = useMinuteNow();

  const candidates = useMemo(() => {
    const data = quota.data;
    if (data === undefined) return [] as QuotaProviderSnapshot[];
    if (data.providerOrder.length === 0) return data.providers;
    const enabled = new Set(
      data.providerOrder.filter((entry) => entry.enabled).map((entry) => entry.id),
    );
    return data.providers.filter((provider) => enabled.has(provider.id));
  }, [quota.data]);
  const selected = useMemo(() => selectWindow(candidates), [candidates]);

  useEffect(() => onQuotaPanelOpen(() => setOpen(true)), []);

  const label = selected === null
    ? undefined
    : `${selected.provider.label || selected.provider.id} ${formatWindowName(
        selected.window.name,
        selected.window.windowMinutes,
      )} ${Math.floor(selected.window.remainingPct)}%`;

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <StatusBarButton
          icon={Gauge}
          label={label}
          tone={selected === null ? 'default' : LEVEL_TONE[selected.level]}
          tooltip={selected === null ? '额度' : quotaTooltip(selected, now)}
          ariaLabel="额度"
        />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[400px] p-0">
        <QuotaPanel />
      </PopoverContent>
    </Popover>
  );
}
