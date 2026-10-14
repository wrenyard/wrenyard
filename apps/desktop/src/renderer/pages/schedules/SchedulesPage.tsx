import { Page, PageContent, PageDescription, PageHeader, PageTitle } from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent } from '@/renderer/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import type { ScheduleItem } from '@/shell-contract';
import { PAGE_TITLE, STATE_VIEW, frequencyText } from './model/describe.js';
import {
  useDeleteScheduleMutation,
  useRunScheduleMutation,
  useSchedulesQuery,
  useUpdateScheduleMutation,
} from './queries.js';

/** One-line placeholder for an absent time. */
const NONE = '—';

/** The 定时任务 page: every scheduled prompt of this machine with its controls. */
export function SchedulesPage() {
  const schedules = useSchedulesQuery();
  const update = useUpdateScheduleMutation();
  const run = useRunScheduleMutation();
  const remove = useDeleteScheduleMutation();
  const confirm = useConfirm();
  const items = schedules.data?.schedules ?? [];

  const requestDelete = (item: ScheduleItem): void => {
    void confirm({
      title: '删除定时任务？',
      description: '删除后不会再触发。',
      confirmLabel: '删除',
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) remove.mutate(item.id);
    });
  };

  return (
    <Page data-page="schedules">
      <PageHeader>
        <PageTitle>{PAGE_TITLE}</PageTitle>
        <PageDescription>{`共 ${items.length} 个定时任务`}</PageDescription>
      </PageHeader>
      <PageContent>
        {schedules.isError ? (
          <QueryError query={schedules} title={PAGE_TITLE} />
        ) : (
          <Card className="min-w-0">
            <CardContent>
              {schedules.isPending ? (
                <div className="flex flex-col gap-3" role="status" aria-label="加载定时任务">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : items.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>暂无定时任务</EmptyTitle>
                    <EmptyDescription>在会话中说“每 5 分钟检查一次构建状态”即可创建。</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>提示词</TableHead>
                      <TableHead>会话</TableHead>
                      <TableHead>频率</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>下次触发</TableHead>
                      <TableHead>上次触发</TableHead>
                      <TableHead>到期</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const view = STATE_VIEW[item.state];
                      const badge = <StatusBadge tone={view.tone} label={view.label} />;
                      const sessionLabel = item.sessionTitle ?? item.sessionId.slice(0, 8);

                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            <Tooltip>
                              <TooltipTrigger
                                render={<span className="block max-w-[20rem] truncate font-medium" />}
                              >
                                {item.prompt}
                              </TooltipTrigger>
                              <TooltipContent>{item.prompt}</TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell>
                            <Tooltip>
                              <TooltipTrigger
                                render={<span className="block max-w-[12rem] truncate text-muted-foreground" />}
                              >
                                {sessionLabel}
                              </TooltipTrigger>
                              <TooltipContent>{item.sessionTitle ?? item.sessionId}</TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {frequencyText(item.intervalMinutes, item.recurring)}
                          </TableCell>
                          <TableCell>
                            {item.state === 'failed' && item.lastError !== undefined ? (
                              <Tooltip>
                                <TooltipTrigger render={<span className="inline-flex" />}>
                                  {badge}
                                </TooltipTrigger>
                                <TooltipContent>{item.lastError}</TooltipContent>
                              </Tooltip>
                            ) : badge}
                          </TableCell>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {item.nextRunAt === undefined ? NONE : <Timestamp value={item.nextRunAt} />}
                          </TableCell>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {item.lastRunAt === undefined ? NONE : (
                              <span className="inline-flex items-center gap-1">
                                <Timestamp value={item.lastRunAt} />
                                <span>{`· 第 ${item.runCount} 次`}</span>
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {item.expiresAt === undefined ? NONE : <Timestamp value={item.expiresAt} />}
                          </TableCell>
                          <TableCell>
                            <div className="flex shrink-0 items-center justify-end gap-1">
                              {item.state === 'active' && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  disabled={update.isPending}
                                  onClick={() => update.mutate({ id: item.id, state: 'paused' })}
                                >
                                  暂停
                                </Button>
                              )}
                              {item.state === 'paused' && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  disabled={update.isPending}
                                  onClick={() => update.mutate({ id: item.id, state: 'active' })}
                                >
                                  恢复
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="xs"
                                disabled={run.isPending || item.state === 'failed'}
                                onClick={() => run.mutate(item.id)}
                              >
                                立即触发
                              </Button>
                              <Button
                                variant="ghost"
                                size="xs"
                                className="text-destructive"
                                disabled={remove.isPending}
                                onClick={() => requestDelete(item)}
                              >
                                删除
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </PageContent>
    </Page>
  );
}
