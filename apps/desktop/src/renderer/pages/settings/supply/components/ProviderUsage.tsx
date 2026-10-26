import { BrandIcon } from '@/renderer/components/brand-icon';
import { QueryError } from '@/renderer/components/query-error';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import {
  isUsageUnknown,
  QuotaBar,
  unknownUsageNote,
} from '@/renderer/components/usage/QuotaBar';
import { QuotaBalanceRow } from '@/renderer/components/usage/QuotaBalanceRow';
import { providerBrand } from '@/renderer/lib/model-brand';
import { useDisplayCurrency, useQuotaQuery } from '@/renderer/lib/queries';
import { reorderProviders } from '@/provider-order';
import { formatQuotaBalance, type ProviderCatalogSnapshot, type QuotaSnapshot } from '@/shell-contract';
import { QUOTA_EVIDENCE_GRACE_MS } from '@wrenyard/auto-routing/constants';
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

/**
 * Copy for a failed quota read. While the last successful measurement is inside
 * the evidence grace the stale numbers are still shown, so the note says how
 * old they are; after the grace — or with no usable measurement — the plain
 * failure stands.
 */
function readFailureNote(quota: NonNullable<ProviderCatalogSnapshot['quota']>, now: number): string {
  const lastSuccessAt = quota.lastSuccessAt;
  const age = typeof lastSuccessAt === 'number' && Number.isFinite(lastSuccessAt) && lastSuccessAt <= now
    ? now - lastSuccessAt
    : null;
  if (age !== null && age <= QUOTA_EVIDENCE_GRACE_MS) {
    return `读取失败，沿用 ${Math.max(1, Math.round(age / 60_000))} 分钟前的数据`;
  }
  return quota.message ? `读取失败 · ${quota.message}` : '读取失败';
}

function providerStatus(entry: ProviderCatalogSnapshot, now: number): string | null {
  const quota = entry.quota;
  if (quota === undefined) return '此供应商暂不提供额度查询';
  if (quota.status === 'error' || quota.status === 'unavailable') return readFailureNote(quota, now);
  if (quota.status === 'pending') return '读取中';
  return null;
}

export function ProviderUsage() {
  const quota = useQuotaQuery();
  const currency = useDisplayCurrency();

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

  return <ProviderUsageCards snapshot={quota.data} currency={currency} />;
}

function ProviderUsageCards({ snapshot, currency }: { snapshot: QuotaSnapshot; currency: 'CNY' | 'USD' }) {
  const catalog = snapshot.catalog;
  const orderIds = reorderProviders(snapshot.providerOrder ?? [], catalog.map((entry) => entry.id))
    .map((entry) => entry.id);
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const activated = orderIds
    .map((id) => byId.get(id))
    .filter((entry): entry is ProviderCatalogSnapshot => entry !== undefined && entry.configured);

  const now = Date.now();
  return (
    <div className="flex flex-col gap-3">
      {activated.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有已激活的供应商。</p>
      ) : (
        activated.map((entry) => <ProviderUsageCard key={entry.id} entry={entry} now={now} currency={currency} />)
      )}
    </div>
  );
}

function ProviderUsageCard({ entry, now, currency }: { entry: ProviderCatalogSnapshot; now: number; currency: 'CNY' | 'USD' }) {
  const quota = entry.quota;
  const hasDetail = quota !== undefined && (quota.windows.length > 0 || quota.balances.length > 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <BrandIcon brand={providerBrand(entry.id)} />
        <span className="truncate font-medium">{entry.label || entry.id}</span>
        <span className="truncate text-xs text-muted-foreground">{providerStatus(entry, now) ?? quota?.plan ?? null}</span>
      </div>
      {quota !== undefined && isUsageUnknown(quota) && (
        <span className="text-xs text-muted-foreground">{unknownUsageNote(quota.message)}</span>
      )}
      {hasDetail && (
        <div className="flex flex-col gap-3">
          {quota.windows.map((window) => {
            const spend = quota.estimatedSpend?.find((entry) => entry.window === window.name);
            return (
              <div key={window.name} className="flex flex-col gap-1">
                <QuotaBar
                  name={window.name}
                  poolLabel={window.poolLabel}
                  remainingPct={window.remainingPct}
                  expectedRemainingPct={window.expectedRemainingPct}
                  resetsAt={window.resetsAt}
                  state={window.state}
                  stale={quota.stale}
                />
                {spend !== undefined && (
                  <span className="text-sm tabular-nums text-muted-foreground">
                    预估 ${spend.totalUsd.toFixed(2)}
                    {Object.entries(spend.models).map(([modelId, usd]) => ` · ${modelId} $${usd.toFixed(2)}`)}
                  </span>
                )}
              </div>
            );
          })}
          {quota.balances.map((balance) => (
            <QuotaBalanceRow
              key={`${balance.id ?? balance.currency}:${balance.display}`}
              label={BALANCE_LABEL}
              amount={formatQuotaBalance(balance, currency)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
