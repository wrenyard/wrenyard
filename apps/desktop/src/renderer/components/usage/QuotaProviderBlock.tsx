import { BrandIcon } from '@/renderer/components/brand-icon';
import { QuotaBar, QUOTA_POOL_STATE_LABEL, quotaPoolStateTone } from '@/renderer/components/usage/QuotaBar';
import { Button } from '@/renderer/components/ui/button';
import { useDisplayCurrency, useQuotaRefresh } from '@/renderer/lib/queries';
import { providerBrand } from '@/renderer/lib/model-brand';
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
        <BrandIcon brand={providerBrand(provider.id)} />
        <span className="truncate font-medium">{name}{provider.stale ? '（数据过期）' : ''}</span>
        {provider.plan ? (
          <span className="truncate text-xs text-muted-foreground">{provider.plan}</span>
        ) : null}
      </div>

      {failed ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
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
            <span key={`${balance.currency}:${balance.display}`} className="flex items-baseline gap-1 text-xs">
              <span className="text-muted-foreground">{BALANCE_LABEL}</span>
              <strong className="tabular-nums">{formatQuotaBalance(balance, currency)}</strong>
              {balance.state !== undefined && (
                <span className={cn(quotaPoolStateTone(balance.state) ?? 'text-muted-foreground')}>
                  {QUOTA_POOL_STATE_LABEL[balance.state]}
                </span>
              )}
            </span>
          ))}
          {(provider.message || !hasStructured) && (
            <span className="text-xs text-muted-foreground">{provider.message ?? NO_DATA_NOTE}</span>
          )}
        </div>
      )}
    </div>
  );
}
