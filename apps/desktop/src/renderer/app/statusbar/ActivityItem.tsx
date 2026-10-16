import { useState } from 'react';
import { Activity, Bot, MessageSquare, Network, Zap, type LucideIcon } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Item } from '@/renderer/components/ui/item';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Separator } from '@/renderer/components/ui/separator';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { Elapsed } from '@/renderer/components/elapsed';
import { executeCommand } from '@/renderer/lib/commands';
import { shell, useActivityStatus } from '@/renderer/lib/desktop';
import { PHASE_LABEL } from '@/renderer/pages/session/model/describe';
import type { ActionKindModel } from '@/renderer/pages/session/model/types';
import type { ActivityStatusTask, ActivityStatusTaskGraph } from '@/shell-contract';
import { useActivityTaskDetails, useSessionActivity } from './use-activity';

const ACTION_LABEL: Record<ActionKindModel, string> = {
  dispatch: '编译任务输入',
  document: '文档管理',
  search: '检索资料',
  vcs: '工作区版本',
  project: '项目管理',
  schedule: '定时任务',
  'parse-failed': '解析行动',
};

function ActivityRow({ icon: Icon, title, detail, startedAt, onClick }: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  startedAt: string;
  onClick: () => void;
}) {
  return (
    <Item render={<button type="button" onClick={onClick} />} size="xs" className="w-full flex-nowrap text-left">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={title}>{title}</span>
        {detail ? <span className="block truncate text-xs text-muted-foreground" title={detail}>{detail}</span> : null}
      </span>
      <Elapsed start={startedAt} className="shrink-0 tabular-nums text-xs text-muted-foreground" />
    </Item>
  );
}

export function ActivityItem() {
  const snapshot = useActivityStatus();
  const sessions = useSessionActivity();
  const [open, setOpen] = useState(false);
  const tasks = snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued')
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const details = useActivityTaskDetails(tasks.map((task) => task.taskRunId).sort());
  const groups = sessions.data ?? [];
  const turns = groups.flatMap((session) => session.turns);
  const linkedTasks = new Set(turns.flatMap((turn) => turn.actions.flatMap((action) => action.taskRunId ? [action.taskRunId] : [])));
  const standaloneTasks = tasks.filter((task) => !linkedTasks.has(task.taskRunId));
  const stale = snapshot.stale || sessions.isError || details.isError;
  const counts = [turns.length ? turns.length + ' 轮' : '', tasks.length ? tasks.length + ' 任务' : ''].filter(Boolean).join(' · ');
  const label = counts || (sessions.isPending ? '加载中' : stale ? '暂不可用' : '空闲');
  const openSession = (sessionId: string) => {
    executeCommand('session.open', { sessionId });
    setOpen(false);
  };
  const renderTask = (task: ActivityStatusTask) => {
    const brief = details.data?.find((item) => item.taskRunId === task.taskRunId);
    const graph = snapshot.taskgraphs.find((item) => item.taskgraphId === task.taskgraphId);
    return <div key={task.taskRunId} className="flex items-center">
      <div className="min-w-0 flex-1"><ActivityRow icon={Bot}
      title={task.taskLabel ?? brief?.taskName ?? task.taskId ?? task.taskRunId}
      detail={[
        task.status === 'queued'
          ? (task.queuePosition !== undefined ? `排队中 #${task.queuePosition}` : '排队中')
          : '运行中',
        brief?.taskName ?? task.taskId,
        brief?.runtime,
      ].filter(Boolean).join(' · ')}
      startedAt={task.startedAt}
      onClick={() => {
        executeCommand('tasks.open', { taskRunId: task.taskRunId, taskId: task.taskId, project: task.project });
        setOpen(false);
      }} /></div>
      {graph ? <Button variant="ghost" size="xs" className="max-w-24 shrink-0 text-muted-foreground" onClick={() => {
        void shell.openTaskGraph(graph.taskgraphId);
        setOpen(false);
      }}><span className="truncate">{graph.title ?? graph.taskgraphId}</span></Button> : null}
    </div>;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <StatusBarButton icon={Activity} label={label} tone={stale ? 'warning' : 'default'}
          tooltip={stale ? '活动数据暂未更新' : '查看会话与任务活动'} ariaLabel="活动" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[420px] p-0">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-sm font-medium">活动</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <div className="max-h-80 overflow-auto px-2 pb-2">
          {stale ? <p className="px-2 py-1 text-xs text-warning">活动数据暂未更新</p> : null}
          {groups.map((session) => session.turns.length > 0 ? (
            <section key={session.sessionId} className="mb-2">
              <Button variant="ghost" size="sm" className="max-w-full justify-start gap-2" onClick={() => openSession(session.sessionId)}>
                <MessageSquare className="size-3.5 shrink-0" />
                <span className="truncate">{session.title || '新会话'}</span>
              </Button>
              {session.turns.map((turn) => {
                const turnTaskIds = new Set(turn.actions.map((action) => action.taskRunId));
                const turnTasks = tasks.filter((task) => turnTaskIds.has(task.taskRunId));
                const actions = turn.actions.filter((action) => action.status === 'running' && !action.taskRunId);
                return <div key={turn.id} className="ml-3 border-l border-border pl-2">
                  <ActivityRow icon={Activity} title={'第 ' + turn.id + ' 轮 · ' + PHASE_LABEL[turn.phase ?? 'preparing'] + '中'}
                    detail={turn.user.text} startedAt={turn.startedAt} onClick={() => openSession(session.sessionId)} />
                  {actions.length > 0 ? <>
                    <p className="px-2.5 pt-1 text-xs text-muted-foreground">行动</p>
                    {actions.map((action) => <ActivityRow key={action.id} icon={Zap} title={ACTION_LABEL[action.kind]}
                      detail={action.subtitle || action.title} startedAt={action.startedAt} onClick={() => openSession(session.sessionId)} />)}
                  </> : null}
                  {turnTasks.length > 0 ? <>
                    <p className="px-2.5 pt-1 text-xs text-muted-foreground">智能体任务</p>
                    {turnTasks.map(renderTask)}
                  </> : null}
                </div>;
              })}
            </section>
          ) : null)}
          {standaloneTasks.length > 0 ? <>
            <p className="px-2.5 pt-1 text-xs text-muted-foreground">智能体任务</p>
            {standaloneTasks.map(renderTask)}
          </> : null}
          {!counts ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {sessions.isPending ? '正在读取活动…' : stale ? '暂时无法读取活动' : '暂无进行中的会话或任务'}
          </p> : null}
        </div>
        <Separator />
        <div className="p-2">
          <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => {
            executeCommand('tasks.open');
            setOpen(false);
          }}>打开任务页</Button>
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
