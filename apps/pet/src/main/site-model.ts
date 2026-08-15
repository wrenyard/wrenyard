import type { Phase, WorkerSnapshot, SiteSnapshot, SessionMetaData } from '../shared/snapshot';
import type { BroadcastInput, BroadcastSnapshot } from '../shared/broadcast';
import { normalizeBroadcast, shouldExpireBroadcast } from '../shared/broadcast';
import type { ActivityPresence, ActivityTaskPresence } from '../shared/activity-snapshot';
import { ActivityNotificationQueue } from './activity-notifications';
import type {
  ForgeEventSignal,
  LifecycleSignal,
  ToolResultSignal,
  ToolUseSignal,
  TurnUsageSignal,
  TextSignal,
} from './forge-types';

type InputSignal =
  | ForgeEventSignal
  | { kind: 'terminate' };

interface WorkerState {
  workerIdentityKey: string;
  profile: string;
  phase: Phase;
  phaseSinceMs: number;
  toolCount: number;
  firstSentence?: string;
  lastText?: string;
  deliverySummary?: string;
  bubbleUntilMs?: number;
  lastToolName?: string;
  lastToolStatus?: 'ok' | 'error';
  lastToolOutputTail?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  startedAt: number;
  meta: SessionMetaData;
}

export class SiteModel {
  private workers = new Map<string, WorkerState>();
  private queued = new Set<string>();
  private callbacks: Array<(snap: SiteSnapshot) => void> = [];
  private now: () => number;
  private broadcast?: BroadcastSnapshot;
  private activityStale = false;
  private taskgraphCount = 0;
  private notifications: ActivityNotificationQueue;
  private readonly celebrateMs = 4000;
  private readonly dejectedMs = 4000;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
    this.notifications = new ActivityNotificationQueue({ now: this.now });
  }

  ingest(signal: InputSignal, meta: SessionMetaData | null): void {
    const t = signal.kind === 'terminate'
      ? this.now()
      : ('ts' in signal ? signal.ts : this.now());

    if (signal.kind === 'terminate') {
      if (meta) {
        this.workers.delete(meta.workerIdentityKey);
        this.queued.delete(meta.workerIdentityKey);
      }
      this.emit();
      return;
    }

    if (signal.kind === 'queued') {
      if (meta) {
        this.workers.delete(meta.workerIdentityKey);
        this.queued.add(meta.workerIdentityKey);
      }
      this.emit();
      return;
    }

    if (meta) {
      this.queued.delete(meta.workerIdentityKey);
    }

    const worker = meta ? this.workerForSignal(signal, meta, t) : undefined;

    if (worker) {
      // Merge new meta with old meta so optional fields (taskId, taskName,
      // taskLabel, label, project, clientFamily, workDir) survive when the
      // new event omits them or gives empty string values.
      const mergedMeta: SessionMetaData = {
        ...worker.meta,
        ...meta!,
        // Preserve old non-empty optional values when new meta gives empty strings
        workDir: meta!.workDir || worker.meta.workDir,
        taskId: meta!.taskId || worker.meta.taskId,
        taskName: meta!.taskName || worker.meta.taskName,
        taskLabel: meta!.taskLabel || worker.meta.taskLabel,
        label: meta!.label || worker.meta.label,
        project: meta!.project || worker.meta.project,
        clientFamily: meta!.clientFamily || worker.meta.clientFamily,
      };
      worker.profile = mergedMeta.profile;
      worker.meta = mergedMeta;
      this.applySignal(worker, signal, t);
    }

    this.emit();
  }

  /**
   * Atomically reconcile worker presence from the single activity snapshot.
   * Running tasks become workers, queued tasks set the queue count, and
   * workers whose task left the snapshot depart. A stale round keeps the
   * previous complete state untouched and only flips the stale flag — partial
   * clearing is forbidden. Snapshot state transitions drive the bounded
   * notification queue; the very first snapshot emits only a recovery summary.
   */
  reconcileActivity(input: ActivityPresence): void {
    if (input.stale) {
      if (!this.activityStale) {
        this.activityStale = true;
        this.emit();
      }
      return;
    }

    this.activityStale = false;
    const now = this.now();
    const running = input.tasks.filter((t) => t.status === 'running');
    const queued = new Set(input.tasks.filter((t) => t.status === 'queued').map((t) => t.taskRunId));

    // Non-terminal TaskGraph drawings; stale keeps the previous count.
    this.taskgraphCount = input.taskgraphs.filter((g) => g.state !== 'done' && g.state !== 'cancelled').length;

    const next = new Map<string, WorkerState>();
    for (const task of running) {
      const key = task.taskRunId;
      const existing = this.workers.get(key);
      if (existing) {
        const meta = { ...existing.meta, ...metaFromPresence(task) };
        existing.profile = meta.profile;
        existing.meta = meta;
        // The snapshot is authoritative: a task the snapshot still lists as
        // running keeps a working worker no matter what the event stream says.
        existing.phase = 'working';
        existing.phaseSinceMs = now;
        existing.startedAt = Math.min(existing.startedAt, now);
        next.set(key, existing);
      } else {
        next.set(key, {
          workerIdentityKey: key,
          profile: task.resolvedProfile ?? 'foreman',
          phase: 'working',
          phaseSinceMs: now,
          toolCount: 0,
          startedAt: now,
          meta: metaFromPresence(task),
        });
      }
    }

    this.workers = next;
    this.queued = queued;

    // Notification cards only derive from fresh snapshot transitions.
    const card = this.notifications.applyPresence(input);
    if (card) {
      this.broadcast = normalizeBroadcast(card);
    }
    this.emit();
  }

  /**
   * Transient-only event ingestion. Message/tool/usage signals enrich an
   * existing worker (matched by identity key, then task_run_id, then task_id).
   * Lifecycle signals (spawn/queued/working/sleeping/done/failed/terminate)
   * are ignored here: they must never create/delete workers or change
   * running/queued — presence is owned by the activity snapshot.
   */
  ingestTransient(signal: ForgeEventSignal, meta: SessionMetaData | null): void {
    if (!meta) return;
    const worker = this.resolveWorker(meta);
    if (!worker) return;
    switch (signal.kind) {
      case 'message':
        this.applyText(worker, signal);
        break;
      case 'tool_call':
        this.applyToolUse(worker, signal);
        break;
      case 'tool_result':
        this.applyToolResult(worker, signal);
        break;
      case 'turn_usage':
        this.applyTurnUsage(worker, signal);
        break;
      default:
        return;
    }
    this.emit();
  }

  private resolveWorker(meta: SessionMetaData): WorkerState | undefined {
    const direct = this.workers.get(meta.workerIdentityKey);
    if (direct) return direct;
    if (meta.foremanTaskRunID) {
      for (const worker of this.workers.values()) {
        if (worker.meta.foremanTaskRunID === meta.foremanTaskRunID) return worker;
      }
    }
    if (meta.taskId) {
      for (const worker of this.workers.values()) {
        if (worker.meta.taskId === meta.taskId) return worker;
      }
    }
    return undefined;
  }

  ingestToolUse(signal: ToolUseSignal, workerIdentityKey: string): void {
    const worker = this.workers.get(workerIdentityKey);
    if (!worker) return;
    this.applyToolUse(worker, signal);
    this.emit();
  }

  ingestText(signal: TextSignal, workerIdentityKey: string): void {
    const worker = this.workers.get(workerIdentityKey);
    if (!worker) return;
    this.applyText(worker, signal);
    this.emit();
  }

  ingestToolResult(signal: ToolResultSignal, workerIdentityKey: string): void {
    const worker = this.workers.get(workerIdentityKey);
    if (!worker) return;
    this.applyToolResult(worker, signal);
    this.emit();
  }

  ingestTurnUsage(signal: TurnUsageSignal, workerIdentityKey: string): void {
    const worker = this.workers.get(workerIdentityKey);
    if (!worker) return;
    this.applyTurnUsage(worker, signal);
    this.emit();
  }

  setBroadcast(broadcast: BroadcastInput): void {
    this.broadcast = normalizeBroadcast(broadcast);
    this.emit();
  }

  clearBroadcast(id?: string): void {
    if (!this.broadcast) return;
    if (id !== undefined && this.broadcast.id !== id) return;
    const broadcastId = this.broadcast.id;
    this.broadcast = undefined;
    // Dismissing a notification card promotes the next queued card.
    const next = this.notifications.dismiss(id ?? broadcastId);
    if (next) this.broadcast = normalizeBroadcast(next);
    this.emit();
  }

  tick(): void {
    const t = this.now();
    const toRemove: string[] = [];

    for (const w of this.workers.values()) {
      const elapsed = t - w.phaseSinceMs;

      if (w.phase === 'celebrating' && elapsed >= this.celebrateMs) {
        toRemove.push(w.workerIdentityKey);
      } else if (w.phase === 'dejected' && elapsed >= this.dejectedMs) {
        toRemove.push(w.workerIdentityKey);
      }
    }

    for (const workerIdentityKey of toRemove) {
      this.workers.delete(workerIdentityKey);
    }

    // Transient notification cards expire and the next queued card is shown.
    if (this.broadcast && shouldExpireBroadcast(this.broadcast, t)) {
      const wasNotification = this.notifications.isCurrent(this.broadcast.id);
      this.broadcast = undefined;
      if (wasNotification) {
        const next = this.notifications.advanceAfterExpiry();
        if (next) this.broadcast = normalizeBroadcast(next);
      }
    }

    this.emit();
  }

  snapshot(): SiteSnapshot {
    const workers: WorkerSnapshot[] = [];
    for (const w of this.workers.values()) {
      workers.push({
        workerIdentityKey: w.workerIdentityKey,
        profile: w.profile,
        phase: w.phase,
        phaseSinceMs: w.phaseSinceMs,
        toolCount: w.toolCount,
        firstSentence: w.firstSentence,
        lastText: w.lastText,
        bubbleUntilMs: w.bubbleUntilMs,
        lastToolName: w.lastToolName,
        lastToolStatus: w.lastToolStatus,
        lastToolOutputTail: w.lastToolOutputTail,
        inputTokens: w.inputTokens,
        outputTokens: w.outputTokens,
        durationMs: w.durationMs,
        startedAt: w.startedAt,
        meta: w.meta,
      });
    }
    return {
      workers,
      queuedCount: this.queued.size,
      ...(this.activityStale ? { activityStale: true } : {}),
      ...(this.taskgraphCount > 0 ? { taskgraphCount: this.taskgraphCount } : {}),
      ...(this.broadcast ? { broadcast: { ...this.broadcast } } : {}),
    };
  }

  onChange(cb: (snap: SiteSnapshot) => void): void {
    this.callbacks.push(cb);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const cb of this.callbacks) {
      cb(snap);
    }
  }

  private workerForSignal(signal: InputSignal, meta: SessionMetaData, ts: number): WorkerState | undefined {
    let worker = this.workers.get(meta.workerIdentityKey);
    if (worker) return worker;

    if (signal.kind === 'done' || signal.kind === 'failed' || signal.kind === 'terminate' || signal.kind === 'queued') {
      return undefined;
    }

    worker = {
      workerIdentityKey: meta.workerIdentityKey,
      profile: meta.profile,
      phase: 'working',
      phaseSinceMs: ts,
      toolCount: 0,
      startedAt: ts,
      meta,
    };
    this.workers.set(meta.workerIdentityKey, worker);
    return worker;
  }

  private applySignal(worker: WorkerState, signal: ForgeEventSignal, ts: number): void {
    switch (signal.kind) {
      case 'spawn':
        worker.phase = 'working';
        worker.phaseSinceMs = ts;
        worker.startedAt = ts;
        return;
      case 'queued':
        return;
      case 'working':
        worker.phase = 'working';
        worker.phaseSinceMs = ts;
        return;
      case 'sleeping':
        worker.phase = 'sleeping';
        worker.phaseSinceMs = ts;
        return;
      case 'done':
        worker.phase = 'celebrating';
        worker.phaseSinceMs = Math.max(ts, this.now());
        if (signal.summary) worker.deliverySummary = signal.summary;
        this.applyFarewellText(worker, worker.phaseSinceMs);
        return;
      case 'failed':
        worker.phase = 'dejected';
        worker.phaseSinceMs = Math.max(ts, this.now());
        if (signal.summary) worker.deliverySummary = signal.summary;
        this.applyFarewellText(worker, worker.phaseSinceMs);
        return;
      case 'message':
        this.applyText(worker, signal);
        return;
      case 'tool_call':
        this.applyToolUse(worker, signal);
        return;
      case 'tool_result':
        this.applyToolResult(worker, signal);
        return;
      case 'turn_usage':
        this.applyTurnUsage(worker, signal);
        return;
    }
  }

  private applyToolUse(worker: WorkerState, signal: ToolUseSignal): void {
    worker.toolCount++;
    worker.lastToolName = signal.name;
  }

  private applyText(worker: WorkerState, signal: TextSignal): void {
    if (!worker.firstSentence) {
      worker.firstSentence = signal.text;
    }
    worker.lastText = signal.text;
    worker.bubbleUntilMs = undefined;
  }

  private applyToolResult(worker: WorkerState, signal: ToolResultSignal): void {
    worker.lastToolStatus = signal.status;
    if (signal.outputTail !== undefined) {
      worker.lastToolOutputTail = signal.outputTail;
    }
  }

  private applyTurnUsage(worker: WorkerState, signal: TurnUsageSignal): void {
    if (signal.inputTokens !== undefined) worker.inputTokens = signal.inputTokens;
    if (signal.outputTokens !== undefined) worker.outputTokens = signal.outputTokens;
    if (signal.durationMs !== undefined) worker.durationMs = signal.durationMs;
  }

  private applyFarewellText(worker: WorkerState, ts: number): void {
    if (worker.deliverySummary) {
      worker.lastText = worker.deliverySummary;
    }
    worker.bubbleUntilMs = ts + Math.max(this.celebrateMs, this.dejectedMs);
  }
}

function metaFromPresence(task: ActivityTaskPresence): SessionMetaData {
  const meta: SessionMetaData = {
    workerIdentityKey: task.taskRunId,
    foremanTaskRunID: task.taskRunId,
    profile: task.resolvedProfile ?? 'foreman',
    workDir: '',
    isWorktree: task.worktree ?? false,
    status: 'running',
  };
  if (task.taskId !== undefined) {
    meta.taskId = task.taskId;
    meta.taskName = task.taskId;
    if (task.taskLabel === undefined) meta.taskLabel = task.taskId;
  }
  if (task.taskLabel !== undefined) meta.taskLabel = task.taskLabel;
  if (task.project !== undefined) meta.project = task.project;
  return meta;
}
