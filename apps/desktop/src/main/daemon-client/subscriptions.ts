import type { ActivityPresence, DailyStatsSnapshot } from '../../shell-contract.js';
import type { AgentEventSignal, SessionMetaData } from './agent-types';
import { createDiagnosticLogger, type DiagnosticLogger } from './diagnostic-logger';
import { ActivitySnapshotPoller } from './activity-snapshot-poller';
import { ForemanEventPoller, type TaskUsageLiveUpdate } from './foreman-event-poller';
import { ForemanStatsPoller } from './foreman-stats-poller';
import { EventCursorStore } from './event-cursor-store';
import { WrenyardDaemonClient, type DaemonClient } from './client';

/** A transient one-shot Pet animation signal observed from the daemon stream. */
export interface PetEventSignal {
  workerKey: string;
  signal: AgentEventSignal;
  meta: SessionMetaData;
}

export interface DaemonSubscriptionHandlers {
  /** Fired for every transient signal; the Pet module decides what animates. */
  onSignal?(event: PetEventSignal): void;
  /** Fired with today's bounded stats, or `undefined` when unavailable. */
  onStats?(stats: DailyStatsSnapshot | undefined): void;
  /** Fired with the single shared activity presence round. */
  onActivity?(presence: ActivityPresence): void;
  /**
   * Fired with each pushed cumulative live-usage sample of a still-running
   * gateway task run. No replay: a subscriber that missed earlier samples
   * hydrates through `task.usage.liveList` instead.
   */
  onTaskUsageLive?(update: TaskUsageLiveUpdate): void;
}

export interface DaemonSubscriptionsOptions {
  client: DaemonClient;
  ipcPath: string;
  /** Ids of terminal graphs still held so the daemon returns each one once. */
  getTrackedTaskgraphIds?: () => string[];
  logger?: DiagnosticLogger;
  /**
   * Durable cursor store mirroring the in-memory event cursor so a process
   * restart resumes from the last observed cursor instead of skipping events
   * emitted while Desktop was closed.
   */
  cursorStore?: EventCursorStore;
  /** Key under which this endpoint's cursor is recorded in `cursorStore`. */
  endpointKey?: string;
}

/**
 * Desktop-owned shared daemon subscriptions. Exactly one event, stats and
 * activity poller exists for the whole Desktop process; the shell window, tray
 * and Pet all consume the same rounds. Subscribers attach/detach without
 * recreating timers, so hiding the Pet never stops the common data flow and
 * re-showing it never duplicates pollers.
 */
export class DaemonSubscriptions {
  private readonly client: DaemonClient;
  private ipcPath: string;
  private readonly getTrackedTaskgraphIds: () => string[];
  private readonly logger: DiagnosticLogger;
  private readonly cursorStore: EventCursorStore | undefined;
  private readonly endpointKey: string | undefined;
  private readonly handlers = new Set<DaemonSubscriptionHandlers>();
  private eventPoller: ForemanEventPoller | null = null;
  private statsPoller: ForemanStatsPoller | null = null;
  private activityPoller: ActivitySnapshotPoller | null = null;
  private started = false;
  private disposed = false;
  /**
   * Durable owner copy of the last observed event cursor. The poller is
   * disposable, so only this survives restarts on the same endpoint; a new
   * poller resumes from it instead of replaying history. Switching to a
   * different endpoint clears it, because the next daemon numbers its events
   * with an independent id sequence.
   */
  private eventCursor: string | undefined;
  /** Last observed rounds, replayed to a newly attached subscriber. */
  private lastStats: DailyStatsSnapshot | undefined;
  private lastActivity: ActivityPresence | undefined;

  constructor(options: DaemonSubscriptionsOptions) {
    this.client = options.client;
    this.ipcPath = options.ipcPath;
    this.getTrackedTaskgraphIds = options.getTrackedTaskgraphIds ?? (() => []);
    this.logger = options.logger ?? createDiagnosticLogger('desktop-daemon-events');
    this.cursorStore = options.cursorStore;
    this.endpointKey = options.endpointKey;
  }

  /** Start the shared pollers once for the process lifetime. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    const initialCursor = this.eventCursor
      ?? (this.cursorStore && this.endpointKey ? this.cursorStore.lookup(this.endpointKey) : undefined);
    this.eventPoller = new ForemanEventPoller({
      ipcPath: this.ipcPath,
      client: this.client,
      logger: this.logger,
      ...(initialCursor !== undefined ? { initialCursor } : {}),
      onCursor: (next) => {
        this.eventCursor = next;
        if (this.cursorStore && this.endpointKey) this.cursorStore.record(this.endpointKey, next);
      },
      onSignal: (workerKey, signal, meta) => {
        for (const handler of this.handlers) handler.onSignal?.({ workerKey, signal, meta });
      },
      onTaskUsageLive: (executionId, taskRunId, usage) => {
        for (const handler of this.handlers) handler.onTaskUsageLive?.({ executionId, taskRunId, usage });
      },
    });
    this.eventPoller.start();

    this.statsPoller = new ForemanStatsPoller({
      ipcPath: this.ipcPath,
      client: this.client,
      logger: this.logger,
      onStats: (stats) => {
        this.lastStats = stats;
        for (const handler of this.handlers) handler.onStats?.(stats);
      },
      onUnavailable: () => {
        this.lastStats = undefined;
        for (const handler of this.handlers) handler.onStats?.(undefined);
      },
    });
    this.statsPoller.start();

    this.activityPoller = new ActivitySnapshotPoller({
      ipcPath: this.ipcPath,
      client: this.client,
      logger: this.logger,
      getTrackedTaskgraphIds: () => this.getTrackedTaskgraphIds(),
      onPresence: (presence) => {
        this.lastActivity = presence;
        for (const handler of this.handlers) handler.onActivity?.(presence);
      },
    });
    this.activityPoller.start();
  }

  /**
   * Attach a subscriber and immediately replay the latest observed rounds so a
   * surface that was hidden resumes from the current snapshot instead of the
   * events it missed while detached. Returns a detach function.
   */
  subscribe(handlers: DaemonSubscriptionHandlers): () => void {
    this.handlers.add(handlers);
    if (this.lastStats !== undefined) handlers.onStats?.(this.lastStats);
    if (this.lastActivity !== undefined) handlers.onActivity?.(this.lastActivity);
    return () => {
      this.handlers.delete(handlers);
    };
  }

  /**
   * Follow the active endpoint across a connection transition.
   *
   * On the stable Desktop bridge the path never changes, so treating an
   * unchanged path as "nothing happened" would leave the previous context's
   * replayed snapshots and pending poll rounds in place. Every call therefore
   * invalidates and restarts: the replayed snapshots are dropped and the pollers
   * are stopped and started together, so they only reconnect once the switch is
   * committed. Restarting unconditionally also resumes pollers that a previous
   * unsettled period paused. A round that resolves after the restart is dropped
   * by the poller generation guard and by the shared client's generation fence.
   * A switch to a different endpoint also drops the event cursor: resuming from
   * the old daemon's cursor would stall above the new daemon's head or replay
   * its history, while a restart on the same endpoint keeps resuming from the
   * preserved cursor.
   */
  setEndpoint(path: string): void {
    if (this.disposed) return;
    const endpointChanged = path !== this.ipcPath;
    this.ipcPath = path;
    this.client.setPath(path);
    this.lastStats = undefined;
    this.lastActivity = undefined;
    this.pause();
    if (endpointChanged) {
      // Drop the durable entry before the memory cursor so a switched endpoint
      // can never resume from a stale cursor.
      if (this.cursorStore && this.endpointKey) this.cursorStore.clear(this.endpointKey);
      this.eventCursor = undefined;
    }
    this.start();
  }

  /** Current shared activity round, when one has been observed. */
  activity(): ActivityPresence | undefined {
    return this.lastActivity;
  }

  pause(): void {
    const presence = this.lastActivity;
    this.started = false;
    if (this.eventPoller) {
      this.eventCursor = this.eventPoller.getCursor();
      if (this.cursorStore && this.endpointKey && this.eventCursor !== undefined) {
        this.cursorStore.record(this.endpointKey, this.eventCursor);
      }
    }
    this.eventPoller?.stop();
    this.statsPoller?.stop();
    this.activityPoller?.stop();
    this.eventPoller = null;
    this.statsPoller = null;
    this.activityPoller = null;
    this.lastStats = undefined;
    this.lastActivity = undefined;
    this.client.reset();
    if (!this.disposed) {
      for (const handler of this.handlers) {
        handler.onStats?.(undefined);
        if (presence) handler.onActivity?.({ ...presence, stale: true });
      }
    }
  }

  reconnect(): void {
    this.pause();
    this.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.handlers.clear();
    this.client.close();
  }
}

export { WrenyardDaemonClient };
