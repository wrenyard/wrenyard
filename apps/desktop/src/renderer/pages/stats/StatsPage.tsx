import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Page,
  PageActions,
  PageContent,
  PageDescription,
  PageHeader,
  PageTitle,
} from '@/renderer/components/page';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/components/ui/alert';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { formatSnapshotStamp } from '@/renderer/lib/format';
import { dropTaskUsageLive, useTaskUsageLiveExecutions } from '@/renderer/lib/task-usage-live';
import type { StatsPeriod } from '@/shell-contract';
import { ActivityHeatmap } from './components/ActivityHeatmap.js';
import { MetricCards } from './components/MetricCards.js';
import { ProfileTable } from './components/ProfileTable.js';
import { TaskInvestmentTable } from './components/TaskInvestmentTable.js';
import { TaskRunsTable, type TaskRunKindFilter } from './components/TaskRunsTable.js';
import {
  PAGE_TITLE,
  PERIOD_OPTIONS,
  STATS_RETRY_LABEL,
  STATS_STALE_RETRY_LABEL,
  STATS_STALE_TITLE,
  STATS_UNAVAILABLE_TITLE,
} from './model/describe.js';
import { metricCards, profileRows, selectWindow, taskRows, taskRunRows } from './model/stats.js';
import { buildTaskNameTables } from './model/task-names.js';
import { taskDefinitionListQuery, useStatsQuery } from './queries.js';

function isPeriod(value: string | undefined): value is StatsPeriod {
  return value === '24h' || value === '7d' || value === '1mo';
}

/** The Workshop Ledger page: header period switch, metric cards, heatmap and three tables. */
export function StatsPage() {
  const [period, setPeriod] = useState<StatsPeriod>('24h');
  const [builtinOnly, setBuiltinOnly] = useState(false);
  const [runKind, setRunKind] = useState<TaskRunKindFilter>('all');
  const stats = useStatsQuery();
  const definitions = useQuery(taskDefinitionListQuery);

  const names = useMemo(() => buildTaskNameTables(definitions.data ?? null), [definitions.data]);
  const snapshot = stats.data;
  const snapshotUnavailable = snapshot !== undefined && snapshot.status === 'unavailable';
  // A retained same-endpoint snapshot served while a refresh failed. Genuine
  // query rejections with prior data keep `stats.data` via keepPreviousData
  // and surface the same freshness indicator.
  const staleSnapshot = snapshot?.status === 'available' && (snapshot.stale === true || stats.isError);
  const window = snapshot && snapshot.status === 'available' ? selectWindow(snapshot, period) : undefined;
  const range = window
    ? `${formatSnapshotStamp(window.startAt)} 至 ${formatSnapshotStamp(window.endAt)}`
    : '';

  const recentRuns = snapshot?.status === 'available' ? snapshot.recentTaskRuns : undefined;
  const liveExecutions = useMemo(() => (recentRuns ?? [])
    .filter((run) => run.status === 'running' && run.executionMode === 'gateway' && Boolean(run.executionId))
    .map((run) => ({ executionId: run.executionId!, taskRunId: run.taskRunId })), [recentRuns]);
  useTaskUsageLiveExecutions(liveExecutions);
  useEffect(() => {
    for (const run of recentRuns ?? []) {
      if (run.status !== 'running' && run.executionId) dropTaskUsageLive(run.executionId);
    }
  }, [recentRuns]);

  return (
    <>
      <Page data-page="stats">
        <PageHeader>
          <PageTitle>{PAGE_TITLE}</PageTitle>
          <PageDescription>{range}</PageDescription>
          <PageActions>
            <ToggleGroup
              variant="outline"
              value={[period]}
              onValueChange={(value) => {
                const next = value[0];
                if (isPeriod(next)) setPeriod(next);
              }}
            >
              {PERIOD_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>{option.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </PageActions>
        </PageHeader>
        <PageContent>
          {stats.isError && !snapshot ? (
            // Full-page error only when there is no usable same-endpoint data
            // to retain; a rejection with prior data falls through and keeps
            // rendering the snapshot with the stale indicator.
            <QueryError query={stats} title={STATS_UNAVAILABLE_TITLE} />
          ) : snapshotUnavailable ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{STATS_UNAVAILABLE_TITLE}</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => { void stats.refetch(); }}>
                  {STATS_RETRY_LABEL}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              {staleSnapshot && (
                <Alert variant="default" className="mb-4">
                  <AlertTitle>{STATS_STALE_TITLE}</AlertTitle>
                  <AlertDescription className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {snapshot?.fetchedAt ? formatSnapshotStamp(new Date(snapshot.fetchedAt).toISOString()) : ''}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => { void stats.refetch(); }}>
                      {STATS_STALE_RETRY_LABEL}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <MetricCards cards={metricCards(snapshot, window)} loading={stats.isPending} />
              {snapshot && snapshot.status === 'available' && (
                <>
                  <ActivityHeatmap daily={snapshot.daily} todayKey={snapshot.today?.dayKey} />
                  <div className="grid gap-4 @5xl/main:grid-cols-2">
                    <ProfileTable rows={profileRows(window)} />
                    <TaskInvestmentTable
                      rows={taskRows(window, builtinOnly, names)}
                      builtinOnly={builtinOnly}
                      onBuiltinOnlyChange={setBuiltinOnly}
                    />
                  </div>
                  <TaskRunsTable
                    rows={taskRunRows(snapshot.recentTaskRuns, names)}
                    kindFilter={runKind}
                    onKindFilterChange={setRunKind}
                  />
                </>
              )}
            </>
          )}
        </PageContent>
      </Page>
    </>
  );
}
