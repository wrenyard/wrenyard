import { useEffect, useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/components/ui/hover-card';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import type { StatusBarTone } from '@/renderer/components/status-bar-button';
import {
  formatWindowName,
  paceView,
  quotaLevel,
} from '@/renderer/components/usage/QuotaBar';
import type { QuotaLevel } from '@/renderer/components/usage/QuotaBar';
import { QuotaTips } from '@/renderer/components/usage/QuotaTips';
import { onQuotaPanelOpen, useQuotaFocus } from '@/renderer/lib/statusbar';
import { quotaQuery } from '@/renderer/lib/queries';
import { QuotaPanel } from '@/renderer/app/statusbar/QuotaPanel';
import type { QuotaProviderSnapshot, QuotaWindowSnapshot } from '@/shell-contract';

/**
 * Status-bar quota item (usage spec 6.2). It focuses the quota provider of the
 * model currently selected in the composer and shows that provider's most tense
 * window, falling back to the global most severe window when nothing is
 * focused. Hovering opens {@link QuotaTips}; clicking opens {@link QuotaPanel}.
 * The global `quota.showPanel` command opens the same panel through
 * {@link onQuotaPanelOpen}.
 */

const SEVERITY: Readonly<Record<QuotaLevel, number>> = { normal: 0, warning: 1, destructive: 2 };

const LEVEL_TONE: Readonly<Record<QuotaLevel, StatusBarTone>> = {
  normal: 'default',
  warning: 'warning',
  destructive: 'destructive',
};

/** Weakened copy shown when a focused provider's quota cannot be read. */
const FOCUS_UNAVAILABLE_SUFFIX = '额度不可用';

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
    if (data.providerOrder.length === 0) return data.providers;
    const enabled = new Set(
      data.providerOrder.filter((entry) => entry.enabled).map((entry) => entry.id),
    );
    return data.providers.filter((provider) => enabled.has(provider.id));
  }, [quota.data]);

  const focused = useMemo<FocusSelection>(() => {
    const data = quota.data;
    if (focus === null || data === undefined) return { kind: 'none' };
    return selectFocused(data.providers, data.catalog, focus);
  }, [focus, quota.data]);

  const globalSelected = useMemo(() => selectWindow(candidates), [candidates]);

  const selected = focus === null
    ? globalSelected
    : focused.kind === 'window'
      ? focused.candidate
      : null;
  const unavailableLabel = focused.kind === 'unavailable' ? focused.label : null;

  useEffect(() => onQuotaPanelOpen(() => setOpen(true)), []);

  const label = unavailableLabel !== null
    ? `${unavailableLabel} ${FOCUS_UNAVAILABLE_SUFFIX}`
    : selected === null
      ? undefined
      : `${selected.provider.label || selected.provider.id} ${formatWindowName(
          selected.window.name,
          selected.window.windowMinutes,
        )} ${Math.floor(selected.window.remainingPct)}%`;
  const tone: StatusBarTone = unavailableLabel === null && selected !== null
    ? LEVEL_TONE[selected.level]
    : 'default';

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <HoverCard>
          <HoverCardTrigger render={<span className="inline-flex" />}>
            <StatusBarButton icon={Gauge} label={label} tone={tone} ariaLabel="额度" />
          </HoverCardTrigger>
          <HoverCardContent side="top" align="end" className="w-80 p-2">
            <QuotaTips providers={candidates} focusedProvider={focus} now={now} />
          </HoverCardContent>
        </HoverCard>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[400px] p-0">
        <QuotaPanel />
      </PopoverContent>
    </Popover>
  );
}
