import { BrandIcon } from '@/renderer/components/brand-icon';
import { QuotaBar } from '@/renderer/components/usage/QuotaBar';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { useQuotaRefresh } from '@/renderer/lib/queries';
import { providerBrand } from '@/renderer/lib/model-brand';
import type { QuotaProviderSnapshot } from '@/shell-contract';
import { cn } from 'cn';

/**
 * One provider's quota block, shared by the status-bar quota panel and the
 * session usage panel (usage spec 6.1). It renders the name, status, every
 * window through the shared {@link QuotaBar}, balances, and a retry action for
 * a failed read. It never parses `displayLine` (usage spec 3.6): pace and reset
 * come only from the structured snapshot fields.
 */

type ProviderTone = 'success' | 'warning' | 'danger' | 'muted';

const DOT_CLASS: Record<ProviderTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground',
};

const RETRY_LABEL = '重试';
const NO_DATA_NOTE = '暂无可展示的额度数据。';
const BALANCE_LABEL = '余额';

/** Status-dot tone for a provider: failure, then stale, then idle statuses. */
function providerTone(provider: QuotaProviderSnapshot): { tone: ProviderTone; label: string } {
  if (provider.status === 'error') return { tone: 'danger', label: '失败' };
  if (provider.stale) return { tone: 'warning', label: '数据过期' };
  if (provider.status === 'ok') return { tone: 'success', label: '正常' };
  if (provider.status === 'pending') return { tone: 'muted', label: '读取中' };
  return { tone: 'muted', label: '不可用' };
}

export interface QuotaProviderBlockProps {
  provider: QuotaProviderSnapshot;
  /** Bar width in pixels: 96 in panels, 120 on the Model Supply page. */
  barWidth?: number;
  className?: string;
}

export function QuotaProviderBlock({ provider, barWidth = 96, className }: QuotaProviderBlockProps) {
  const refresh = useQuotaRefresh();
  const name = provider.label || provider.id;
  const view = providerTone(provider);
  const tooltip = provider.message ? `${view.label} · ${provider.message}` : view.label;
  const failed = provider.status === 'error' || provider.status === 'unavailable';
  const hasStructured = provider.windows.length > 0 || provider.balances.length > 0;

  return (
    <div className={cn('flex flex-col gap-1.5', provider.stale && 'opacity-60', className)} data-slot="quota-provider-block">
      <div className="flex items-center gap-2">
        <BrandIcon brand={providerBrand(provider.id)} />
        <span className="truncate font-medium">{name}{provider.stale ? '（数据过期）' : ''}</span>
        <Tooltip>
          <TooltipTrigger
            render={<span className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[view.tone])} />}
          />
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </div>

      {failed ? (
        <div className="flex flex-wrap items-center gap-2 pl-6 text-xs text-destructive">
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
        <div className="flex flex-col gap-1.5 pl-6">
          {provider.windows.map((window) => (
            <QuotaBar
              key={window.name}
              name={window.name}
              remainingPct={window.remainingPct}
              expectedRemainingPct={window.expectedRemainingPct}
              resetsAt={window.resetsAt}
              windowMinutes={window.windowMinutes}
              width={barWidth}
              stale={provider.stale}
            />
          ))}
          {provider.balances.map((balance) => (
            <span key={`${balance.currency}:${balance.display}`} className="flex items-baseline gap-1 text-xs">
              <span className="text-muted-foreground">{BALANCE_LABEL}</span>
              <strong className="tabular-nums">{balance.display}</strong>
            </span>
          ))}
          {!hasStructured && (
            <span className="text-xs text-muted-foreground">{provider.message ?? NO_DATA_NOTE}</span>
          )}
        </div>
      )}
    </div>
  );
}
