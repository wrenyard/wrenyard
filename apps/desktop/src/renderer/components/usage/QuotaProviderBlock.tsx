import { QuotaBar } from '@/renderer/components/usage/QuotaBar';
import { Button } from '@/renderer/components/ui/button';
import { useDisplayCurrency, useQuotaRefresh } from '@/renderer/lib/queries';
import { formatQuotaBalance, type QuotaProviderSnapshot } from '@/shell-contract';
import { cn } from 'cn';

/**
 * One provider's quota block, used by the status-bar quota panel (QuotaPanel)
 * (usage spec 6.1). It renders the name, status, every window through the
 * shared {@link QuotaBar}, balances, and a retry action for a failed read. It
 * never parses `displayLine` (usage spec 3.6): pace and reset come only from the
 * structured snapshot fields.
 */

const RETRY_LABEL = '重试';
const NO_DATA_NOTE = '暂无可展示的额度数据。';
const BALANCE_LABEL = '余额';

export interface QuotaProviderBlockProps {
  provider: QuotaProviderSnapshot;
  className?: string;
}

export function QuotaProviderBlock({ provider, className }: QuotaProviderBlockProps) {
  const refresh = useQuotaRefresh();
  const currency = useDisplayCurrency();
  const name = provider.label || provider.id;
  const failed = provider.status === 'error' || provider.status === 'unavailable';
  const hasStructured = provider.windows.length > 0 || provider.balances.length > 0;

  return (
    <div className={cn('flex flex-col gap-1.5', provider.stale && 'opacity-60', className)} data-slot="quota-provider-block">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm text-muted-foreground">{name}{provider.stale ? '（数据过期）' : ''}</span>
        {provider.plan ? (
          <span className="truncate text-xs text-muted-foreground">{provider.plan}</span>
        ) : null}
      </div>

      {failed ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{provider.message ?? NO_DATA_NOTE}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {RETRY_LABEL}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {provider.windows.map((window) => (
            <QuotaBar
              key={window.name}
              name={window.name}
              poolLabel={window.poolLabel}
              remainingPct={window.remainingPct}
              expectedRemainingPct={window.expectedRemainingPct}
              resetsAt={window.resetsAt}
              state={window.state}
              stale={provider.stale}
              compact
            />
          ))}
          {provider.balances.map((balance) => (
            <div
              key={`${balance.currency}:${balance.display}`}
              className="flex h-6 items-center gap-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{BALANCE_LABEL}</span>
              <span className="shrink-0 text-right tabular-nums">{formatQuotaBalance(balance, currency)}</span>
            </div>
          ))}
          {(provider.message || !hasStructured) && (
            <span className="text-xs text-muted-foreground">{provider.message ?? NO_DATA_NOTE}</span>
          )}
        </div>
      )}
    </div>
  );
}
