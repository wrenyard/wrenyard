import { BrandIcon } from '@/renderer/components/brand-icon';
import { QueryError } from '@/renderer/components/query-error';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { QuotaBar } from '@/renderer/components/usage/QuotaBar';
import { providerBrand } from '@/renderer/lib/model-brand';
import { useQuotaQuery } from '@/renderer/lib/queries';
import { reorderProviders } from '@/provider-order';
import type { ProviderCatalogSnapshot, QuotaSnapshot } from '@/shell-contract';
import { BALANCE_LABEL } from '../model/describe.js';

/**
 * The 供应商 page's quota detail, merged in from the former standalone 用量 page:
 * one card per activated provider, in the saved provider order, in the style of
 * the reference app's settings usage view. Every quota window renders through
 * the shared {@link QuotaBar} (window label, full-width bar, floored remaining
 * text and the reset countdown) and every balance renders as a bare label +
 * amount. A read failure stays visible on the card instead of hiding the
 * provider.
 */

function providerStatus(entry: ProviderCatalogSnapshot): string {
  const quota = entry.quota;
  if (quota === undefined) return '此供应商暂不提供额度查询';
  if (quota.status === 'error' || quota.status === 'unavailable') {
    return quota.message ? `读取失败 · ${quota.message}` : '读取失败';
  }
  if (quota.status === 'pending') return '读取中';
  return '已连接';
}

export function ProviderUsage() {
  const quota = useQuotaQuery();

  if (quota.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (quota.isError || quota.data === undefined) {
    return <QueryError query={quota} title="供应数据暂不可用" />;
  }

  return <ProviderUsageCards snapshot={quota.data} />;
}

function ProviderUsageCards({ snapshot }: { snapshot: QuotaSnapshot }) {
  const catalog = snapshot.catalog;
  const orderIds = reorderProviders(snapshot.providerOrder ?? [], catalog.map((entry) => entry.id))
    .map((entry) => entry.id);
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const activated = orderIds
    .map((id) => byId.get(id))
    .filter((entry): entry is ProviderCatalogSnapshot => entry !== undefined && entry.configured);

  return (
    <div className="flex flex-col gap-3">
      {activated.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有已激活的供应商。</p>
      ) : (
        activated.map((entry) => <ProviderUsageCard key={entry.id} entry={entry} />)
      )}
    </div>
  );
}

function ProviderUsageCard({ entry }: { entry: ProviderCatalogSnapshot }) {
  const quota = entry.quota;
  const hasDetail = quota !== undefined && (quota.windows.length > 0 || quota.balances.length > 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <BrandIcon brand={providerBrand(entry.id)} />
        <span className="truncate font-medium">{entry.label || entry.id}</span>
        <span className="truncate text-xs text-muted-foreground">{providerStatus(entry)}</span>
      </div>
      {hasDetail && (
        <div className="flex flex-col gap-3">
          {quota.windows.map((window) => (
            <QuotaBar
              key={window.name}
              name={window.name}
              poolLabel={window.poolLabel}
              remainingPct={window.remainingPct}
              expectedRemainingPct={window.expectedRemainingPct}
              resetsAt={window.resetsAt}
              stale={quota.stale}
            />
          ))}
          {quota.balances.map((balance) => (
            <span
              key={`${balance.currency}:${balance.display}`}
              className="flex items-baseline gap-1 text-sm"
            >
              <span className="text-muted-foreground">{BALANCE_LABEL}</span>
              <strong className="tabular-nums">{balance.display}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
