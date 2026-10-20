import { useMemo } from 'react';
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
import type { GatewayHealthRoute, GatewayHealthWindow, WrenyardGatewayHealthResult } from '@/shell-contract';
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
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {formatWindowCounts(route.last1h)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      <div>{formatWindowCounts(route.last24h)}</div>
                      {sumFailures(route.last24h) > 0 && (
                        <div className="text-xs text-muted-foreground">{formatFailureDetail(route.last24h)}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {formatMedianMs(route.last24h.medianFirstResponseMs)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {formatMedianTps(route.last24h.medianTps)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatLastSuccess(route.last24h.lastSuccessAt)}
                    </TableCell>
                    <TableCell className="max-w-48 text-xs break-words">
                      {formatLastFailure(route.last24h)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        );
      })}
      {query.isFetching && (
        <p className="text-xs text-muted-foreground">正在刷新…</p>
      )}
    </section>
  );
}
