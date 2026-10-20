import { useMemo, type ReactNode } from 'react';
import { QueryError } from '@/renderer/components/query-error';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/renderer/components/ui/table';
import type {
  GatewayHealthPool,
  GatewayHealthProvider,
  GatewayHealthRoute,
  GatewayHealthWindow,
  WrenyardGatewayHealthResult,
} from '@/shell-contract';
import { formatDateTime } from '@/renderer/lib/format';
import { useGatewayHealthQuery } from '../queries.js';

const EMPTY_LABEL = '暂无最近 24 小时流量';
const LOAD_ERROR_TITLE = '网关健康数据暂不可用';
const SECTION_TITLE = '路由健康（只读）';

function sumFailures(window: GatewayHealthWindow): number {
  return Object.values(window.failures).reduce((total, count) => total + count, 0);
}

function formatWindowCounts(window: GatewayHealthWindow): string {
  const failures = sumFailures(window);
  return `${window.requests}·${window.successes}·${failures}`;
}

function formatFailureDetail(window: GatewayHealthWindow): string {
  const parts = Object.entries(window.failures)
    .filter(([, count]) => count > 0)
    .map(([className, count]) => `${className} ${count}`);
  if (parts.length === 0) return '—';
  return parts.join('、');
}

function formatMedianMs(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

function formatMedianTps(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)} t/s`;
}

function formatLastSuccess(at?: string): string {
  if (at === undefined || at === '') return '—';
  return formatDateTime(at);
}

function formatLastFailure(window: GatewayHealthWindow): string {
  const last = window.lastFailure;
  if (last === undefined) return '—';
  return `${formatDateTime(last.at)} ${last.class}${last.reason !== '' ? `：${last.reason}` : ''}`;
}

function groupRoutesByProvider(routes: GatewayHealthRoute[]): Map<string, GatewayHealthRoute[]> {
  const groups = new Map<string, GatewayHealthRoute[]>();
  for (const route of routes) {
    const list = groups.get(route.provider);
    if (list === undefined) groups.set(route.provider, [route]);
    else list.push(route);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.model.localeCompare(b.model));
  }
  return groups;
}

function hasRecentTraffic(result: WrenyardGatewayHealthResult): boolean {
  return result.routes.some((route) => route.last24h.requests > 0);
}

function providerTotal(
  providers: GatewayHealthProvider[] | undefined,
  provider: string,
): GatewayHealthProvider | undefined {
  return providers?.find((entry) => entry.provider === provider);
}

function renderWindowRowCells(window1h: GatewayHealthWindow, window24h: GatewayHealthWindow): ReactNode {
  return (
    <>
      <TableCell className="text-right tabular-nums whitespace-nowrap">
        {formatWindowCounts(window1h)}
      </TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">
        <div>{formatWindowCounts(window24h)}</div>
        {sumFailures(window24h) > 0 && (
          <div className="text-xs text-muted-foreground">{formatFailureDetail(window24h)}</div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">
        {formatMedianMs(window24h.medianFirstResponseMs)}
      </TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">
        {formatMedianTps(window24h.medianTps)}
      </TableCell>
      <TableCell className="text-xs whitespace-nowrap">
        {formatLastSuccess(window24h.lastSuccessAt)}
      </TableCell>
      <TableCell className="max-w-48 text-xs break-words">
        {formatLastFailure(window24h)}
      </TableCell>
    </>
  );
}

export interface GatewayHealthProps {
  /** True while the gateway supply tab is visible. */
  active: boolean;
}

/**
 * Read-only per-provider gateway health tables. Data comes from the daemon's
 * passive `gateway.health` snapshot; this panel never writes settings.
 */
export function GatewayHealth({ active }: GatewayHealthProps) {
  const query = useGatewayHealthQuery(active);
  const grouped = useMemo(
    () => groupRoutesByProvider(query.data?.routes ?? []),
    [query.data?.routes],
  );

  if (query.isPending && query.data === undefined) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{SECTION_TITLE}</h3>
        <div className="overflow-hidden rounded-xl border bg-card p-4">
          <Skeleton className="h-24 w-full" />
        </div>
      </section>
    );
  }

  if (query.isError && query.data === undefined) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{SECTION_TITLE}</h3>
        <QueryError query={query} title={LOAD_ERROR_TITLE} />
      </section>
    );
  }

  const snapshot = query.data;
  if (snapshot === undefined || !hasRecentTraffic(snapshot)) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{SECTION_TITLE}</h3>
        <p className="text-sm text-muted-foreground">{EMPTY_LABEL}</p>
      </section>
    );
  }

  const providers = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const poolEntries = (snapshot.pools ?? []).filter((entry) => entry.last24h.requests > 0);

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-muted-foreground">{SECTION_TITLE}</h3>
      {providers.map((provider) => {
        const routes = (grouped.get(provider) ?? []).filter((route) => route.last24h.requests > 0);
        if (routes.length === 0) return null;
        return (
          <div key={provider} className="flex flex-col gap-2 overflow-hidden rounded-xl border bg-card">
            <p className="border-b px-4 py-2 text-sm font-medium">{provider}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>路由</TableHead>
                  <TableHead className="text-right">最近 1 小时（请求·成功·失败）</TableHead>
                  <TableHead className="text-right">最近 24 小时（请求·成功·失败）</TableHead>
                  <TableHead className="text-right">中位首响应</TableHead>
                  <TableHead className="text-right">中位速度</TableHead>
                  <TableHead>最近成功</TableHead>
                  <TableHead>最近失败</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((route) => (
                  <TableRow key={`${route.provider}/${route.model}`}>
                    <TableCell className="font-mono text-xs">{route.model}</TableCell>
                    {renderWindowRowCells(route.last1h, route.last24h)}
                  </TableRow>
                ))}
                {(() => {
                  const total = providerTotal(snapshot.providers, provider);
                  if (total === undefined || total.last24h.requests === 0) return null;
                  return (
                    <TableRow className="bg-muted/40 font-medium">
                      <TableCell>合计</TableCell>
                      {renderWindowRowCells(total.last1h, total.last24h)}
                    </TableRow>
                  );
                })()}
              </TableBody>
            </Table>
          </div>
        );
      })}
      {poolEntries.length > 0 && (
        <div className="flex flex-col gap-2 overflow-hidden rounded-xl border bg-card">
          <p className="border-b px-4 py-2 text-sm font-medium">额度池汇总</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>池</TableHead>
                <TableHead className="text-right">最近 1 小时</TableHead>
                <TableHead className="text-right">最近 24 小时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {poolEntries
                .sort((a, b) => a.provider.localeCompare(b.provider) || a.pool.localeCompare(b.pool))
                .map((entry: GatewayHealthPool) => (
                  <TableRow key={`${entry.provider}/${entry.pool}`}>
                    <TableCell className="font-mono text-xs">{entry.pool}</TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {formatWindowCounts(entry.last1h)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      <div>{formatWindowCounts(entry.last24h)}</div>
                      {sumFailures(entry.last24h) > 0 && (
                        <div className="text-xs text-muted-foreground">{formatFailureDetail(entry.last24h)}</div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      )}
      {query.isFetching && (
        <p className="text-xs text-muted-foreground">正在刷新…</p>
      )}
    </section>
  );
}
