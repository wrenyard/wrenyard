/**
 * App-level right-side activity panel: the single activity surface that
 * replaced the status-bar popover. The header carries the 本会话/全部 scope
 * toggle (while a session is open), the list shows the popover's content —
 * running session turns grouped by session, task runs with status, runtime
 * and their task graph link — plus finished task runs kept for ten minutes.
 * Selecting a task run previews its live transcript in the lower part through
 * the shared `TaskTranscript` view. One instance serves the whole app; later
 * tabs (用量) extend this same surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bot, MessageSquare, X, Zap, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Item } from '@/renderer/components/ui/item';
import { Separator } from '@/renderer/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { PanelFooterAction } from '@/renderer/components/panel-footer-action';
import { Elapsed } from '@/renderer/components/elapsed';
import { TaskTranscript, type TaskRunEventsLoader } from '@/renderer/components/task-transcript';
import { executeCommand } from '@/renderer/lib/commands';
import { shell, useActivityStatus } from '@/renderer/lib/desktop';
import { getSessionBridge } from '@/renderer/lib/session';
import { useAppearance } from '@/renderer/lib/theme';
import { closeActivityPanel, setActivityPanelTab, useActivityPanelState, type ActivityPanelTab } from '@/renderer/lib/activity-panel';
import { UsagePanel } from '@/renderer/app/UsagePanel';
import { useActiveSession } from '@/renderer/lib/navigation';
import { TASK_RUN_PHASE_LABEL, runningTaskAction } from '@/renderer/pages/session/model/describe';
import { isRunningTask } from '@/renderer/pages/session/model/fold';
import type { ActionKindModel } from '@/renderer/pages/session/model/types';
import type { ActivityStatusTask, ActivityStatusTaskGraph } from '@/shell-contract';
import { useActivityTaskDetails, useSessionActivity } from './use-activity';

const ACTION_LABEL: Record<ActionKindModel, string> = {
  // The compile stage only: a dispatch whose task run has opened is shown with
  // its own phase label and elapsed time instead.
  dispatch: '编译任务输入',
  document: '文档管理',
  todo: '待办',
  search: '检索资料',
  vcs: '工作区版本',
  project: '项目管理',
  schedule: '定时任务',
  'parse-failed': '解析行动',
};

/** A finished run stays listed this long for a result preview. */
const FINISHED_RETENTION_MS = 10 * 60 * 1000;
const TURN_PHASE_LABEL: Record<'preparing' | 'reasoning' | 'acting' | 'replying', string> = {
  preparing: '准备中',
  reasoning: '推理中',
  acting: '行动中',
  replying: '回复中',
};

/** One task run shown in the list: live from the snapshot or recently finished. */
interface ListedTask extends ActivityStatusTask {
  /** When the run left the live snapshot; retained entries expire after it. */
  finishedAt?: number;
}

function ActivityRow({ icon: Icon, title, detail, startedAt, onClick, selected }: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  startedAt: string;
  onClick: () => void;
  selected?: boolean;
}) {
  return (
    <Item
      render={<button type="button" onClick={onClick} />}
      size="xs"
      className={cn('w-full flex-nowrap text-left', selected && 'bg-accent')}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={title}>{title}</span>
        {detail ? <span className="block truncate text-xs text-muted-foreground" title={detail}>{detail}</span> : null}
      </span>
      <Elapsed start={startedAt} className="shrink-0 tabular-nums text-xs text-muted-foreground" />
    </Item>
  );
}

/** The session bridge as the preview's event source. */
const transcriptLoader: TaskRunEventsLoader = {
  load: (taskRunId, afterSeq) => getSessionBridge().taskRunEvents(taskRunId, afterSeq),
  retry: () => Promise.resolve(),
};

export function ActivityPanel({ scopeSession }: { scopeSession: string }) {
  const { tab } = useActivityPanelState();
  const snapshot = useActivityStatus();
  const sessions = useSessionActivity();
  const activeSession = useActiveSession();
  const { dark } = useAppearance();
  const onOpenExternal = useCallback((href: string) => {
    void shell.openExternal(href);
  }, []);

  // The chip asks for a session-scoped open; other openers leave the scope
  // where the user last put it (or 全部 when no session is open).
  const [scope, setScope] = useState<'session' | 'all'>(scopeSession === '' ? 'all' : 'session');
  useEffect(() => {
    if (scopeSession !== '') setScope('session');
  }, [scopeSession]);
  // The scope toggle exists only while a session is open; losing the session
  // falls back to the full list.
  const sessionOpen = activeSession !== '';
  const scoped = scope === 'session' && sessionOpen;

  const liveTasks = useMemo(
    () => snapshot.tasks
      .filter((task) => task.status === 'running' || task.status === 'queued')
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    [snapshot.tasks],
  );

  // Finished runs are not part of the snapshot: remember each live id and keep
  // the ones that disappear for FINISHED_RETENTION_MS, resolved through the
  // task briefs so the row can read 已完成 / 失败.
  const [finished, setFinished] = useState<Map<string, ListedTask>>(() => new Map());
  const knownRef = useRef<Map<string, ActivityStatusTask>>(new Map());
  useEffect(() => {
    const previous = knownRef.current;
    const next = new Map(liveTasks.map((task) => [task.taskRunId, task]));
    const now = Date.now();
    setFinished((current) => {
      const retained = new Map(current);
      let changed = false;
      for (const [id, task] of previous) {
        if (!next.has(id) && !retained.has(id)) {
          retained.set(id, { ...task, finishedAt: now });
          changed = true;
        }
      }
      for (const [id, task] of retained) {
        if (next.has(id)) {
          // Back in the live set (e.g. a retried run): drop the stale entry.
          retained.delete(id);
          changed = true;
        } else if (task.finishedAt !== undefined && now - task.finishedAt > FINISHED_RETENTION_MS) {
          retained.delete(id);
          changed = true;
        }
      }
      return changed ? retained : current;
    });
    knownRef.current = next;
  }, [liveTasks]);
  // Retention expiry has no clock of its own; a minute tick drops stale rows.
  useEffect(() => {
    if (finished.size === 0) return;
    const timer = setTimeout(() => setFinished((current) => new Map(current)), 60_000);
    return () => clearTimeout(timer);
  }, [finished]);

  const liveIds = useMemo(() => new Set(liveTasks.map((task) => task.taskRunId)), [liveTasks]);
  const tasks = useMemo<ListedTask[]>(() => {
    const finishedList = [...finished.values()].filter((task) => !liveIds.has(task.taskRunId));
    return [...liveTasks, ...finishedList];
  }, [liveTasks, finished, liveIds]);

  const details = useActivityTaskDetails(tasks.map((task) => task.taskRunId).sort());
  const groups = sessions.data ?? [];
  const turns = groups.flatMap((session) => session.turns);
  const linkedTasks = useMemo(
    () => new Set(turns.flatMap((turn) => turn.actions.flatMap((action) => action.taskRunId ? [action.taskRunId] : []))),
    [turns],
  );
  const renderedTurnTaskIds = useMemo(
    () => new Set(
      groups.flatMap((session) => session.turns.flatMap((turn) => turn.actions.flatMap((action) => action.taskRunId ? [action.taskRunId] : []))),
    ),
    [groups],
  );
  // Live tasks unlinked to any session, plus finished runs whose turn already
  // dropped out of the running-turn list, render in the standalone section.
  const standaloneTasks = tasks.filter(
    (task) => !linkedTasks.has(task.taskRunId)
      || (task.finishedAt !== undefined && !renderedTurnTaskIds.has(task.taskRunId)),
  );
  const stale = snapshot.stale || sessions.isError || details.isError;

  const [selectedTaskRunId, setSelectedTaskRunId] = useState<string | null>(null);
  const selectedTask = selectedTaskRunId === null ? undefined : tasks.find((task) => task.taskRunId === selectedTaskRunId);
  // A selected run that left the list keeps its preview open for the result.

  const openSession = (sessionId: string): void => {
    executeCommand('session.open', { sessionId });
  };

  /** Session-filtered view: only the open session's group and its linked tasks. */
  const visibleGroups = scoped ? groups.filter((session) => session.sessionId === activeSession) : groups;
  const visibleStandalone = scoped ? [] : standaloneTasks;
  const scopedLinkedIds = useMemo(() => {
    if (!scoped) return linkedTasks;
    const session = groups.find((item) => item.sessionId === activeSession);
    return new Set(session?.turns.flatMap((turn) => turn.actions.flatMap((action) => action.taskRunId ? [action.taskRunId] : [])) ?? []);
  }, [scoped, groups, activeSession, linkedTasks]);
  // Finished runs linked to this session but no longer under a rendered
  // (running) turn stay listed as session-scoped standalone rows.
  const scopedFinished = scoped
    ? tasks.filter((task) => task.finishedAt !== undefined && scopedLinkedIds.has(task.taskRunId) && !renderedTurnTaskIds.has(task.taskRunId))
    : [];

  const renderTask = (task: ListedTask): React.ReactNode => {
    const brief = details.data?.find((item) => item.taskRunId === task.taskRunId);
    const graph = snapshot.taskgraphs.find((item) => item.taskgraphId === task.taskgraphId);
    // A retained finished run learns its outcome from the task brief; a run
    // that left the live set without a resolvable failure reads as 已完成.
    const failed = brief?.status === 'failed' || brief?.status === 'cancelled' || brief?.status === 'interrupted';
    const status = task.finishedAt !== undefined
      ? (failed ? '失败' : '已完成')
      : task.status === 'queued'
        ? (task.queuePosition !== undefined ? `排队中 #${task.queuePosition}` : '排队中')
        : '运行中';
    return (
      <div key={task.taskRunId} className="flex items-center">
        <div className="min-w-0 flex-1">
          <ActivityRow
            icon={Bot}
            title={task.taskLabel ?? brief?.taskName ?? task.taskId ?? task.taskRunId}
            detail={[
              status,
              brief?.taskName ?? task.taskId,
              brief?.runtime,
            ].filter(Boolean).join(' · ')}
            startedAt={task.startedAt}
            selected={selectedTaskRunId === task.taskRunId}
            onClick={() => setSelectedTaskRunId((current) => current === task.taskRunId ? null : task.taskRunId)}
          />
        </div>
        {graph ? (
          <Button
            variant="ghost"
            size="xs"
            className="max-w-24 shrink-0 text-muted-foreground"
            onClick={() => void shell.openTaskGraph(graph.taskgraphId)}
          >
            <span className="truncate">{graph.title ?? graph.taskgraphId}</span>
          </Button>
        ) : null}
      </div>
    );
  };

  const empty = visibleGroups.every((session) => session.turns.length === 0)
    && visibleStandalone.length === 0
    && scopedFinished.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        {/* 活动 / 用量 tabs; the selected tab is persisted by the store. */}
        <ToggleGroup
          aria-label="右侧面板内容"
          value={[tab]}
          onValueChange={(values) => {
            const value = values.find((item): item is ActivityPanelTab => item === 'activity' || item === 'usage');
            if (value !== undefined) setActivityPanelTab(value);
          }}
          size="sm"
          variant="outline"
        >
          <ToggleGroupItem value="activity">活动</ToggleGroupItem>
          <ToggleGroupItem value="usage">用量</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-1">
          {tab === 'activity' && sessionOpen && (
            <ToggleGroup
              aria-label="活动范围"
              value={[scope]}
              onValueChange={(values) => {
                const value = values.find((item): item is 'session' | 'all' => item === 'session' || item === 'all');
                if (value !== undefined) setScope(value);
              }}
              size="sm"
              variant="outline"
            >
              <ToggleGroupItem value="session">本会话</ToggleGroupItem>
              <ToggleGroupItem value="all">全部</ToggleGroupItem>
            </ToggleGroup>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={closeActivityPanel}>
            <X />
          </Button>
        </div>
      </div>

      {tab === 'usage' ? <UsagePanel /> : (
      <>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {stale ? <p className="px-2 py-1 text-xs text-warning">活动数据暂未更新</p> : null}
        {visibleGroups.map((session) => session.turns.length > 0 ? (
          <section key={session.sessionId} className="mb-2">
            <Button variant="ghost" size="sm" className="max-w-full justify-start gap-2" onClick={() => openSession(session.sessionId)}>
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate">{session.title || '新会话'}</span>
            </Button>
            {session.turns.map((turn) => {
              const turnTaskIds = new Set(turn.actions.map((action) => action.taskRunId));
              const turnTasks = tasks.filter((task) => turnTaskIds.has(task.taskRunId));
              const actions = turn.actions.filter((action) => action.status === 'running' && !action.taskRunId);
              // A dispatch whose task run is executing is an implementation
              // phase of its own: it is timed from the run it opened, not
              // from the turn, and never labelled as compiling.
              const taskRuns = turn.actions.filter(isRunningTask);
              const taskRun = runningTaskAction(turn);
              const phase = taskRun === undefined ? TURN_PHASE_LABEL[turn.phase ?? 'preparing'] : TASK_RUN_PHASE_LABEL;
              return (
                <div key={turn.id} className="ml-3 border-l border-border pl-2">
                  <ActivityRow
                    icon={Activity}
                    title={'第 ' + turn.id + ' 轮 · ' + phase}
                    detail={turn.user.text}
                    startedAt={turn.startedAt}
                    onClick={() => openSession(session.sessionId)}
                  />
                  {actions.length + taskRuns.length > 0 ? <>
                    <p className="px-2.5 pt-1 text-xs text-muted-foreground">行动</p>
                    {actions.map((action) => (
                      <ActivityRow key={action.id} icon={Zap} title={ACTION_LABEL[action.kind]}
                        detail={action.subtitle || action.title} startedAt={action.startedAt}
                        onClick={() => openSession(session.sessionId)} />
                    ))}
                    {taskRuns.map((action) => (
                      <ActivityRow key={action.id} icon={Zap} title={TASK_RUN_PHASE_LABEL}
                        detail={action.subtitle || action.title} startedAt={action.startedAt}
                        onClick={() => openSession(session.sessionId)} />
                    ))}
                  </> : null}
                  {turnTasks.length > 0 ? <>
                    <p className="px-2.5 pt-1 text-xs text-muted-foreground">智能体任务</p>
                    {turnTasks.map(renderTask)}
                  </> : null}
                </div>
              );
            })}
          </section>
        ) : null)}
        {visibleStandalone.length > 0 ? <>
          <p className="px-2.5 pt-1 text-xs text-muted-foreground">独立运行的任务</p>
          {visibleStandalone.map(renderTask)}
        </> : null}
        {scopedFinished.length > 0 ? <>
          <p className="px-2.5 pt-1 text-xs text-muted-foreground">已结束的任务</p>
          {scopedFinished.map(renderTask)}
        </> : null}
        {empty ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          {sessions.isPending ? '正在读取活动…' : stale ? '暂时无法读取活动' : '暂无进行中的会话或任务'}
        </p> : null}
      </div>

      {selectedTaskRunId !== null && (
        <>
          <Separator />
          <div className="flex max-h-[50%] min-h-40 shrink-0 flex-col">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {selectedTask?.taskLabel ?? details.data?.find((item) => item.taskRunId === selectedTaskRunId)?.taskName ?? selectedTaskRunId}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void shell.openTaskTranscript(selectedTaskRunId, selectedTask?.taskLabel)}
                >
                  在窗口中打开
                </Button>
                {selectedTask !== undefined && selectedTask.finishedAt === undefined && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                    onClick={() => void getSessionBridge().cancelTask(selectedTaskRunId).catch(() => undefined)}
                  >
                    取消任务
                  </Button>
                )}
                <Button variant="ghost" size="icon-xs" aria-label="关闭预览" onClick={() => setSelectedTaskRunId(null)}>
                  <X />
                </Button>
              </div>
            </div>
            <TaskTranscript
              key={selectedTaskRunId}
              taskRunId={selectedTaskRunId}
              loader={transcriptLoader}
              dark={dark}
              onOpenExternal={onOpenExternal}
            />
          </div>
        </>
      )}
      <Separator />
      <PanelFooterAction label="打开任务页" onClick={() => executeCommand('tasks.open')} />
      </>
      )}
    </div>
  );
}
