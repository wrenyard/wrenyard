import type { ActivityPresence } from '../../pet/shared/activity-snapshot';
import type { DailyStatsSnapshot } from '../../pet/shared/snapshot';
import type { AgentEventSignal } from '../../pet/main/agent-types';
import type { SessionMetaData } from '../../pet/main/agent-types';
import { createDiagnosticLogger, type DiagnosticLogger } from './diagnostic-logger';
import { ActivitySnapshotPoller } from './activity-snapshot-poller';
import { ForemanEventPoller } from './foreman-event-poller';
import { ForemanStatsPoller } from './foreman-stats-poller';
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
}

export interface DaemonSubscriptionsOptions {
  client: DaemonClient;
  ipcPath: string;
  /** Ids of terminal graphs still held so the daemon returns each one once. */
  getTrackedTaskgraphIds?: () => string[];
  logger?: DiagnosticLogger;
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
  private readonly ipcPath: string;
  private readonly getTrackedTaskgraphIds: () => string[];
  private readonly logger: DiagnosticLogger;
  private readonly handlers = new Set<DaemonSubscriptionHandlers>();
  private eventPoller: ForemanEventPoller | null = null;
  private statsPoller: ForemanStatsPoller | null = null;
  private activityPoller: ActivitySnapshotPoller | null = null;
  private started = false;
  private disposed = false;
  /** Last observed rounds, replayed to a newly attached subscriber. */
  private lastStats: DailyStatsSnapshot | undefined;
  private lastActivity: ActivityPresence | undefined;

  constructor(options: DaemonSubscriptionsOptions) {
    this.client = options.client;
    this.ipcPath = options.ipcPath;
    this.getTrackedTaskgraphIds = options.getTrackedTaskgraphIds ?? (() => []);
    this.logger = options.logger ?? createDiagnosticLogger('desktop-daemon-events');
  }

  /** Start the shared pollers once for the process lifetime. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    this.eventPoller = new ForemanEventPoller({
      ipcPath: this.ipcPath,
      client: this.client,
      logger: this.logger,
      onSignal: (workerKey, signal, meta) => {
        for (const handler of this.handlers) handler.onSignal?.({ workerKey, signal, meta });
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

  /** Current shared activity round, when one has been observed. */
  activity(): ActivityPresence | undefined {
    return this.lastActivity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eventPoller?.stop();
    this.statsPoller?.stop();
    this.activityPoller?.stop();
    this.eventPoller = null;
    this.statsPoller = null;
    this.activityPoller = null;
    this.handlers.clear();
    this.client.close();
  }
}

export { WrenyardDaemonClient };
