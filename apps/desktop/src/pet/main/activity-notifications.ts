// ── Activity snapshot transition notifications ───────────────────────
// Pet-process-only, in-memory notification state. Every notification card
// derives from a state transition between two consecutive activity snapshot
// rounds — never from event.list and never from graph presence alone.
//
// Semantics:
// - cold start: the FIRST snapshot round emits exactly one recovery summary
//   card (已恢复：…), never a replay of per-graph history.
// - transitions: new graph / created→running / →done / first error pause /
//   paused→running / cancelled (+ node_failed exit).
// - dedup key: (taskgraph_id, from_state, to_state, latest_seq).
// - normal cards are transient and auto-expire after 8s; the first error
//   pause per episode is a dismissible sticky card revoked when the graph
//   resumes or reaches a terminal state.
// - the queue is bounded and serial: one card displays at a time, overflow
//   drops the oldest pending card, and no poll overwrites the card shown.

import type { ActivityPresence, ActivityTaskGraphPresence, ActivityTaskGraphState } from '../shared/activity-snapshot';
import type { BroadcastInput } from '../shared/broadcast';

export const NOTIFICATION_DURATION_MS = 8000;
export const MAX_NOTIFICATION_QUEUE = 5;
export const UNTITLED_TASKGRAPH_ZH = '未命名任务图';

export type TransitionKind =
  | 'created'
  | 'started'
  | 'completed'
  | 'error_paused'
  | 'resumed'
  | 'error_exit'
  | 'cancelled';

export interface GraphTransition {
  taskgraphId: string;
  fromState: ActivityTaskGraphState | null;
  toState: ActivityTaskGraphState;
  latestSeq: number;
  kind: TransitionKind;
  title?: string;
}

export interface ActivityNotification {
  id: string;
  text: string;
  intensity: 'transient' | 'sticky';
  untilMs?: number;
  /** Set for sticky error-pause cards; used to revoke on recovery/terminal. */
  stickyGraphId?: string;
}

function graphTitleZh(graph: { title?: string }): string {
  const title = graph.title?.trim();
  return title && title.length > 0 ? title : UNTITLED_TASKGRAPH_ZH;
}

function transitionKey(t: Pick<GraphTransition, 'taskgraphId' | 'fromState' | 'toState' | 'latestSeq'>): string {
  return `${t.taskgraphId}:${t.fromState ?? 'none'}->${t.toState}@${t.latestSeq}`;
}

function stickyIdFor(graphId: string): string {
  return `sticky-error-${graphId}`;
}

/**
 * Pure transition detection between two consecutive presence rounds. Returns
 * one entry per graph whose state moved across a notification boundary. A
 * graph that first appears already terminal is a cold-start replay and is
 * deliberately not notified here.
 */
export function detectGraphTransitions(
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
export function transitionTextZh(t: GraphTransition): string {
  const title = graphTitleZh(t);
  switch (t.kind) {
    case 'created': return `图纸已创建：${title}`;
    case 'started': return `图纸已启动：${title}`;
    case 'completed': return `图纸已完成：${title}`;
    case 'error_paused': return `图纸遇到错误，已暂停：${title}`;
    case 'resumed': return `图纸已恢复：${title}`;
    case 'error_exit': return `图纸因错误退出：${title}`;
    case 'cancelled': return `图纸已取消：${title}`;
    default: return title;
  }
}

/** Chinese cold-start recovery summary; null when there is nothing to resume. */
export function buildColdStartSummary(presence: ActivityPresence): string | null {
  const running = presence.tasks.filter((t) => t.status === 'running').length;
  const queued = presence.tasks.filter((t) => t.status === 'queued').length;
  const graphs = presence.taskgraphs.filter((g) => g.state !== 'done' && g.state !== 'cancelled').length;
  if (running === 0 && queued === 0 && graphs === 0) return null;
  let text = `已恢复：${running} 个任务运行中`;
  if (queued > 0) text += ` · ${queued} 个排队`;
  if (graphs > 0) text += ` · ${graphs} 张图纸`;
  return text;
}

interface GraphRegistryEntry {
  state: ActivityTaskGraphState;
  lastKey: string | null;
  stickyError: boolean;
}

export class ActivityNotificationQueue {
  private readonly now: () => number;
  private seenFirstSnapshot = false;
  private lastPresence: ActivityPresence | null = null;
  private registry = new Map<string, GraphRegistryEntry>();
  private queue: ActivityNotification[] = [];
  private current: ActivityNotification | null = null;
  private nextId = 0;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  getCurrent(): ActivityNotification | null {
    return this.current;
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  /**
   * Feed a fresh (non-stale) presence round. Returns the broadcast card to
   * display when the current card changed (new card shown or slot promoted);
   * returns null when the displayed card is unchanged.
   */
  applyPresence(presence: ActivityPresence): BroadcastInput | null {
    const before = this.current;

    if (!this.seenFirstSnapshot) {
      this.seenFirstSnapshot = true;
      this.lastPresence = presence;
      this.registry.clear();
      for (const g of presence.taskgraphs) {
        this.registry.set(g.taskgraphId, { state: g.state, lastKey: null, stickyError: false });
      }
      this.queue = [];
      this.current = null;
      const summary = buildColdStartSummary(presence);
      if (summary) {
        this.current = this.makeCard('cold-start', summary, 'transient');
      }
    } else {
      const transitions = detectGraphTransitions(this.lastPresence, presence);
      for (const t of transitions) {
        this.applyTransition(t);
      }
      // Keep registry state current for graphs that did not cross a boundary.
      for (const g of presence.taskgraphs) {
        const entry = this.registry.get(g.taskgraphId);
        if (entry) entry.state = g.state;
      }
      // A graph that vanished from the snapshot revokes its sticky error card.
      for (const [id, entry] of this.registry) {
        if (entry.stickyError && !presence.taskgraphs.some((g) => g.taskgraphId === id)) {
          entry.stickyError = false;
          this.revokeSticky(id);
        }
      }
      this.lastPresence = presence;
    }

    if (this.current === null) this.promote();
    return this.current !== before ? (this.current ? toBroadcastInput(this.current) : null) : null;
  }

  /** Advance when the currently displayed transient card expired. */
  advanceAfterExpiry(currentId?: string): BroadcastInput | null {
    if (!this.current) return null;
    if (currentId !== undefined && this.current.id !== currentId) return null;
    this.current = null;
    return this.promote();
  }

  /** Dismiss the current card (or a queued one by id). Returns the next card. */
  dismiss(id?: string): BroadcastInput | null {
    if (this.current && (id === undefined || this.current.id === id)) {
      this.current = null;
      return this.promote();
    }
    if (id !== undefined) {
      this.queue = this.queue.filter((n) => n.id !== id);
    }
    return null;
  }

  /** True when the given id is the currently displayed notification card. */
  isCurrent(id: string | undefined): boolean {
    return this.current !== null && this.current.id === id;
  }

  private applyTransition(t: GraphTransition): void {
    const entry = this.registry.get(t.taskgraphId) ?? { state: t.toState, lastKey: null, stickyError: false };
    entry.state = t.toState;

    if (t.kind === 'error_paused') {
      // First error pause per episode only; it stays sticky until revoked.
      if (entry.stickyError) return;
      entry.stickyError = true;
      entry.lastKey = transitionKey(t);
      this.registry.set(t.taskgraphId, entry);
      this.emit(this.makeCard(stickyIdFor(t.taskgraphId), transitionTextZh(t), 'sticky', t.taskgraphId));
      return;
    }

    // Non-error transitions revoke any sticky error card for the graph.
    if (entry.stickyError) {
      entry.stickyError = false;
      this.revokeSticky(t.taskgraphId);
    }
    const key = transitionKey(t);
    if (entry.lastKey === key) {
      this.registry.set(t.taskgraphId, entry);
      return;
    }
    entry.lastKey = key;
    this.registry.set(t.taskgraphId, entry);
    this.emit(this.makeCard(t.taskgraphId, transitionTextZh(t), 'transient'));
  }

  private revokeSticky(graphId: string): void {
    if (this.current?.stickyGraphId === graphId) {
      this.current = null;
    }
    this.queue = this.queue.filter((n) => n.stickyGraphId !== graphId);
  }

  private emit(card: ActivityNotification): void {
    if (!this.current) {
      this.current = card;
      return;
    }
    if (this.queue.length >= MAX_NOTIFICATION_QUEUE) {
      this.queue.shift(); // bounded: drop the oldest pending card
    }
    this.queue.push(card);
  }

  private promote(): BroadcastInput | null {
    if (this.current !== null) return this.current ? toBroadcastInput(this.current) : null;
    const next = this.queue.shift();
    if (!next) return null;
    this.current = next;
    return toBroadcastInput(next);
  }

  private makeCard(idHint: string, text: string, intensity: 'transient' | 'sticky', stickyGraphId?: string): ActivityNotification {
    const id = `${idHint}-${++this.nextId}`;
    return {
      id,
      text,
      intensity,
      ...(intensity === 'transient' ? { untilMs: this.now() + NOTIFICATION_DURATION_MS } : {}),
      ...(stickyGraphId !== undefined ? { stickyGraphId } : {}),
    };
  }
}

function toBroadcastInput(notification: ActivityNotification): BroadcastInput {
  return {
    id: notification.id,
    text: notification.text,
    intensity: notification.intensity,
    ...(notification.untilMs !== undefined ? { untilMs: notification.untilMs } : {}),
  };
}
