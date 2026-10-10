import { useEffect, useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { StatusBarButton, levelTone } from '@/renderer/components/status-bar-button';
import { quotaPoolLevel, shortWindowName } from '@/renderer/components/usage/QuotaBar';
import type { QuotaLevel } from '@/renderer/components/usage/QuotaBar';
import { QuotaTips } from '@/renderer/components/usage/QuotaTips';
import { onQuotaPanelOpen, useQuotaFocus } from '@/renderer/lib/statusbar';
import { quotaQuery } from '@/renderer/lib/queries';
import { QuotaPanel } from '@/renderer/app/statusbar/QuotaPanel';
import type { QuotaProviderSnapshot, QuotaWindowSnapshot } from '@/shell-contract';
import { eligibleQuotaProviders } from '@/shell-contract';

/**
 * Status-bar quota item (usage spec 6.2). It focuses the quota provider of the
 * model currently selected in the composer and shows that provider's pools as a
 * compact `5h 78% · 7d 40%` label (no provider name), falling back to the global
 * most severe provider when nothing is focused. Hovering opens {@link QuotaTips}
 * (the same provider plus a verdict line); clicking opens {@link QuotaPanel}
 * with every registered provider. The global `quota.showPanel` command opens the
 * same panel through {@link onQuotaPanelOpen}.
 */

const SEVERITY: Readonly<Record<QuotaLevel, number>> = { normal: 0, warning: 1, destructive: 2 };

/** Weakened copy shown when a focused provider's quota cannot be read. */
const FOCUS_UNAVAILABLE_SUFFIX = '额度不可用';

interface QuotaCandidate {
  provider: QuotaProviderSnapshot;
  window: QuotaWindowSnapshot;
  level: QuotaLevel;
}

/** Most severe window; ties go to the lowest remaining percentage. */
function selectWindow(providers: readonly QuotaProviderSnapshot[]): QuotaCandidate | null {
  let best: QuotaCandidate | null = null;
  for (const provider of providers) {
    for (const window of provider.windows) {
      if (!Number.isFinite(window.remainingPct)) continue;
      const candidate: QuotaCandidate = { provider, window, level: quotaPoolLevel(window) };
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

/** Focused-provider resolution for the composer's currently selected model. */
type FocusSelection =
  | { kind: 'none' }
  | { kind: 'window'; candidate: QuotaCandidate }
  | { kind: 'unavailable'; label: string };

/**
 * The focused provider's most tense window, or an `unavailable` result when the
 * provider is missing or its quota read failed. The catalog supplies the label
 * for a provider that has no quota snapshot at all.
 */
function selectFocused(
  providers: readonly QuotaProviderSnapshot[],
  catalog: readonly { id: string; label: string }[],
  focus: string,
): FocusSelection {
  const provider = providers.find((entry) => entry.id === focus);
  if (provider === undefined) {
    return { kind: 'unavailable', label: catalog.find((entry) => entry.id === focus)?.label ?? focus };
  }
  if (provider.status === 'error' || provider.status === 'unavailable') {
    return { kind: 'unavailable', label: provider.label || provider.id };
  }
  const candidate = selectWindow([provider]);
  if (candidate === null) return { kind: 'unavailable', label: provider.label || provider.id };
  return { kind: 'window', candidate };
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

export interface QuotaItemProps {
  /** Notified when the panel opens or closes (used to release a forced-visible slot). */
  onOpenChange?: (open: boolean) => void;
}

export function QuotaItem({ onOpenChange }: QuotaItemProps = {}) {
  const quota = useQuery(quotaQuery);
  const focus = useQuotaFocus();
  const [open, setOpen] = useState(false);
  const now = useMinuteNow();

  const candidates = useMemo(() => {
    const data = quota.data;
    if (data === undefined) return [] as QuotaProviderSnapshot[];
    return eligibleQuotaProviders(data);
  }, [quota.data]);

  const focused = useMemo<FocusSelection>(() => {
    const data = quota.data;
    if (focus === null || data === undefined) return { kind: 'none' };
    return selectFocused(data.providers, data.catalog, focus);
  }, [focus, quota.data]);

  const globalSelected = useMemo(() => selectWindow(candidates), [candidates]);

  // The provider whose pools both the label and the hover describe: the focused
  // one, else the global most-tight provider the label falls back to.
  const shown = useMemo<QuotaProviderSnapshot | null>(() => {
    const data = quota.data;
    if (data === undefined) return null;
    if (focus !== null) return data.providers.find((provider) => provider.id === focus) ?? null;
    return globalSelected?.provider ?? null;
  }, [quota.data, focus, globalSelected]);

  const unavailableLabel = focused.kind === 'unavailable' ? focused.label : null;

  useEffect(() => onQuotaPanelOpen(() => setOpen(true)), []);

  const windows = useMemo(
    () => (shown?.windows ?? []).filter((window) => Number.isFinite(window.remainingPct)),
    [shown],
  );
  const poolLevel: QuotaLevel = windows.some((window) => quotaPoolLevel(window) === 'destructive')
    ? 'destructive'
    : windows.some((window) => quotaPoolLevel(window) === 'warning')
      ? 'warning'
      : 'normal';

  const label = unavailableLabel !== null
    ? `${unavailableLabel} ${FOCUS_UNAVAILABLE_SUFFIX}`
    : windows.length === 0
      ? undefined
      : windows
          .map((window) => {
            const used = Math.max(0, Math.min(100, 100 - window.remainingPct));
            return `${shortWindowName(window.name, window.windowMinutes)} ${Math.floor(used)}%`;
          })
          .join(' · ');
  const tone = unavailableLabel === null ? levelTone(poolLevel) : 'default';

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <Tooltip>
          <TooltipTrigger render={<StatusBarButton icon={Gauge} label={label} tone={tone} ariaLabel="额度" />} />
          <TooltipContent side="top" align="end" className="w-72 max-w-none flex-col items-stretch gap-1.5 py-2">
            <QuotaTips providers={candidates} focusedProvider={shown?.id ?? null} now={now} surface="inverse" />
          </TooltipContent>
        </Tooltip>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[400px] p-0">
        <QuotaPanel />
      </PopoverContent>
    </Popover>
  );
}
