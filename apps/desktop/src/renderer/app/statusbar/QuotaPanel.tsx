import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Separator } from '@/renderer/components/ui/separator';
import { QuotaProviderBlock } from '@/renderer/components/usage/QuotaProviderBlock';
import { PanelFooterAction } from '@/renderer/components/panel-footer-action';
import { executeCommand } from '@/renderer/lib/commands';
import { quotaQuery, useQuotaRefresh } from '@/renderer/lib/queries';
import type { ProviderOrderSnapshot, QuotaProviderSnapshot } from '@/shell-contract';
import { cn } from 'cn';

/**
 * Status-bar quota panel (usage spec 6.3). Rendered inside the quota item's
 * popover: a header with the last refresh time and a manual refresh, the
 * provider blocks in the user's order, and a jump to the 供应商 settings page.
 */

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

export interface QuotaPanelProps {
  /** Closes the hosting popover after a jump into the 供应商 settings page. */
  onClose?: () => void;
  /** Provider listed first, ahead of the user's own ordering (e.g. the selected model's provider). */
  firstProviderId?: string;
  /** Provider scrolled into view once after mount or when the target changes. */
  scrollProviderId?: string;
}

export function QuotaPanel({ onClose, firstProviderId, scrollProviderId }: QuotaPanelProps = {}) {
  const quota = useQuery(quotaQuery);
  const refresh = useQuotaRefresh();
  const now = useMinuteNow();
  const data = quota.data;
  const providers = useMemo(() => {
    const ordered = orderProviders(data?.providers ?? [], data?.providerOrder ?? []);
    if (firstProviderId === undefined) return ordered;
    // The requested provider leads; the rest keep the user's own order.
    const index = ordered.findIndex((provider) => provider.id === firstProviderId);
    if (index <= 0) return ordered;
    return [ordered[index]!, ...ordered.slice(0, index), ...ordered.slice(index + 1)];
  }, [data, firstProviderId]);
  // One-shot scroll target: each provider row carries a `data-provider-id`, and
  // the matching row is scrolled into view once per requested id.
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (scrollProviderId === undefined || scrollProviderId === scrolledRef.current) return;
    const row = listRef.current?.querySelector(`[data-provider-id="${CSS.escape(scrollProviderId)}"]`);
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' });
      scrolledRef.current = scrollProviderId;
    }
  }, [scrollProviderId, providers]);

  return (
    <div className="flex max-h-[560px] w-full min-w-0 flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-sm font-medium">额度</span>
        <span className="text-xs text-muted-foreground">{updatedAgo(data?.refreshedAt, now)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="刷新额度"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RotateCw className={cn(refresh.isPending && 'animate-spin')} />
        </Button>
      </div>
      <Separator />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {providers.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">暂无额度数据</p>
        ) : (
          <div ref={listRef} className="flex flex-col gap-3 px-4 py-3">
            {providers.map((provider) => (
              <div key={provider.id} data-provider-id={provider.id}>
                <QuotaProviderBlock provider={provider} />
              </div>
            ))}
          </div>
        )}
      </div>
      <Separator />
      <PanelFooterAction
        label="打开用量设置"
        onClick={() => {
          onClose?.();
          executeCommand('settings.open', 'providers');
        }}
      />
    </div>
  );
}
