import { useState } from 'react';
import { Activity, Network } from 'lucide-react';
import { Item } from '@/renderer/components/ui/item';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { shell, useActivityStatus } from '@/renderer/lib/desktop';
import { toggleActivityPanel } from '@/renderer/lib/activity-panel';
import type { ActivityStatusTaskGraph } from '@/shell-contract';
import { useSessionActivity } from '../use-activity';

export function ActivityItem() {
  const snapshot = useActivityStatus();
  const sessions = useSessionActivity();
  const tasks = snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued');
  const groups = sessions.data ?? [];
  const turns = groups.flatMap((session) => session.turns);
  const stale = snapshot.stale || sessions.isError;
  const counts = [turns.length ? turns.length + ' 轮' : '', tasks.length ? tasks.length + ' 任务' : ''].filter(Boolean).join(' · ');
  const label = counts || (sessions.isPending ? '加载中' : stale ? '暂不可用' : '空闲');

  return (
    <StatusBarButton
      icon={Activity}
      label={label}
      tone={stale ? 'warning' : 'default'}
      tooltip={stale ? '活动数据暂未更新' : '查看会话与任务活动'}
      ariaLabel="活动"
      onClick={() => toggleActivityPanel()}
    />
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
