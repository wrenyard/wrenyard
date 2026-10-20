/**
 * App-level right-side panel listing background task runs and task graphs
 * across sessions. Rows expand in place for task transcript preview, cancellation,
 * and navigation; session turns and actions are not shown here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Elapsed } from '@/renderer/components/elapsed';
import { TaskTranscript, type TaskRunEventsLoader } from '@/renderer/components/task-transcript';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { executeCommand } from '@/renderer/lib/commands';
import { shell, useActivityStatus } from '@/renderer/lib/desktop';
import { getSessionBridge } from '@/renderer/lib/session';
import { useAppearance } from '@/renderer/lib/theme';
import { closeActivityPanel, useActivityPanelState } from '@/renderer/lib/activity-panel';
import { useTaskCancellation } from '@/renderer/hooks/use-task-cancellation';
import type { ActivityStatusTask, ActivityStatusTaskGraph } from '@/shell-contract';
import { useActivityTaskDetails, useSessionActivity } from './use-activity';

/** A finished run stays listed this long after it leaves the live snapshot. */
const FINISHED_RETENTION_MS = 10 * 60 * 1000;

type ExpandedKey = `task:${string}` | `graph:${string}`;

interface ListedTask extends ActivityStatusTask {
  finishedAt?: number;
}

interface ListedGraph extends ActivityStatusTaskGraph {
  finishedAt?: number;
}

interface TaskSessionLink {
  sessionId: string;
  title: string;
}

function isActiveGraph(graph: ActivityStatusTaskGraph): boolean {
  return graph.state !== 'done' && graph.state !== 'cancelled';
}

function graphRowKey(graph: ListedGraph): ExpandedKey {
  return `graph:${graph.taskgraphId}`;
}

function taskRowKey(taskRunId: string): ExpandedKey {
  return `task:${taskRunId}`;
}

function graphStateLabel(graph: ListedGraph, active: boolean): string {
  if (!active && graph.finishedAt !== undefined && isActiveGraph(graph)) {
    return '已结束';
  }
  switch (graph.state) {
    case 'done':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'running':
      return '运行中';
    case 'paused':
      return '已暂停';
    default:
      return graph.state;
  }
}

/** The session bridge as the preview's event source. */
const transcriptLoader: TaskRunEventsLoader = {
  load: (taskRunId, afterSeq) => getSessionBridge().taskRunEvents(taskRunId, afterSeq),
  retry: () => Promise.resolve(),
};

export function ActivityPanel({ scopeSession: _scopeSession }: { scopeSession: string }) {
  const snapshot = useActivityStatus();
  const sessions = useSessionActivity();
  const panelState = useActivityPanelState();
  const { cancelledTasks, cancelTask } = useTaskCancellation();
  const { dark } = useAppearance();
  const onOpenExternal = useCallback((href: string) => {
    void shell.openExternal(href);
  }, []);

  const [runningGroupOpen, setRunningGroupOpen] = useState(true);
  const [finishedGroupOpen, setFinishedGroupOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<ExpandedKey | null>(null);
  const [hiddenFinished, setHiddenFinished] = useState<Set<string>>(() => new Set());
  const persistedSessionLinksRef = useRef<Map<string, TaskSessionLink>>(new Map());
  const sessionLinks = useMemo(() => {
    const merged = new Map(persistedSessionLinksRef.current);
    const groups = sessions.data;
    if (groups !== undefined) {
      for (const session of groups) {
        const title = session.title || '新会话';
        for (const turn of session.turns) {
          for (const action of turn.actions) {
            if (action.taskRunId === undefined) continue;
            merged.set(action.taskRunId, { sessionId: session.sessionId, title });
          }
        }
      }
    }
    persistedSessionLinksRef.current = merged;
    return merged;
  }, [sessions.data]);
  const handledFocusRequestRef = useRef(0);
  const focusRowRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusTaskIdRef = useRef<string | null>(null);
  const [restoredRunningTasks, setRestoredRunningTasks] = useState<Map<string, ListedTask>>(
    () => new Map(),
  );

  const snapshotLiveTasks = useMemo(
    () => snapshot.tasks
      .filter((task) => task.status === 'running' || task.status === 'queued')
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    [snapshot.tasks],
  );

  useEffect(() => {
    setRestoredRunningTasks((current) => {
      if (current.size === 0) return current;
      const snapshotIds = new Set(snapshotLiveTasks.map((task) => task.taskRunId));
      let changed = false;
      const next = new Map(current);
      for (const id of current.keys()) {
        if (snapshotIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [snapshotLiveTasks]);

  const liveTasks = useMemo(() => {
    const byId = new Map(snapshotLiveTasks.map((task) => [task.taskRunId, task]));
    for (const [id, task] of restoredRunningTasks) {
      if (!byId.has(id)) byId.set(id, task);
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }, [snapshotLiveTasks, restoredRunningTasks]);

  const [finishedTasks, setFinishedTasks] = useState<Map<string, ListedTask>>(() => new Map());
  const knownTasksRef = useRef<Map<string, ActivityStatusTask>>(new Map());
  useEffect(() => {
    const previous = knownTasksRef.current;
    const next = new Map(liveTasks.map((task) => [task.taskRunId, task]));
    const now = Date.now();
    setFinishedTasks((current) => {
      const retained = new Map(current);
      let changed = false;
      for (const [id, task] of previous) {
        if (restoredRunningTasks.has(id)) continue;
        if (!next.has(id) && !retained.has(id)) {
          retained.set(id, { ...task, finishedAt: now });
          changed = true;
        }
      }
      for (const [id, task] of retained) {
        if (next.has(id)) {
          retained.delete(id);
          changed = true;
        } else if (task.finishedAt !== undefined && now - task.finishedAt > FINISHED_RETENTION_MS) {
          retained.delete(id);
          changed = true;
        }
      }
      return changed ? retained : current;
    });
    knownTasksRef.current = next;
  }, [liveTasks, restoredRunningTasks]);

  useEffect(() => {
    if (finishedTasks.size === 0) return;
    const interval = setInterval(() => {
      setFinishedTasks((current) => {
        const now = Date.now();
        let changed = false;
        const next = new Map(current);
        for (const [id, task] of current) {
          if (task.finishedAt !== undefined && now - task.finishedAt > FINISHED_RETENTION_MS) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }, 60_000);
    return () => clearInterval(interval);
  }, [finishedTasks.size]);

  const liveTaskIds = useMemo(() => new Set(liveTasks.map((task) => task.taskRunId)), [liveTasks]);
  const allTasks = useMemo<ListedTask[]>(() => {
    const finishedList = [...finishedTasks.values()].filter((task) => !liveTaskIds.has(task.taskRunId));
    return [...liveTasks, ...finishedList];
  }, [liveTasks, finishedTasks, liveTaskIds]);

  const liveGraphs = useMemo(
    () => snapshot.taskgraphs.filter(isActiveGraph),
    [snapshot.taskgraphs],
  );
  const finishedGraphsInSnapshot = useMemo(
    () => snapshot.taskgraphs.filter((graph) => !isActiveGraph(graph)),
    [snapshot.taskgraphs],
  );

  const [finishedGraphs, setFinishedGraphs] = useState<Map<string, ListedGraph>>(() => new Map());
  const knownGraphsRef = useRef<Map<string, ActivityStatusTaskGraph>>(new Map());
  useEffect(() => {
    const previous = knownGraphsRef.current;
    const next = new Map(liveGraphs.map((graph) => [graph.taskgraphId, graph]));
    const now = Date.now();
    setFinishedGraphs((current) => {
      const retained = new Map(current);
      let changed = false;
      for (const [id, graph] of previous) {
        if (!next.has(id) && !retained.has(id)) {
          retained.set(id, { ...graph, finishedAt: now });
          changed = true;
        }
      }
      for (const [id, graph] of retained) {
        if (next.has(id)) {
          retained.delete(id);
          changed = true;
        } else if (graph.finishedAt !== undefined && now - graph.finishedAt > FINISHED_RETENTION_MS) {
          retained.delete(id);
          changed = true;
        }
      }
      return changed ? retained : current;
    });
    knownGraphsRef.current = next;
  }, [liveGraphs]);

  useEffect(() => {
    if (finishedGraphs.size === 0) return;
    const interval = setInterval(() => {
      setFinishedGraphs((current) => {
        const now = Date.now();
        let changed = false;
        const next = new Map(current);
        for (const [id, graph] of current) {
          if (graph.finishedAt !== undefined && now - graph.finishedAt > FINISHED_RETENTION_MS) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }, 60_000);
    return () => clearInterval(interval);
  }, [finishedGraphs.size]);

  const liveGraphIds = useMemo(() => new Set(liveGraphs.map((graph) => graph.taskgraphId)), [liveGraphs]);
  const retainedFinishedGraphs = useMemo(
    () => [...finishedGraphs.values()].filter((graph) => !liveGraphIds.has(graph.taskgraphId)),
    [finishedGraphs, liveGraphIds],
  );

  const taskRunIds = useMemo(
    () => allTasks.map((task) => task.taskRunId).sort(),
    [allTasks],
  );
  const details = useActivityTaskDetails(taskRunIds);

  const isTaskActive = useCallback((task: ListedTask): boolean => {
    if (cancelledTasks.has(task.taskRunId)) return false;
    if (task.finishedAt !== undefined) return false;
    return task.status === 'running' || task.status === 'queued';
  }, [cancelledTasks]);

  const runningTasks = useMemo(
    () => allTasks.filter((task) => isTaskActive(task)),
    [allTasks, isTaskActive],
  );
  const finishedTasksList = useMemo(
    () => allTasks.filter((task) => !isTaskActive(task)),
    [allTasks, isTaskActive],
  );

  const runningGraphs = liveGraphs;
  const finishedGraphsList = useMemo(() => {
    const byId = new Map<string, ListedGraph>();
    for (const graph of finishedGraphsInSnapshot) {
      byId.set(graph.taskgraphId, graph);
    }
    for (const graph of retainedFinishedGraphs) {
      if (!byId.has(graph.taskgraphId)) byId.set(graph.taskgraphId, graph);
    }
    return [...byId.values()];
  }, [finishedGraphsInSnapshot, retainedFinishedGraphs]);

  const visibleFinishedTasks = finishedTasksList.filter((task) => !hiddenFinished.has(taskRowKey(task.taskRunId)));
  const visibleFinishedGraphs = finishedGraphsList.filter((graph) => !hiddenFinished.has(graphRowKey(graph)));

  const runningCount = runningTasks.length + runningGraphs.length;
  const finishedCount = visibleFinishedTasks.length + visibleFinishedGraphs.length;
  const empty = runningCount === 0 && finishedCount === 0;

  const stale = snapshot.stale || sessions.isError || details.isError;

  const openSession = (sessionId: string): void => {
    executeCommand('session.open', { sessionId });
  };

  const requestCancel = (taskRunId: string): void => {
    const match = liveTasks.find((task) => task.taskRunId === taskRunId);
    const preRequest = match !== undefined ? { ...match } : undefined;

    void cancelTask(taskRunId, (id) =>
      getSessionBridge().cancelTask(id).catch((error: unknown) => {
        if (preRequest !== undefined) {
          setRestoredRunningTasks((current) => {
            const next = new Map(current);
            next.set(preRequest.taskRunId, preRequest);
            return next;
          });
          setFinishedTasks((current) => {
            if (!current.has(preRequest.taskRunId)) return current;
            const next = new Map(current);
            next.delete(preRequest.taskRunId);
            return next;
          });
          setRunningGroupOpen(true);
        }
        throw error;
      }),
    ).then((confirmed) => {
      if (!confirmed) return;
      setFinishedGroupOpen(true);
      setExpandedKey(taskRowKey(taskRunId));
    });
  };

  const hideVisibleFinished = (): void => {
    setHiddenFinished((current) => {
      const next = new Set(current);
      for (const task of visibleFinishedTasks) next.add(taskRowKey(task.taskRunId));
      for (const graph of visibleFinishedGraphs) next.add(graphRowKey(graph));
      return next;
    });
  };

  const toggleExpand = (key: ExpandedKey): void => {
    setExpandedKey((current) => (current === key ? null : key));
  };

  useEffect(() => {
    const requestId = panelState.openRequestId;
    if (requestId === 0 || requestId === handledFocusRequestRef.current) return;
    const focusSession = panelState.scopeSession;
    if (focusSession === '') {
      handledFocusRequestRef.current = requestId;
      return;
    }

    setRunningGroupOpen(true);

    if (sessions.isPending || sessions.isError) return;

    const linkedRunning = runningTasks
      .filter((task) => sessionLinks.get(task.taskRunId)?.sessionId === focusSession)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    if (linkedRunning.length === 0) return;

    const latest = linkedRunning[linkedRunning.length - 1];
    setExpandedKey(taskRowKey(latest.taskRunId));
    handledFocusRequestRef.current = requestId;
    pendingFocusTaskIdRef.current = latest.taskRunId;
  }, [
    panelState.openRequestId,
    panelState.scopeSession,
    runningTasks,
    sessionLinks,
    sessions.isPending,
    sessions.isError,
  ]);

  useEffect(() => {
    const pendingTaskId = pendingFocusTaskIdRef.current;
    if (pendingTaskId === null) return;
    if (!runningGroupOpen) return;
    if (expandedKey !== taskRowKey(pendingTaskId)) return;
    if (focusRowRef.current === null) return;
    focusRowRef.current.scrollIntoView({ block: 'nearest' });
    pendingFocusTaskIdRef.current = null;
  }, [
    panelState.openRequestId,
    panelState.scopeSession,
    expandedKey,
    runningGroupOpen,
    runningTasks,
  ]);

  const renderTaskDuration = (task: ListedTask, active: boolean): React.ReactNode => {
    const brief = details.data?.find((item) => item.taskRunId === task.taskRunId);
    const locallyCancelled = cancelledTasks.has(task.taskRunId);
    const cancelled = locallyCancelled || brief?.status === 'cancelled';
    const failed = !cancelled && (brief?.status === 'failed' || brief?.status === 'interrupted');

    if (active && task.status === 'queued') {
      const position = task.queuePosition !== undefined ? ` #${task.queuePosition}` : '';
      return <span className="text-sm tabular-nums text-muted-foreground">排队{position}</span>;
    }

    const cancelTs = locallyCancelled ? cancelledTasks.get(task.taskRunId) : undefined;
    const endIso = cancelTs !== undefined
      ? new Date(cancelTs).toISOString()
      : task.finishedAt !== undefined
        ? new Date(task.finishedAt).toISOString()
        : undefined;
    const duration = (
      <Elapsed
        start={task.startedAt}
        end={active ? undefined : endIso}
        className="text-sm tabular-nums text-muted-foreground"
      />
    );

    if (cancelled) {
      return (
        <span className="flex items-center gap-1 text-sm tabular-nums">
          <span className="text-muted-foreground">已取消</span>
          {duration}
        </span>
      );
    }
    if (failed) {
      return (
        <span className="flex items-center gap-1 text-sm tabular-nums">
          <span className="text-destructive">失败</span>
          {duration}
        </span>
      );
    }
    return duration;
  };

  const renderTaskRow = (task: ListedTask, active: boolean): React.ReactNode => {
    const key = taskRowKey(task.taskRunId);
    const expanded = expandedKey === key;
    const brief = details.data?.find((item) => item.taskRunId === task.taskRunId);
    const label = task.taskLabel ?? brief?.taskName ?? task.taskId ?? task.taskRunId;
    const graph = snapshot.taskgraphs.find((item) => item.taskgraphId === task.taskgraphId)
      ?? finishedGraphsList.find((item) => item.taskgraphId === task.taskgraphId);
    const link = sessionLinks.get(task.taskRunId);
    const isFocusTarget = expanded && panelState.scopeSession !== ''
      && link?.sessionId === panelState.scopeSession;

    return (
      <div
        key={task.taskRunId}
        ref={isFocusTarget ? focusRowRef : undefined}
        className="flex flex-col gap-1"
      >
        <div
          className={cn(
            'group/task flex h-9 items-center gap-1 rounded-lg px-3',
            expanded && 'ring-1 ring-ring bg-accent/40',
          )}
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm"
            title={label}
            onClick={() => toggleExpand(key)}
          >
            {label}
          </button>
          <span className="flex shrink-0 items-center gap-0.5">
            {renderTaskDuration(task, active)}
            {active ? (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-hover/task:opacity-100 group-focus-within/task:opacity-100 focus-visible:opacity-100"
                      aria-label="取消任务"
                      onClick={() => requestCancel(task.taskRunId)}
                    />
                  )}
                >
                  <Square />
                </TooltipTrigger>
                <TooltipContent>取消任务</TooltipContent>
              </Tooltip>
            ) : null}
          </span>
          <button type="button" className="shrink-0 text-muted-foreground" onClick={() => toggleExpand(key)} aria-label={expanded ? '收起' : '展开'}>
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </div>
        {expanded ? (
          <div className="flex flex-col gap-2 px-1 pb-2">
            <div className="max-h-80 overflow-auto rounded-lg border bg-muted/30">
              <TaskTranscript
                key={task.taskRunId}
                taskRunId={task.taskRunId}
                loader={transcriptLoader}
                dark={dark}
                onOpenExternal={onOpenExternal}
              />
            </div>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {link ? (
                <>
                  <button type="button" className="hover:text-foreground" onClick={() => openSession(link.sessionId)}>
                    来自「{link.title}」
                  </button>
                  <span className="text-border">·</span>
                </>
              ) : null}
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => void shell.openTaskTranscript(task.taskRunId, task.taskLabel ?? brief?.taskName)}
              >
                在窗口中打开
              </button>
              {active ? (
                <>
                  <span className="text-border">·</span>
                  <button type="button" className="text-destructive hover:text-destructive/90" onClick={() => requestCancel(task.taskRunId)}>
                    取消任务
                  </button>
                </>
              ) : null}
              {graph ? (
                <>
                  <span className="text-border">·</span>
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() => void shell.openTaskGraph(graph.taskgraphId)}
                  >
                    任务图 {graph.title ?? graph.taskgraphId}
                  </button>
                </>
              ) : null}
            </p>
          </div>
        ) : null}
      </div>
    );
  };

  const renderGraphRow = (graph: ListedGraph, active: boolean): React.ReactNode => {
    const key = graphRowKey(graph);
    const expanded = expandedKey === key;
    const title = graph.title ?? graph.taskgraphId;

    return (
      <div key={graph.taskgraphId} className="flex flex-col gap-1">
        <div
          className={cn(
            'flex h-9 items-center gap-1 rounded-lg px-3',
            expanded && 'ring-1 ring-ring bg-accent/40',
          )}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => toggleExpand(key)}
          >
            <span className="min-w-0 flex-1 truncate text-sm" title={title}>{title}</span>
            <span className="shrink-0 text-sm text-muted-foreground">{graphStateLabel(graph, active)}</span>
            {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          </button>
        </div>
        {expanded ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pb-2 text-xs text-muted-foreground">
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => void shell.openTaskGraph(graph.taskgraphId)}
            >
              任务图 {title}
            </button>
            {!active ? <span>· {graphStateLabel(graph, active)}</span> : null}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 items-center justify-between gap-2 px-4">
        <span className="text-sm font-medium">后台任务</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="清除已结束" onClick={hideVisibleFinished}>
            <Trash2 />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={closeActivityPanel}>
            <X />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {stale ? <p className="px-2 py-1 text-xs text-warning">活动数据暂未更新</p> : null}
        {empty ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {sessions.isPending ? '正在读取活动…' : '没有后台任务'}
          </p>
        ) : (
          <>
            <button
              type="button"
              className="mb-1 flex w-full items-center gap-1 px-2 py-1 text-sm text-muted-foreground"
              onClick={() => setRunningGroupOpen((open) => !open)}
            >
              {runningGroupOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              <span>运行中 {runningCount}</span>
            </button>
            {runningGroupOpen ? (
              <div className="mb-3 flex flex-col gap-1">
                {runningGraphs.map((graph) => renderGraphRow(graph, true))}
                {runningTasks.map((task) => renderTaskRow(task, true))}
              </div>
            ) : null}

            <button
              type="button"
              className="mb-1 flex w-full items-center gap-1 px-2 py-1 text-sm text-muted-foreground"
              onClick={() => setFinishedGroupOpen((open) => !open)}
            >
              {finishedGroupOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              <span>已结束 {finishedCount}</span>
            </button>
            {finishedGroupOpen ? (
              <div className="flex flex-col gap-1">
                {visibleFinishedGraphs.map((graph) => renderGraphRow(graph, false))}
                {visibleFinishedTasks.map((task) => renderTaskRow(task, false))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
