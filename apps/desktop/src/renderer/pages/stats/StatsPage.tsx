import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Page,
  PageActions,
  PageContent,
  PageDescription,
  PageHeader,
  PageTitle,
} from '@/renderer/components/page';
import { Button } from '@/renderer/components/ui/button';
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { formatSnapshotStamp } from '@/renderer/lib/format';
import { taskSettingsQuery } from '@/renderer/lib/queries';
import type { StatsPeriod } from '@/shell-contract';
import { ActivityHeatmap } from './components/ActivityHeatmap.js';
import { MetricCards } from './components/MetricCards.js';
import { ProfileTable } from './components/ProfileTable.js';
import { TaskInvestmentTable } from './components/TaskInvestmentTable.js';
import { TaskRunsTable } from './components/TaskRunsTable.js';
import {
  PAGE_TITLE,
  PERIOD_OPTIONS,
  STATS_RETRY_LABEL,
  STATS_UNAVAILABLE_TITLE,
} from './model/describe.js';
import { metricCards, profileRows, selectWindow, taskRows, taskRunRows } from './model/stats.js';
import { buildTaskNameTables } from './model/task-names.js';
import { useStatsQuery } from './queries.js';

function isPeriod(value: string | undefined): value is StatsPeriod {
  return value === '24h' || value === '7d' || value === '1mo';
}

/** The Workshop Ledger page: header period switch, metric cards, heatmap and three tables. */
export function StatsPage() {
  const [period, setPeriod] = useState<StatsPeriod>('24h');
  const [builtinOnly, setBuiltinOnly] = useState(false);
  const stats = useStatsQuery();
  const settings = useQuery(taskSettingsQuery());

  const names = useMemo(() => buildTaskNameTables(settings.data ?? null), [settings.data]);
  const snapshot = stats.data;
  const unavailable = stats.isError || (snapshot !== undefined && snapshot.status === 'unavailable');
  const window = snapshot && snapshot.status === 'available' ? selectWindow(snapshot, period) : undefined;
  const range = window
    ? `${formatSnapshotStamp(window.startAt)} 至 ${formatSnapshotStamp(window.endAt)}`
    : '';

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
          {unavailable ? (
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
                  <TaskRunsTable rows={taskRunRows(snapshot.recentTaskRuns, names)} />
                </>
              )}
            </>
          )}
        </PageContent>
      </Page>
    </>
  );
}
