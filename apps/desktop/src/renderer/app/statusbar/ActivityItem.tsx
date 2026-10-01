import { useState } from 'react';
import { Network, Play } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Item } from '@/renderer/components/ui/item';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Separator } from '@/renderer/components/ui/separator';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { Elapsed } from '@/renderer/components/elapsed';
import { executeCommand } from '@/renderer/lib/commands';
import { shell, useActivityStatus } from '@/renderer/lib/desktop';
import type { ActivityStatusTask, ActivityStatusTaskGraph } from '@/shell-contract';
import { cn } from 'cn';

/**
 * Status-bar activity items (window-chrome spec 4.3, 4.4): one for queued and
 * running task runs, one for active task graphs. Both read the shared activity
 * projection and open the owning surface on click: a task row opens that run's
 * transcript, and a graph title/row opens the native Graph Slip window.
 */

function byStartedAt(a: ActivityStatusTask, b: ActivityStatusTask): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

const ACTIVITY_ROW_CLASS =
  'min-w-0 flex-1';

export function ActivityItem() {
  const snapshot = useActivityStatus();
  const [open, setOpen] = useState(false);
  const runningTasks = snapshot.tasks.filter((task) => task.status === 'running').sort(byStartedAt);
  const queuedTasks = snapshot.tasks.filter((task) => task.status === 'queued').sort(byStartedAt);
  const running = runningTasks.length;
  const queued = queuedTasks.length;
  const active = running + queued > 0;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} 运行`);
  if (queued > 0) parts.push(`${queued} 排队`);
  const base = parts.length > 0 ? parts.join(' · ') : '空闲';
  const label = snapshot.stale ? `${base}（数据过期）` : base;

  const openTask = (task: ActivityStatusTask): void => {
    executeCommand('tasks.open', {
      taskRunId: task.taskRunId,
      ...(task.taskId !== undefined ? { taskId: task.taskId } : {}),
      ...(task.project !== undefined ? { project: task.project } : {}),
    });
    setOpen(false);
  };

  const openTaskGraph = (taskgraphId: string): void => {
    void shell.openTaskGraph(taskgraphId);
    setOpen(false);
  };

  const renderTask = (task: ActivityStatusTask) => {
    const taskgraphId = task.taskgraphId;
    // A task that belongs to a graph shows the graph title as a separate
    // sibling button (never nested inside the row button) that opens the
    // native Graph Slip window.
    const graph = taskgraphId === undefined
      ? undefined
      : snapshot.taskgraphs.find((candidate) => candidate.taskgraphId === taskgraphId);
    return (
      <div key={task.taskRunId} className="flex w-full items-center gap-1">
        <Item
          render={<button type="button" onClick={() => openTask(task)} />}
          size="xs"
          className={ACTIVITY_ROW_CLASS}
        >
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              task.status === 'running' ? 'bg-success' : 'bg-muted-foreground',
            )}
          />
          <span className="truncate">{task.taskLabel ?? task.taskId ?? task.taskRunId}</span>
          {task.project ? <span className="truncate text-muted-foreground">{task.project}</span> : null}
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {task.status === 'running' ? <Elapsed start={task.startedAt} /> : '排队中'}
          </span>
        </Item>
        {taskgraphId !== undefined && graph !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="max-w-24 shrink-0 text-muted-foreground"
            onClick={() => openTaskGraph(taskgraphId)}
          >
            <span className="truncate">{graph.title ?? graph.taskgraphId}</span>
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <StatusBarButton
          icon={active ? Play : undefined}
          label={label}
          tone={snapshot.stale ? 'warning' : 'default'}
          tooltip={snapshot.stale ? '任务活动数据已过期' : '查看运行中的任务'}
          ariaLabel="任务活动"
        />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[420px] p-0">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-sm font-medium">运行中的任务</span>
          <span className="text-xs text-muted-foreground">{`${running} 运行 · ${queued} 排队`}</span>
        </div>
        <div className="max-h-80 overflow-auto px-2 pb-2">
          {active ? (
            <>
              {runningTasks.map(renderTask)}
              {queuedTasks.map(renderTask)}
            </>
          ) : (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">暂无运行中的任务</p>
          )}
        </div>
        <Separator />
        <div className="p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              executeCommand('tasks.open');
              setOpen(false);
            }}
          >
            打开任务页
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const NODE_LABELS: ReadonlyArray<[string, string]> = [
  ['done', '完成'],
  ['running', '运行'],
  ['queued', '等待'],
  ['waiting', '等待'],
  ['failed', '失败'],
  ['cancelled', '已取消'],
];

/** `完成 2 · 运行 1 · 等待 1` from the graph's node counts, dropping zeroes. */
function formatNodeCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const [key, label] of NODE_LABELS) {
    const value = counts[key];
    if (value !== undefined && value > 0) {
      parts.push(`${label} ${value}`);
      seen.add(key);
    }
  }
  for (const [key, value] of Object.entries(counts)) {
    if (seen.has(key) || value <= 0) continue;
    parts.push(`${key} ${value}`);
  }
  return parts.join(' · ');
}

function isActiveGraph(graph: ActivityStatusTaskGraph): boolean {
  return graph.state !== 'done' && graph.state !== 'cancelled';
}

export function TaskGraphItem() {
  const snapshot = useActivityStatus();
  const [open, setOpen] = useState(false);
  const activeGraphs = snapshot.taskgraphs.filter(isActiveGraph);
  if (activeGraphs.length === 0) return null;

  const openGraph = (graph: ActivityStatusTaskGraph): void => {
    // The native Graph Slip window is the graph surface; a graph row never
    // falls back to a task run transcript.
    void shell.openTaskGraph(graph.taskgraphId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <StatusBarButton
          icon={Network}
          label={`${activeGraphs.length} 图运行中`}
          tooltip="查看运行中的任务图"
          ariaLabel="任务图活动"
        />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[360px] p-0">
        <div className="px-4 pt-3 pb-2">
          <span className="text-sm font-medium">运行中的任务图</span>
        </div>
        <div className="max-h-80 overflow-auto px-2 pb-2">
          {activeGraphs.map((graph) => (
            <Item
              key={graph.taskgraphId}
              render={<button type="button" onClick={() => openGraph(graph)} />}
              size="xs"
              className="w-full"
            >
              <span className="truncate">{graph.title ?? graph.taskgraphId}</span>
              {graph.project ? <span className="truncate text-muted-foreground">{graph.project}</span> : null}
              <span className="ml-auto shrink-0 text-muted-foreground">{formatNodeCounts(graph.nodeCounts)}</span>
            </Item>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
