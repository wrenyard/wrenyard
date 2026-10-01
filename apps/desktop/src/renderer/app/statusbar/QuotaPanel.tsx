import { useEffect, useMemo, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Separator } from '@/renderer/components/ui/separator';
import { QuotaProviderBlock } from '@/renderer/components/usage/QuotaProviderBlock';
import { shell } from '@/renderer/lib/desktop';
import { quotaQuery, useQuotaRefresh } from '@/renderer/lib/queries';
import type { ProviderOrderSnapshot, QuotaProviderSnapshot } from '@/shell-contract';
import { cn } from 'cn';

/**
 * Status-bar quota panel (usage spec 6.3). Rendered inside the quota item's
 * popover: a header with the last refresh time and a manual refresh, the
 * provider blocks in the user's order, and a jump to the Model Supply page.
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

export function QuotaPanel() {
  const quota = useQuery(quotaQuery);
  const refresh = useQuotaRefresh();
  const now = useMinuteNow();
  const data = quota.data;
  const providers = useMemo(
    () => orderProviders(data?.providers ?? [], data?.providerOrder ?? []),
    [data],
  );

  return (
    <div className="flex max-h-[560px] w-[400px] flex-col">
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
          <div className="flex flex-col gap-3 px-4 py-3">
            {providers.map((provider) => (
              <QuotaProviderBlock key={provider.id} provider={provider} />
            ))}
          </div>
        )}
      </div>
      <Separator />
      <div className="p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => void shell.navigate('quota')}
        >
          打开模型供应页
        </Button>
      </div>
    </div>
  );
}
