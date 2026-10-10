import { useMemo } from 'react';
import { QuotaBar, quotaVerdict, type QuotaVerdict } from '@/renderer/components/usage/QuotaBar';
import type { QuotaProviderSnapshot } from '@/shell-contract';
import { cn } from 'cn';

/**
 * Quota hover-tips card (usage spec 6.2). It shows a single provider — the
 * focused one, or the same provider the status-bar label falls back to — with a
 * one-line verdict followed by each window as a {@link QuotaBar} row and its
 * balances. The component is pure props (provider snapshots, the focused
 * provider id and the current time) so it never reads a query or the shell and
 * the Pet house card can reuse it directly.
 */

const PROVIDER_FAILED_LABEL = '额度不可用';
const NO_DATA_LABEL = '暂无额度数据';
const BALANCE_LABEL = '余额';

export interface QuotaTipsProps {
  /** Provider snapshots to display; only the focused one is shown. */
  providers: readonly QuotaProviderSnapshot[];
  /** Provider id of the composer's current model, else the label's fallback. */
  focusedProvider?: string | null;
  /** Current time in ms, injected so the reset countdown stays deterministic. */
  now: number;
  /**
   * Presentation surface. `card` (default) is the light panel/card with its own
   * width, padding and muted text; `inverse` is the compact variant for the dark
   * status-bar tooltip, which supplies its own width and padding.
   */
  surface?: 'card' | 'inverse';
  className?: string;
}

/** Top-of-card verdict line: label plus a short muted reason. */
function VerdictLine({ verdict, inverse }: { verdict: QuotaVerdict; inverse: boolean }) {
  const tone = verdict.level === 'insufficient'
    ? 'text-destructive'
    : verdict.level === 'tight'
      ? 'text-warning'
      : 'text-success';
  return (
    <div className="flex items-baseline gap-1.5" data-slot="quota-verdict">
      <span className={cn('font-medium', tone)}>{verdict.label}</span>
      {verdict.reason !== undefined && (
        <span className={inverse ? 'text-background/60' : 'text-muted-foreground'}>· {verdict.reason}</span>
      )}
    </div>
  );
}

function ProviderTips({ provider, now, inverse }: {
  provider: QuotaProviderSnapshot;
  now: number;
  inverse: boolean;
}) {
  const name = provider.label || provider.id;
  const failed = provider.status === 'error' || provider.status === 'unavailable';
  const empty = provider.windows.length === 0 && provider.balances.length === 0;
  const muted = inverse ? 'text-background/60' : 'text-muted-foreground';

  return (
    <div className="flex flex-col gap-1.5" data-slot="quota-tips-provider">
      <span className={cn('truncate font-medium', failed && muted)}>
        {name}{provider.stale ? '（数据过期）' : ''}
      </span>
      {failed ? (
        <span className={muted}>{provider.message ?? PROVIDER_FAILED_LABEL}</span>
      ) : empty ? (
        <span className={muted}>{provider.message ?? NO_DATA_LABEL}</span>
      ) : (
        <>
          {provider.windows.map((window) => (
            <QuotaBar
              key={window.name}
              name={window.name}
              remainingPct={window.remainingPct}
              expectedRemainingPct={window.expectedRemainingPct}
              resetsAt={window.resetsAt}
              windowMinutes={window.windowMinutes}
              stale={provider.stale}
              now={now}
              surface={inverse ? 'inverse' : 'card'}
            />
          ))}
          {provider.balances.map((balance) => (
            <span key={`${balance.currency}:${balance.display}`} className="flex items-baseline gap-1">
              <span className={muted}>{BALANCE_LABEL}</span>
              <strong className="tabular-nums">{balance.display}</strong>
            </span>
          ))}
        </>
      )}
    </div>
  );
}

export function QuotaTips({
  providers,
  focusedProvider = null,
  now,
  surface = 'card',
  className,
}: QuotaTipsProps) {
  const inverse = surface === 'inverse';
  const provider = useMemo(() => {
    if (focusedProvider !== null) {
      return providers.find((entry) => entry.id === focusedProvider) ?? providers[0] ?? null;
    }
    return providers[0] ?? null;
  }, [providers, focusedProvider]);

  if (provider === null) {
    return (
      <p
        className={cn('text-xs', inverse ? 'text-background/60' : 'p-3 text-muted-foreground', className)}
        data-slot="quota-tips"
      >
        {NO_DATA_LABEL}
      </p>
    );
  }

  const failed = provider.status === 'error' || provider.status === 'unavailable';

  return (
    <div
      className={cn(
        'flex flex-col text-xs tabular-nums',
        inverse ? 'gap-1.5' : 'w-80 gap-2 p-3',
        className,
      )}
      data-slot="quota-tips"
    >
      {!failed && <VerdictLine verdict={quotaVerdict(provider.windows)} inverse={inverse} />}
      <ProviderTips provider={provider} now={now} inverse={inverse} />
    </div>
  );
}
