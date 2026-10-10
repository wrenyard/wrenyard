// TaskGraph producer: in-app notifications for presence state transitions; the first snapshot is a cold start and is not notified.

import type {
  ActivityPresence,
  ActivityTaskGraphPresence,
  ActivityTaskGraphState,
} from '../../pet/shared/activity-snapshot.js';
import type { AppNotification, NotificationLevel, Notifier } from './notifier.js';

const UNTITLED_TASKGRAPH_ZH = '未命名任务图';

type TransitionKind =
  | 'created'
  | 'started'
  | 'completed'
  | 'error_paused'
  | 'resumed'
  | 'error_exit'
  | 'cancelled';

interface GraphTransition {
  taskgraphId: string;
  fromState: ActivityTaskGraphState | null;
  toState: ActivityTaskGraphState;
  latestSeq: number;
  kind: TransitionKind;
  title?: string;
}

function graphTitleZh(graph: { title?: string }): string {
  const title = graph.title?.trim();
  return title && title.length > 0 ? title : UNTITLED_TASKGRAPH_ZH;
}

/**
 * Pure transition detection between two consecutive presence rounds. Returns
 * one entry per graph whose state moved across a notification boundary. A
 * graph that first appears already terminal is a cold-start replay and is
 * deliberately not notified here.
 */
function detectGraphTransitions(
  prev: ActivityPresence | null,
  next: ActivityPresence,
): GraphTransition[] {
  if (!prev) return [];
  const prevGraphs = new Map(prev.taskgraphs.map((g) => [g.taskgraphId, g]));
  const out: GraphTransition[] = [];
  for (const graph of next.taskgraphs) {
    const before = prevGraphs.get(graph.taskgraphId);
    const transition = detectSingleGraphTransition(before, graph);
    if (transition) out.push(transition);
  }
  return out;
}

function detectSingleGraphTransition(
  before: ActivityTaskGraphPresence | undefined,
  graph: ActivityTaskGraphPresence,
): GraphTransition | null {
  const fromState = before?.state ?? null;
  const toState = graph.state;
  const base = { taskgraphId: graph.taskgraphId, fromState, toState, latestSeq: graph.latestSeq, title: graph.title };
  if (fromState === null) {
    if (toState === 'done' || toState === 'cancelled') return null;
    return { ...base, kind: 'created' as const };
  }
  if (fromState === toState) return null;
  if (toState === 'done') return { ...base, kind: 'completed' as const };
  if (toState === 'cancelled') {
    return { ...base, kind: graph.terminalReason === 'node_failed' ? ('error_exit' as const) : ('cancelled' as const) };
  }
  if (toState === 'running' && fromState === 'created') return { ...base, kind: 'started' as const };
  if (toState === 'running' && fromState === 'paused') return { ...base, kind: 'resumed' as const };
  if (toState === 'paused' && graph.nodeCounts.failed > 0) return { ...base, kind: 'error_paused' as const };
  return null;
}

/** Chinese notification text for a transition (graph title fallback included). */
function transitionTextZh(t: GraphTransition): string {
  const title = graphTitleZh(t);
  switch (t.kind) {
    case 'created': return `图纸已创建：${title}`;
    case 'started': return `图纸已启动：${title}`;
    case 'completed': return `图纸已完成：${title}`;
    case 'error_paused': return `图纸遇到错误，已暂停：${title}`;
    case 'resumed': return `图纸已恢复：${title}`;
    case 'error_exit': return `图纸因错误退出：${title}`;
    case 'cancelled': return `图纸已取消：${title}`;
  }
}

function levelFor(kind: TransitionKind): NotificationLevel {
  if (kind === 'completed') return 'success';
  if (kind === 'error_paused' || kind === 'error_exit') return 'error';
  return 'info';
}

function transitionKey(t: GraphTransition): string {
  return `${t.fromState ?? 'none'}->${t.toState}@${t.latestSeq}`;
}

export interface TaskGraphNotifier {
  observe(presence: ActivityPresence): void;
}

export interface TaskGraphNotifierDeps {
  notifier: Notifier;
}

export function createTaskGraphNotifier(deps: TaskGraphNotifierDeps): TaskGraphNotifier {
  let lastPresence: ActivityPresence | null = null;
  const registry = new Map<string, { lastKey: string | null }>();
  let sequence = 0;

  function apply(t: GraphTransition): void {
    const entry = registry.get(t.taskgraphId) ?? { lastKey: null };
    registry.set(t.taskgraphId, entry);
    const key = transitionKey(t);
    if (entry.lastKey === key) return;
    entry.lastKey = key;
    sequence += 1;
    const notification: AppNotification = {
      id: `taskgraph:${t.taskgraphId}:${t.fromState ?? 'none'}->${t.toState}@${sequence}`,
      level: levelFor(t.kind),
      title: transitionTextZh(t),
    };
    deps.notifier.notify(notification, ['inApp']);
  }

  return {
    observe(presence: ActivityPresence): void {
      if (presence.stale) return;
      if (lastPresence === null) {
        for (const graph of presence.taskgraphs) registry.set(graph.taskgraphId, { lastKey: null });
        lastPresence = presence;
        return;
      }
      for (const transition of detectGraphTransitions(lastPresence, presence)) apply(transition);
      const liveIds = new Set(presence.taskgraphs.map((graph) => graph.taskgraphId));
      for (const id of [...registry.keys()]) {
        if (!liveIds.has(id)) registry.delete(id);
      }
      lastPresence = presence;
    },
  };
}
