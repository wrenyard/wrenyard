import { useState, type ReactNode } from 'react';
import { Network } from 'lucide-react';
import { Item } from '@/renderer/components/ui/item';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { shell, useActivityStatus } from '@/renderer/lib/desktop';
import type { ActivityStatusTaskGraph } from '@/shell-contract';

const NODE_LABELS: ReadonlyArray<[string, string]> = [
  ['done', '完成'],
  ['running', '运行'],
  ['queued', '等待'],
  ['waiting', '等待'],
  ['failed', '失败'],
  ['cancelled', '已取消'],
];

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

interface TaskGraphsPopoverProps {
  trigger: ReactNode;
}

/** Running task graphs list extracted from the retired status-bar item. */
export function TaskGraphsPopover({ trigger }: TaskGraphsPopoverProps) {
  const snapshot = useActivityStatus();
  const [open, setOpen] = useState(false);
  const activeGraphs = snapshot.taskgraphs.filter(isActiveGraph);

  const openGraph = (graph: ActivityStatusTaskGraph): void => {
    void shell.openTaskGraph(graph.taskgraphId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-[360px] p-0">
        <div className="px-4 pt-3 pb-2">
          <span className="text-sm font-medium">运行中的任务图</span>
        </div>
        <div className="max-h-80 overflow-auto px-2 pb-2">
          {activeGraphs.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">暂无运行中的任务图</p>
          ) : activeGraphs.map((graph) => (
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
