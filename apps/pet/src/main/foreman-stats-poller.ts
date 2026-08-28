import type { DailyStatsSnapshot } from '../shared/snapshot';
import type { DiagnosticLogger } from './diagnostic-logger';
import { ForemanIpcClient, resolveForemanIpcPath } from './foreman-ipc-client';
import type { ForemanIpcRequestOptions } from './foreman-ipc-client';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export type ForemanStatsRequest = (method: string, params?: unknown, options?: ForemanIpcRequestOptions) => Promise<unknown>;

export interface ForemanStatsPollerOptions {
  ipcPath?: string;
  intervalMs?: number;
  request?: ForemanStatsRequest;
  logger?: DiagnosticLogger;
  onStats: (stats: DailyStatsSnapshot) => void;
  onUnavailable?: () => void;
}

/**
 * Pet only needs today's bounded totals to render its observational house Tips.
 * Full history, rankings and period analytics belong to Wrenyard Desktop.
 */
export class ForemanStatsPoller {
  private readonly ipcPath: string;
  private readonly intervalMs: number;
  private readonly request: ForemanStatsRequest;
  private readonly logger: DiagnosticLogger | undefined;
  private readonly onStats: ForemanStatsPollerOptions['onStats'];
  private readonly onUnavailable: ForemanStatsPollerOptions['onUnavailable'];
  private readonly client: ForemanIpcClient | undefined;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private running = false;
  private generation = 0;
  private lastErrorSignature: string | null = null;
  private consecutiveFailures = 0;

  constructor(opts: ForemanStatsPollerOptions) {
    this.ipcPath = opts.ipcPath ?? resolveForemanIpcPath();
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (opts.request) {
      this.request = opts.request;
    } else {
      this.client = new ForemanIpcClient({ path: this.ipcPath });
      this.request = (method, params, options?) => this.client!.request(method, params, options);
    }
    this.logger = opts.logger;
    this.onStats = opts.onStats;
    this.onUnavailable = opts.onUnavailable;
  }

  getIpcPath(): string {
    return this.ipcPath;
  }

  start(): void {
    if (this.intervalId !== null || this.running) return;
    this.running = true;
    this.generation += 1;
    this.consecutiveFailures = 0;
    const generation = this.generation;
    void this.pollOnce(generation).then(() => this.scheduleNext(generation));
  }

  stop(): void {
    if (this.intervalId !== null) clearTimeout(this.intervalId);
    this.intervalId = null;
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
  }

  async pollOnce(expectedGeneration?: number): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.pollToday(expectedGeneration);
    } finally {
      this.inFlight = false;
    }
  }

  private scheduleNext(generation: number): void {
    if (this.isStoppedGeneration(generation)) {
      this.intervalId = null;
      return;
    }
    const multiplier = Math.pow(2, this.consecutiveFailures);
    const delay = Math.min(this.intervalMs * multiplier, MAX_BACKOFF_MS);
    this.intervalId = setTimeout(() => {
      this.intervalId = null;
      void this.pollOnce(generation).then(() => this.scheduleNext(generation));
    }, delay);
  }

  private async pollToday(expectedGeneration?: number): Promise<void> {
    try {
      const payload = await this.request('stats.today', {});
      if (this.isStoppedGeneration(expectedGeneration)) return;
      const stats = normalizeStatsPayload(payload);
      this.consecutiveFailures = 0;
      if (this.lastErrorSignature !== null) {
        this.logger?.info('foreman_stats_poll_recovered', { previousError: this.lastErrorSignature });
        this.lastErrorSignature = null;
      }
      this.onStats(stats);
    } catch (error) {
      if (this.isStoppedGeneration(expectedGeneration)) return;
      this.consecutiveFailures += 1;
      const signature = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      if (signature !== this.lastErrorSignature) {
        this.logger?.warn('foreman_stats_poll_error', {
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        this.lastErrorSignature = signature;
      }
      this.onUnavailable?.();
    }
  }

  private isStoppedGeneration(expectedGeneration: number | undefined): boolean {
    return expectedGeneration !== undefined && (!this.running || this.generation !== expectedGeneration);
  }
}

export function normalizeStatsPayload(payload: unknown): DailyStatsSnapshot {
  if (!isRecord(payload)) {
    throw new TypeError('normalizeStatsPayload: payload must be a non-null object');
  }
  if (payload.source !== 'sqlite') {
    throw new TypeError(`normalizeStatsPayload: source must be "sqlite", got "${String(payload.source)}"`);
  }
  if (typeof payload.dayKey !== 'string') {
    throw new TypeError('normalizeStatsPayload: dayKey must be a string');
  }
  if (typeof payload.startAt !== 'string') {
    throw new TypeError('normalizeStatsPayload: startAt must be a string');
  }
  if (typeof payload.endAt !== 'string') {
    throw new TypeError('normalizeStatsPayload: endAt must be a string');
  }

  return {
    dayKey: payload.dayKey,
    startAt: payload.startAt,
    endAt: payload.endAt,
    dispatchCount: nonNegativeFinite(payload.dispatchCount, 'dispatchCount'),
    inputTokens: nonNegativeFinite(payload.inputTokens, 'inputTokens'),
    outputTokens: nonNegativeFinite(payload.outputTokens, 'outputTokens'),
    totalTokens: nonNegativeFinite(payload.totalTokens, 'totalTokens'),
    source: 'sqlite',
  };
}

function nonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`normalizeStatsPayload: ${field} must be a non-negative finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
