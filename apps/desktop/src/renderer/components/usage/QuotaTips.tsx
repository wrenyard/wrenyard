import { useMemo } from 'react';
import { QuotaBar } from '@/renderer/components/usage/QuotaBar';
import type { QuotaProviderSnapshot } from '@/shell-contract';
import { cn } from 'cn';

/**
 * Quota hover-tips card (usage spec 6.2). It renders every enabled provider
 * grouped in one compact ~320px card: the focused provider first and
 * highlighted, then each window as a {@link QuotaBar} row (name, thin bar with
 * pace marker, remaining percentage, pace and reset), with balances on their
 * own rows.
 *
 * The component is pure props — provider snapshots, the focused provider id and
 * the current time — so it never reads a query or the shell and the Pet house
 * card can reuse it directly.
 */

const PROVIDER_FAILED_LABEL = '额度不可用';
const NO_DATA_LABEL = '暂无额度数据';
const BALANCE_LABEL = '余额';

export interface QuotaTipsProps {
  /** Enabled provider snapshots to display, in the caller's order. */
  providers: readonly QuotaProviderSnapshot[];
  /** Provider id of the composer's current model; ordered first and highlighted. */
  focusedProvider?: string | null;
  /** Current time in ms, injected so the reset countdown stays deterministic. */
  now: number;
  className?: string;
}

/** Focused provider first, then the remaining providers in their given order. */
function orderProviders(
  providers: readonly QuotaProviderSnapshot[],
  focusedProvider: string | null,
): QuotaProviderSnapshot[] {
  if (focusedProvider === null) return [...providers];
  const focused = providers.find((provider) => provider.id === focusedProvider);
  if (focused === undefined) return [...providers];
  return [focused, ...providers.filter((provider) => provider.id !== focusedProvider)];
}

function ProviderTips({ provider, now, focused }: {
  provider: QuotaProviderSnapshot;
  now: number;
  focused: boolean;
}) {
  const name = provider.label || provider.id;
  const failed = provider.status === 'error' || provider.status === 'unavailable';
  const empty = provider.windows.length === 0 && provider.balances.length === 0;

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg px-2 py-1.5',
        focused && 'bg-muted',
      )}
      data-slot="quota-tips-provider"
      data-focused={focused ? 'true' : undefined}
    >
      <span className={cn('truncate font-medium', failed && 'text-muted-foreground')}>
        {name}{provider.stale ? '（数据过期）' : ''}
      </span>
      {failed ? (
        <span className="text-muted-foreground">{provider.message ?? PROVIDER_FAILED_LABEL}</span>
      ) : empty ? (
        <span className="text-muted-foreground">{provider.message ?? NO_DATA_LABEL}</span>
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
              stacked
              now={now}
            />
          ))}
          {provider.balances.map((balance) => (
            <span key={`${balance.currency}:${balance.display}`} className="flex items-baseline gap-1">
              <span className="text-muted-foreground">{BALANCE_LABEL}</span>
              <strong className="tabular-nums">{balance.display}</strong>
            </span>
          ))}
        </>
      )}
    </div>
  );
}

export function QuotaTips({ providers, focusedProvider = null, now, className }: QuotaTipsProps) {
  const ordered = useMemo(
    () => orderProviders(providers, focusedProvider),
    [providers, focusedProvider],
  );

  if (ordered.length === 0) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)} data-slot="quota-tips">
        {NO_DATA_LABEL}
      </p>
    );
  }

  return (
    <div
      className={cn('flex w-80 flex-col gap-2 text-xs tabular-nums', className)}
      data-slot="quota-tips"
    >
      {ordered.map((provider) => (
        <ProviderTips
          key={provider.id}
          provider={provider}
          now={now}
          focused={provider.id === focusedProvider}
        />
      ))}
    </div>
  );
}
