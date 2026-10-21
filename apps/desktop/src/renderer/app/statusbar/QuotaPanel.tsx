import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { UsageCardSkeletonBody } from '@/renderer/components/usage/UsageCard';
import { QuotaProviderBlock } from '@/renderer/components/usage/QuotaProviderBlock';
import { quotaQuery, useQuotaRefresh } from '@/renderer/lib/queries';
import type { ProviderOrderSnapshot, QuotaPoolState, QuotaProviderSnapshot } from '@/shell-contract';
import { cn } from 'cn';

/** Re-renders once a minute so the "更新于 …" stamp stays current. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function updatedAgo(refreshedAt: number | undefined, now: number): string {
  if (refreshedAt === undefined) return '';
  const minutes = Math.max(0, Math.round((now - refreshedAt) / 60_000));
  if (minutes <= 0) return '刚刚更新';
  if (minutes < 60) return `更新于 ${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return `更新于 ${hours} 小时前`;
}

/** Provider order first, then any provider the order does not mention. */
function orderProviders(
  providers: readonly QuotaProviderSnapshot[],
  order: readonly ProviderOrderSnapshot[],
): QuotaProviderSnapshot[] {
  const position = new Map<string, number>(
    order.map((entry, index) => [entry.id, index] as const),
  );
  return [...providers].sort(
    (a, b) =>
      (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

function isQuotaStateCritical(state?: QuotaPoolState): boolean {
  return state === 'insufficient' || state === 'exhausted';
}

function providerNeedsAttention(provider: QuotaProviderSnapshot, firstProviderId?: string): boolean {
  if (firstProviderId !== undefined && provider.id === firstProviderId) return true;
  if (provider.stale) return true;
  if (provider.status === 'error' || provider.status === 'unavailable') return true;
  if (provider.windows.some((window) => isQuotaStateCritical(window.state))) return true;
  if (provider.balances.some((balance) => isQuotaStateCritical(balance.state))) return true;
  return false;
}

function renderProviderRow(provider: QuotaProviderSnapshot) {
  return (
    <div key={provider.id} data-provider-id={provider.id}>
      <QuotaProviderBlock provider={provider} />
    </div>
  );
}

export interface QuotaPanelProps {
  /** Provider listed first, ahead of the user's own ordering (e.g. the selected model's provider). */
  firstProviderId?: string;
  /** Provider scrolled into view once after mount or when the target changes. */
  scrollProviderId?: string;
}

const QUOTA_READ_FAILED = '额度读取失败';
const RETRY_LABEL = '重试';

export function QuotaPanel({ firstProviderId, scrollProviderId }: QuotaPanelProps = {}) {
  const { data, isPending, isError, refetch, isFetching } = useQuery(quotaQuery);
  const providers = useMemo(() => {
    const ordered = orderProviders(data?.providers ?? [], data?.providerOrder ?? []);
    if (firstProviderId === undefined) return ordered;
    // The requested provider leads; the rest keep the user's own order.
    const index = ordered.findIndex((provider) => provider.id === firstProviderId);
    if (index <= 0) return ordered;
    return [ordered[index]!, ...ordered.slice(0, index), ...ordered.slice(index + 1)];
  }, [data, firstProviderId]);

  const { primary, others } = useMemo(() => {
    const attention = providers.filter((provider) => providerNeedsAttention(provider, firstProviderId));
    const primaryList = attention.length > 0 ? attention : providers.slice(0, 2);
    const primaryIds = new Set(primaryList.map((provider) => provider.id));
    const othersList = providers.filter((provider) => !primaryIds.has(provider.id));
    return { primary: primaryList, others: othersList };
  }, [providers, firstProviderId]);

  const othersPanelId = useId();
  const [othersExpanded, setOthersExpanded] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (scrollProviderId === undefined || scrollProviderId === scrolledRef.current) return;
    const targetInOthers = others.some((provider) => provider.id === scrollProviderId);
    if (targetInOthers && !othersExpanded) {
      setOthersExpanded(true);
      return;
    }
    const row = listRef.current?.querySelector(`[data-provider-id="${CSS.escape(scrollProviderId)}"]`);
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' });
      scrolledRef.current = scrollProviderId;
    }
  }, [scrollProviderId, providers, othersExpanded, others]);

  if (isPending && data === undefined) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-2.5">
        <UsageCardSkeletonBody />
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      {isError && data === undefined ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{QUOTA_READ_FAILED}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {RETRY_LABEL}
          </Button>
        </div>
      ) : providers.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">暂无额度数据</p>
      ) : (
        <div ref={listRef} className="flex flex-col gap-2.5">
          {primary.map((provider) => renderProviderRow(provider))}
          {others.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                className="flex h-6 w-full min-w-0 items-center gap-1.5 text-xs"
                aria-expanded={othersExpanded}
                aria-controls={othersPanelId}
                onClick={() => setOthersExpanded((open) => !open)}
              >
                <ChevronRight
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast',
                    othersExpanded && 'rotate-90',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-left">其他供应商</span>
                <span className="tabular-nums text-muted-foreground">{others.length}</span>
              </button>
              {othersExpanded ? (
                <div id={othersPanelId} className="flex flex-col gap-2.5">
                  {others.map((provider) => renderProviderRow(provider))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function QuotaCardActions() {
  const quota = useQuery(quotaQuery);
  const refresh = useQuotaRefresh();
  const now = useMinuteNow();
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{updatedAgo(quota.data?.refreshedAt, now)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="刷新额度"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate()}
      >
        <RotateCw className={cn(refresh.isPending && 'animate-spin')} />
      </Button>
    </div>
  );
}
