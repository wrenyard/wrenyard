// ── Unique activity.snapshot poller (presence SSOT) ──────────────────
// The single generation-gated owner of Pet presence. Every 2s it requests
// foreman.activity.snapshot v1, strictly normalizes the response, and
// atomically publishes a derived ActivityPresence. Any read/normalization/
// projection failure discards the whole round: the previous complete
// presence is re-emitted with stale=true so house/worker/Wren/Graph Slip
// uniformly retain their last state instead of partially clearing. Event
// history is never replayed to determine presence.

import type { DiagnosticLogger } from './diagnostic-logger';
import { ForemanIpcClient, resolveForemanIpcPath } from './foreman-ipc-client';
import type { ForemanIpcRequestOptions } from './foreman-ipc-client';
import {
  ACTIVITY_SNAPSHOT_SCHEMA_VERSION,
  deriveActivityPresence,
  normalizeActivitySnapshotV1,
  normalizeTrackedTaskgraphIds,
  type ActivityPresence,
} from '../shared/activity-snapshot';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_BACKOFF_MS = 60000;

export type ActivitySnapshotRequest = (method: string, params?: unknown, options?: ForemanIpcRequestOptions) => Promise<unknown>;

export interface ActivitySnapshotPollerOptions {
  ipcPath?: string;
  intervalMs?: number;
  request?: ActivitySnapshotRequest;
  logger?: DiagnosticLogger;
  /** Ids of terminal graphs Pet still holds so the daemon returns them once. */
  getTrackedTaskgraphIds?: () => string[];
  onPresence: (presence: ActivityPresence) => void;
}

export class ActivitySnapshotPoller {
  private readonly ipcPath: string;
  private readonly intervalMs: number;
  private readonly request: ActivitySnapshotRequest;
  private readonly logger: DiagnosticLogger | undefined;
  private readonly getTrackedTaskgraphIds: (() => string[]) | undefined;
  private readonly onPresence: (presence: ActivityPresence) => void;
  private readonly client: ForemanIpcClient | undefined;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private running = false;
  private generation = 0;
  private lastPresence: ActivityPresence | null = null;
  private consecutiveFailures = 0;
  private lastFailureClass: SnapshotFailureClass | null = null;

  constructor(opts: ActivitySnapshotPollerOptions) {
    this.ipcPath = opts.ipcPath ?? resolveForemanIpcPath();
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (opts.request) {
      this.request = opts.request;
    } else {
      this.client = new ForemanIpcClient({ path: this.ipcPath });
      this.request = (method, params, options?) => this.client!.request(method, params, options);
    }
    this.logger = opts.logger;
    this.getTrackedTaskgraphIds = opts.getTrackedTaskgraphIds;
    this.onPresence = opts.onPresence;
  }

  getIpcPath(): string {
    return this.ipcPath;
  }

  start(): void {
    if (this.intervalId !== null || this.running) return;

    this.running = true;
    this.generation++;
    this.consecutiveFailures = 0;
    const generation = this.generation;
    void this.pollOnce(generation).then(() => this.scheduleNext(generation));
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearTimeout(this.intervalId);
    }
    this.intervalId = null;
    if (this.running) {
      this.running = false;
      this.generation++;
    }
  }

  async pollOnce(expectedGeneration?: number): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      await this.pollActivity(expectedGeneration);
    } finally {
      this.inFlight = false;
    }
  }

  private scheduleNext(generation: number): void {
    if (this.isStoppedGeneration(generation)) {
      this.intervalId = null;
      return;
    }
    const delay = this.computeNextInterval();
    this.intervalId = setTimeout(() => {
      this.intervalId = null;
      void this.pollOnce(generation).then(() => this.scheduleNext(generation));
    }, delay);
  }

  private computeNextInterval(): number {
    if (this.consecutiveFailures === 0) return this.intervalMs;
    const multiplier = Math.pow(2, this.consecutiveFailures);
    return Math.min(this.intervalMs * multiplier, MAX_BACKOFF_MS);
  }

  private async pollActivity(expectedGeneration?: number): Promise<void> {
    try {
      const tracked = normalizeTrackedTaskgraphIds(this.getTrackedTaskgraphIds?.() ?? []);
      const raw = await this.request('activity.snapshot', {
        tracked_taskgraph_ids: tracked,
      });
      if (this.isStoppedGeneration(expectedGeneration)) return;

      const snapshot = normalizeActivitySnapshotV1(raw);
      if (this.isStoppedGeneration(expectedGeneration)) return;

      const presence = deriveActivityPresence(snapshot, false);
      this.lastPresence = presence;
      this.consecutiveFailures = 0;
      if (this.lastFailureClass !== null) {
        this.logger?.info('foreman_activity_poll_recovered', { previousFailureClass: this.lastFailureClass });
        this.lastFailureClass = null;
      }
      this.onPresence(presence);
    } catch (err) {
      if (this.isStoppedGeneration(expectedGeneration)) return;
      const failureClass = classifySnapshotFailure(err);
      if (failureClass !== this.lastFailureClass) {
        this.logger?.warn('foreman_activity_poll_failed', { failureClass });
        this.lastFailureClass = failureClass;
      }
      this.consecutiveFailures++;
      // Discard the failed round: re-publish the previous complete state as
      // uniformly stale. Consumers keep every surface (house, workers, Wren,
      // Graph Slip) instead of clearing any one of them.
      if (this.lastPresence) {
        this.onPresence({ ...this.lastPresence, stale: true });
      }
    }
  }

  private isStoppedGeneration(expectedGeneration: number | undefined): boolean {
    return expectedGeneration !== undefined && (!this.running || this.generation !== expectedGeneration);
  }
}

// ── Content-free failure classification (d-4 reuse) ──────────────────
// The thrown value is reduced to a closed failure class so raw error
// payloads, server objects, or tokens can never reach the log.
export type SnapshotFailureClass =
  | 'error'
  | 'non_error_null'
  | 'non_error_string'
  | 'non_error_object'
  | 'non_error_undefined'
  | 'non_error_number'
  | 'non_error_boolean'
  | 'non_error_bigint'
  | 'non_error_symbol'
  | 'non_error_function';

export function classifySnapshotFailure(err: unknown): SnapshotFailureClass {
  if (err === null) return 'non_error_null';
  if (err === undefined) return 'non_error_undefined';
  switch (typeof err) {
    case 'object':
      try {
        return err instanceof Error ? 'error' : 'non_error_object';
      } catch {
        return 'non_error_object';
      }
    case 'string':
      return 'non_error_string';
    case 'number':
      return 'non_error_number';
    case 'boolean':
      return 'non_error_boolean';
    case 'bigint':
      return 'non_error_bigint';
    case 'symbol':
      return 'non_error_symbol';
    case 'function':
      return 'non_error_function';
    default:
      return 'non_error_object';
  }
}

export { ACTIVITY_SNAPSHOT_SCHEMA_VERSION };
