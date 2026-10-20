/**
 * session engine: the session lifecycle and composition of the turn loop.
 *
 * The engine owns session creation, recovery, deletion, media and the
 * observability reads; every work turn runs in {@link TurnRunner}. `index.ts`
 * is the only composition root: it builds the ports and hands them to
 * {@link createEngine}. There is no compatibility mechanism and no legacy role.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectSessionFiles,
  stepId,
  turnId,
  type LedgerEvent,
  type LedgerPage,
  type SessionSummary,
  type TurnResumeMarker,
  type WorkspaceSnapshot,
} from '../ledger/store.ts';
import { ModelCallError, resolveModelMetadata, type CallRole } from '../model/request.ts';
import {
  PROVIDER_DEFAULT_REASONING,
  REASONING_EFFORTS,
  isMainstreamModelId,
  type ReasoningEffort,
} from '@wrenyard/models';
import { resolveHistoricalOfferedModelId, type ProviderDefinition } from '@wrenyard/providers';
import { ContextInspector, findCreated, type ContextInspectRequest, type ContextInspection } from '../context/inspect.ts';
import { type ToolCall } from '../transport/index.ts';
import { isInside, type AttachmentInput, type FileStore } from '../media.ts';
import { messageOf } from '../errors.ts';
import { ActionRunner } from '../reasoning/actions.ts';
import { LiveCalls } from './live.ts';
import type {
  BuiltView,
  EnginePorts,
  InvokedCall,
  LedgerPort,
  LiveCall,
  RecoveryWait,
  Session,
  SessionCallHost,
  SessionHost,
} from '../ports.ts';
import { ReplyWriter } from '../auxiliary/reply.ts';
import { suggestNextInput } from '../auxiliary/prompt-suggestion.ts';
import { regenerateTitle } from '../auxiliary/title.ts';
import { TurnRunner } from './turn.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';
import { buildSnapshot } from '../snapshot.ts';

// ─── Engine ────────────────────────────────────────────────────────────────

/**
 * How often the engine looks for session runtimes nothing can reference any
 * more, and how long such a runtime must stay quiet before it is released.
 */
const IDLE_RUNTIME_SWEEP_MS = 30_000;
const IDLE_RUNTIME_TIMEOUT_MS = 60_000;

export function createEngine(host: SessionHost, ports: EnginePorts): Session {
  return new Engine(host, ports);
}

/**
 * Every engine alive in this process. A bot context owns a private engine (its
 * own state root), so an interrupt addressed to the daemon session service must
 * be able to find and stop a turn owned by one of those engines.
 */
const liveEngines = new Set<Engine>();

class Engine implements Session, SessionCallHost {
  readonly host: SessionHost;
  readonly ports: EnginePorts;
  private readonly inspector: ContextInspector;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly live = new LiveCalls();
  private readonly replies: ReplyWriter;
  private readonly turnRunner: TurnRunner;
  private readonly ensuring = new Map<string, Promise<SessionRuntime>>();
  private readonly recoveringTurns = new Set<string>();
  /**
   * Per-session count of in-flight attachment imports/admissions. A plain Set
   * was wrong: two concurrent imports of the same session would let the first
   * `finally` drop the flag while the second was still copying bytes, so a
   * concurrent delete could remove the files directory out from under it.
   */
  private readonly pendingAdmissions = new Map<string, number>();
  /** Sessions deleted in this process; a stale send must not resurrect one. */
  private readonly deletedSessions = new Set<string>();
  private readonly pipeline = new Set<Promise<unknown>>();
  /**
   * The one in-flight next-input suggestion per session. A newer request
   * replaces (and aborts) the previous one, so a session never has two
   * suggestion calls riding the same completed turn at once.
   */
  private readonly suggestionRequests = new Map<string, { requestId: string; controller: AbortController }>();
  /**
   * Sessions whose active turn is currently waiting for recovery, mapped to that
   * turn's number plus its selected model, effort and attachment identity. The
   * wait is nonterminal and unbounded: it lasts until the route really recovers,
   * is cleared on the next actual attempt, on completion and on cancel, and
   * never fails the turn by itself. A repeated 'continue' of the same selected
   * model and effort while a turn is waiting must not create a second turn or
   * dispatch, so this is read synchronously before any async send work.
   * Independent concurrent turns, an explicit model or effort change and an
   * unrelated message stay unaffected.
   */
  private readonly recoveryWaits = new Map<string, RecoveryWait>();
  /**
   * The narrow pending-send latch: the identity and result of a `send` whose
   * admission is still in flight. Two rapid identical sends in the same tick —
   * before any recovery marker exists — share one turn instead of creating two.
   * It is set synchronously at the start of `send` and cleared once the send
   * settles (on failure, cancel or admission).
   */
  private readonly pendingSends = new Map<string, {
    model: string;
    effort: ReasoningEffort;
    fast: boolean | undefined;
    text: string;
    attachmentsKey: string;
    result: Promise<{ turn: number }>;
  }>();
  private ready: Promise<void>;
  private closed = false;
  private closePromise?: Promise<void>;
  /** Deferred startup recovery of the sessions the index flagged as active. */
  private startupRecoveryTimer?: ReturnType<typeof setTimeout>;
  /** Deferred body recovery of sessions whose index metadata is uncertain. */
  private backgroundRecoveryTimer?: ReturnType<typeof setTimeout>;
  /** Whether the deferred recovery passes were armed by the host. */
  private backgroundRecoveryStarted = false;
  /**
   * Whether the daemon opted this session service into restart recovery. Only
   * the graceful shutdown path calls {@link prepareForRestart}; an ordinary
   * interrupt and a default `close` never enable it. Bot context enables it
   * through the bot kernel's `prepareForRestart` during graceful shutdown.
   */
  private restartOptIn = false;
  /**
   * Sessions whose restart markers must not be resurrected from a legacy body
   * replay after a deliberate stop. Populated synchronously by a normal send or
   * a user interrupt in this process, before any await, and dropped on delete.
   */
  private readonly restartSuppressed = new Set<string>();
  /**
   * Restart continuations still pending, keyed by session and original turn id.
   * Loaded from the index and kept in memory only as the synchronous admission
   * fence: the ledger summary stays authoritative, and a token is removed from
   * the durable state by the same append that writes `turn.started`.
   */
  private readonly restartContinuations = new Map<string, Map<string, TurnResumeMarker>>();
  /** Deferred admission of the pending restart continuations. */
  private restartRecoveryTimer?: ReturnType<typeof setTimeout>;
  /** Whether a restart-continuation pass is running, so it stays single-flight. */
  private recoveringRestarts = false;
  /**
   * Sessions whose persisted summary carries no reliable pending-turn list — a
   * legacy entry, an unindexed file, or a placeholder — so only their body can
   * say whether a turn is unfinished. Their bodies are read by a deferred pass
   * after startup, never in the constructor.
   */
  private readonly uncertainSessions = new Set<string>();
  /** Whether a deferred body-recovery pass is reading a timeline right now. */
  private recoveringBodies = false;
  /** In-progress deferred recovery passes, awaited by close before the ledger closes. */
  private readonly recoveryPasses = new Set<Promise<void>>();
  /** When each idle runtime was first seen with no work left, for unloading. */
  private readonly idleSince = new Map<string, number>();
  private idleTimer?: ReturnType<typeof setInterval>;
  /**
   * The last observed result-flush promise of each turn. A flush chain replaces
   * `flushPromise` while it runs, so the only safe test is to watch the promise
   * we last saw: one we have not seen yet counts as still in flight.
   */
  private readonly flushStates = new WeakMap<TurnRuntime, { promise: Promise<unknown>; settled: boolean }>();

  constructor(host: SessionHost, ports: EnginePorts) {
    this.host = host;
    this.ports = ports;
    this.replies = new ReplyWriter(this, host.deviceName);
    this.inspector = new ContextInspector({
      workspaceRoot: host.workspaceRoot,
      deviceName: host.deviceName,
      ledger: ports.ledger,
      resolveInferenceProvider: (id) => host.resolveInferenceProvider(id),
      now: () => this.now(),
      createSnapshot: () => buildSnapshot(this.host),
    });
    // Startup is metadata-only: the index records which turns never finished,
    // so no timeline body is parsed to decide whether anything is active.
    for (const summary of ports.ledger.listSessions()) {
      // A pending restart continuation is independent of the pending-turn list:
      // its original turn is already terminal, so only this marker asks for a
      // follow-up after the restart.
      if (summary.pendingRestarts !== undefined && summary.pendingRestarts.length > 0) {
        this.restartContinuations.set(
          summary.sessionId,
          new Map(summary.pendingRestarts.map((marker) => [marker.turnId, marker])),
        );
      }
      if (summary.pendingTurns === undefined) {
        // A legacy, unindexed or rebuilt summary cannot say which turns are
        // unfinished. Its body decides, on a deferred pass after startup.
        this.uncertainSessions.add(summary.sessionId);
        continue;
      }
      for (const turn of summary.pendingTurns) {
        this.recoveringTurns.add(`${summary.sessionId}:${turn}`);
      }
    }
    this.turnRunner = new TurnRunner(this, this.replies);
    this.ready = this.initialize();
    void this.ready.catch(() => undefined);
    // An unref'd sweep releases runtimes whose session has been idle long
    // enough that nothing can still be working on it.
    this.idleTimer = setInterval(() => this.sweepIdleSessions(), IDLE_RUNTIME_SWEEP_MS);
    this.idleTimer.unref();
    liveEngines.add(this);
  }

  get ledger(): LedgerPort {
    return this.ports.ledger;
  }

  /**
   * Recover only the sessions the index flagged as having unfinished turns.
   * Completed timelines are never parsed here, and the recovery runs on a later
   * tick so a healthy startup is not held behind a large replay. A session that
   * is touched first is recovered by `ensureSession` and skipped by this pass.
   */
  private async initialize(): Promise<void> {
    await this.ports.ledger.init();
  }

  /**
   * Arm the deferred recovery passes. Both run on a later tick so a healthy
   * startup is never held behind a replay; the host calls this once it is
   * listening, so no session body is parsed before the daemon is healthy.
   * Idempotent: a repeated call or a call after close is a no-op.
   */
  startBackgroundRecovery(): void {
    if (this.closed || this.backgroundRecoveryStarted) return;
    this.backgroundRecoveryStarted = true;
    if (this.recoveringTurns.size > 0) {
      this.startupRecoveryTimer = setTimeout(() => {
        this.startupRecoveryTimer = undefined;
        void this.trackRecoveryPass(this.recoverFlaggedSessions());
      }, 0);
      this.startupRecoveryTimer.unref();
    }
    if (this.uncertainSessions.size > 0) {
      this.backgroundRecoveryTimer = setTimeout(() => {
        this.backgroundRecoveryTimer = undefined;
        void this.trackRecoveryPass(this.recoverUncertainSessions());
      }, 0);
      this.backgroundRecoveryTimer.unref();
    }
    this.scheduleRestartRecovery();
  }

  /**
   * Arm one deferred pass that admits the pending restart continuations. Runs
   * only after the host is listening, is idempotent, and is re-armed when a
   * body replay reveals markers a legacy index did not carry.
   */
  private scheduleRestartRecovery(): void {
    if (this.closed || !this.backgroundRecoveryStarted) return;
    if (this.restartRecoveryTimer !== undefined || this.recoveringRestarts) return;
    if (this.restartContinuations.size === 0) return;
    this.restartRecoveryTimer = setTimeout(() => {
      this.restartRecoveryTimer = undefined;
      void this.trackRecoveryPass(this.recoverRestartContinuations());
    }, 0);
    this.restartRecoveryTimer.unref();
  }

  /**
   * Keep a deferred recovery pass reachable so `close` can wait for it to
   * observe `closed` and finish before the ledger is closed. The passes
   * early-return on `closed`, so awaiting them cannot deadlock.
   */
  private async trackRecoveryPass(pass: Promise<void>): Promise<void> {
    this.recoveryPasses.add(pass);
    try {
      await pass;
    } finally {
      this.recoveryPasses.delete(pass);
    }
  }

  private async recoverFlaggedSessions(): Promise<void> {
    const sessionIds = new Set<string>();
    for (const key of this.recoveringTurns) {
      const separator = key.lastIndexOf(':');
      if (separator > 0) sessionIds.add(key.slice(0, separator));
    }
    for (const sessionId of sessionIds) {
      // Every path drops this session's markers: a marker left behind by a
      // skip or a failure would keep the session permanently "recovering",
      // block its deletion and block its runtime from ever being unloaded.
      if (this.closed) {
        this.clearRecoveringTurns(sessionId);
        return;
      }
      // A session a concurrent `send` already resolved, or one deleted while
      // this pass was waiting, owns its own recovery.
      if (this.sessions.has(sessionId) || this.deletedSessions.has(sessionId)) {
        this.clearRecoveringTurns(sessionId);
        continue;
      }
      try {
        // Single-flight with a concurrent `send`; its own recovery wins.
        await this.ensureSession(sessionId);
      } catch {
        // Nothing runs for a turn whose recovery failed, so it is not active work.
      } finally {
        this.clearRecoveringTurns(sessionId);
      }
    }
  }

  /**
   * Read the bodies of sessions whose index metadata cannot say whether a turn
   * is unfinished: a legacy summary, an unindexed file or a placeholder. The
   * pass runs after startup readiness and yields between sessions, so a large
   * history is migrated in the background instead of blocking `ready`. It still
   * performs the normal recovery, so an orphaned turn is closed and its task
   * runs cancelled exactly as a flagged session's would be.
   */
  private async recoverUncertainSessions(): Promise<void> {
    this.recoveringBodies = true;
    try {
      for (const sessionId of [...this.uncertainSessions]) {
        if (this.closed) return;
        if (this.sessions.has(sessionId) || this.deletedSessions.has(sessionId)) {
          // A concurrent `send` or a deletion owns this session's recovery, so
          // its body is already resolved and the marker can go.
          this.uncertainSessions.delete(sessionId);
          continue;
        }
        try {
          // The marker is kept until the replay has been awaited: until then
          // this session's active state is unknown, so it must still count as
          // busy rather than let an interrupted turn look idle.
          await this.ensureSession(sessionId);
        } catch {
          // An unreadable timeline is retried on first touch, not at startup.
        } finally {
          // Released on the failure path as well, so an unreadable timeline
          // cannot keep the session counted as active forever.
          this.uncertainSessions.delete(sessionId);
        }
        // A legacy index carries no restart markers, so the replayed body is
        // what decides whether a continuation is still owed.
        if (this.syncRestartContinuations(sessionId)) this.scheduleRestartRecovery();
        // A fully replayed session with nothing left to recover is released at
        // once: keeping every rebuilt runtime resident for the whole pass
        // would hold ~250 sessions in memory until the idle sweep arrives.
        this.releaseQuiescentRuntime(sessionId);
        // Yield between sessions so one body parse never monopolizes the loop.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    } finally {
      this.recoveringBodies = false;
    }
  }

  /**
   * Admit one linked follow-up turn for every still-pending restart marker.
   * The pass consumes the in-memory map, so it is single-flight and repeated
   * concurrent passes cannot admit a duplicate: a marker is deleted once its
   * continuation is durably started, dropped when it can no longer be admitted,
   * and cleared synchronously by any normal send or user interrupt. Sessions
   * already resident reuse their runtime; a session whose body a legacy index
   * left uncertain is replayed by the body pass and its markers re-synced.
   */
  private async recoverRestartContinuations(): Promise<void> {
    if (this.recoveringRestarts) return;
    this.recoveringRestarts = true;
    try {
      while (!this.closed && this.restartContinuations.size > 0) {
        const sessionId = this.restartContinuations.keys().next().value;
        if (sessionId === undefined) break;
        await this.resumeSessionRestarts(sessionId);
        // Yield between sessions so one admission never monopolizes the loop.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    } finally {
      this.recoveringRestarts = false;
      // A body pass may have discovered a marker while this pass was running and
      // found it already claimed. Re-arm instead of dropping that continuation.
      this.scheduleRestartRecovery();
    }
  }

  /**
   * Resolve one session and admit its pending continuations in turn order. The
   * original route is reused exactly and still passes through `send`, so the
   * historical model-id mapping and every admission check apply unchanged.
   * Action sequence numbers come from the replayed ledger; no action is replayed.
   */
  private async resumeSessionRestarts(sessionId: string): Promise<void> {
    if (this.deletedSessions.has(sessionId)) {
      this.restartContinuations.delete(sessionId);
      return;
    }
    try {
      // Reuse a resident runtime and never touch it recursively: this pass is
      // outside `ensureSession`, so the replay can complete before admission.
      await this.ensureSession(sessionId);
    } catch {
      // A session that cannot be replayed keeps no continuation; the ledger
      // still holds the interrupted turn.
      this.restartContinuations.delete(sessionId);
      return;
    }
    const pending = this.restartContinuations.get(sessionId);
    if (pending === undefined) return;
    const markers = [...pending.values()]
      .sort((left, right) => markerTurn(left) - markerTurn(right));
    for (const marker of markers) {
      if (this.closed) return;
      // A normal send or a user interrupt may have cleared it while this pass
      // was replaying; the check runs immediately before the durable turn.
      if (!this.isRestartPending(sessionId, marker.turnId)) continue;
      try {
        await this.send(sessionId, {
          text: restartContinuationText(marker),
          model: {
            provider: marker.provider,
            model: marker.model,
            reasoningEffort: marker.reasoningEffort,
            ...(marker.fast === undefined ? {} : { fast: marker.fast }),
          },
        }, marker.turnId);
      } catch {
        // A continuation that cannot be admitted is dropped rather than
        // retried: the original work stays in the ledger and its context.
        this.restartContinuations.get(sessionId)?.delete(marker.turnId);
      }
    }
    // Every marker this pass saw is settled: consumed with its durable start or
    // dropped above. Forget the key so the loop cannot spin on a marker whose
    // send returned without admitting a new turn; its durable token, if any,
    // stays in the ledger and is retried on the next start.
    this.restartContinuations.delete(sessionId);
    this.releaseQuiescentRuntime(sessionId);
  }

  /** Replace one session's in-memory markers with its durable summary. */
  private syncRestartContinuations(sessionId: string): boolean {
    // A session stopped deliberately in this process must not regain a marker
    // from a legacy body replay: the normal send or user interrupt already won.
    if (this.restartSuppressed.has(sessionId)) {
      this.restartContinuations.delete(sessionId);
      return false;
    }
    const summary = this.ports.ledger.listSessions().find((entry) => entry.sessionId === sessionId);
    const restarts = summary?.pendingRestarts ?? [];
    if (restarts.length === 0) {
      this.restartContinuations.delete(sessionId);
      return false;
    }
    this.restartContinuations.set(
      sessionId,
      new Map(restarts.map((marker) => [marker.turnId, marker])),
    );
    return true;
  }

  /** Whether one session still owes a continuation for this original turn. */
  private isRestartPending(sessionId: string, originalTurnId: string): boolean {
    return this.restartContinuations.get(sessionId)?.has(originalTurnId) === true;
  }

  /** Whether one session has any pending restart continuation. */
  private hasRestartContinuation(sessionId: string): boolean {
    return (this.restartContinuations.get(sessionId)?.size ?? 0) > 0;
  }

  /** Forget one session's pending continuations synchronously. */
  private clearRestartContinuation(sessionId: string): void {
    this.restartContinuations.delete(sessionId);
  }

  /**
   * Opt this session service into restart recovery. Called only by the daemon's
   * shutdown-for-upgrade path, before teardown; `close` alone never opts in, so
   * an ordinary shutdown keeps its previous behaviour.
   */
  prepareForRestart(): void {
    if (this.closed) return;
    this.restartOptIn = true;
  }

  /**
   * Drop one session's runtime when nothing in or around it can still make
   * progress. Used by the background recovery pass, so it shares every
   * quiescence gate of `isSessionQuiescent` except the `recoveringBodies`
   * flag itself, which the pass holds for its whole duration. The ledger
   * keeps the durable truth, so a later access replays it again.
   */
  private releaseQuiescentRuntime(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (!this.isSessionQuiescent(sessionId, session, { ignoreRecoveringBodies: true })) return;
    this.sessions.delete(sessionId);
    this.idleSince.delete(sessionId);
  }

  /** Forget every pending-turn marker of one session. */
  private clearRecoveringTurns(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of [...this.recoveringTurns]) {
      if (key.startsWith(prefix)) this.recoveringTurns.delete(key);
    }
  }

  async createSession(): Promise<{ sessionId: string }> {
    this.assertOpen();
    await this.ready;
    const snapshot = await buildSnapshot(this.host);

    const sessionId = randomUUID();
    this.assertOpen();
    this.registerSession(sessionId, this.host.workspaceRoot, snapshot);
    await this.ports.ledger.append(sessionId, {
      type: 'session.created',
      workspaceRoot: this.host.workspaceRoot,
      snapshot,
    });
    return { sessionId };
  }

  listSessions(): SessionSummary[] {
    return this.ports.ledger.listSessions().map((summary) => ({
      ...summary,
      running: this.sessionHasRunningTurns(summary.sessionId),
    }));
  }

  /**
   * Whether a session has an in-flight turn right now. A loaded runtime is
   * checked turn by turn; a session still being recovered at startup is running
   * while any of its recovering turns remain. Never touches the ledger, so it
   * stays a pure read of in-memory state.
   */
  private sessionHasRunningTurns(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      for (const turn of runtime.turns.values()) {
        if (!turn.durableTerminal) return true;
      }
    }
    const prefix = `${sessionId}:`;
    for (const key of this.recoveringTurns) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async steer(
    sessionId: string,
    input: { text: string; sender?: { botId: string } },
  ): Promise<{ turn: number } | undefined> {
    const session = await this.ensureSession(sessionId);
    const running = [...session.turns.entries()].find(([, turn]) => !turn.durableTerminal);
    if (running === undefined) return undefined;
    const [turnNumber, turn] = running;
    if (turn.durableTerminal) return undefined;
    await this.ports.ledger.append(sessionId, {
      type: 'turn.steered',
      turn: turnNumber,
      id: turnId(turnNumber),
      text: input.text,
      ...(input.sender === undefined ? {} : { sender: input.sender }),
    });
    return { turn: turnNumber };
  }

  async send(
    sessionId: string,
    input: {
      text: string;
      /** Explicit public reasoning level; required for every turn. */
      model: {
        provider: string;
        model: string;
        reasoningEffort: ReasoningEffort;
        /** Explicit Fast preference: true on, false off, absent no preference. */
        fast?: boolean;
      };
      attachments?: AttachmentInput[];
      /** Optional provenance of a bot-originated send; absent on ordinary sends. */
      sender?: { botId: string };
    },
    /** Original turn id when this send is the restart continuation for it. */
    resumedFrom?: string,
  ): Promise<{ turn: number }> {
    this.assertOpen();
    // Historical identity migration, before admission, deduplication and the
    // ledger write: a restored or saved selection may still name a legacy model
    // spelling. Only a verified unique provider-scoped mapping is accepted, so
    // an unknown or ambiguous selection fails here instead of being guessed.
    // The provider, effort and Fast preference are preserved exactly and the
    // registered id is what the new turn persists; historical ledger events are
    // never rewritten.
    const providerDefinition = this.host.resolveInferenceProvider(input.model.provider);
    const registeredModel = providerDefinition === undefined
      ? undefined
      : resolveHistoricalOfferedModelId(providerDefinition, input.model.model);
    if (registeredModel === undefined) {
      throw new Error(
        `Model ${input.model.provider}/${input.model.model} is unavailable for sessions: it is not a uniquely registered offering of provider '${input.model.provider}'`,
      );
    }
    const admitted = registeredModel === input.model.model
      ? input
      : { ...input, model: { ...input.model, model: registeredModel } };
    // Bot provenance: an explicit sender, or a host that binds this session to a
    // bot tool port. The model of such a turn came from automatic routing and
    // may be replaced within the turn when its route becomes unusable.
    const automatic = admitted.sender !== undefined || this.host.agentTools?.(sessionId) !== undefined;
    const modelInput = automatic
      ? { ...admitted, model: { ...admitted.model, automatic: true } }
      : admitted;
    const model = `${modelInput.model.provider}/${modelInput.model.model}`;
    const effort = modelInput.model.reasoningEffort;
    const fast = modelInput.model.fast;
    const attachmentsKey = attachmentKey(modelInput.attachments);

    // A turn already waiting for recovery owns the exchange: a repeated continue
    // of the same selected model, effort and Fast preference — or a double
    // click — must not create a second turn or dispatch. Decided synchronously,
    // before any await, so two continuations in the same tick cannot both admit
    // a turn. A continue after a prior terminal failure still creates exactly
    // one waiting turn; an explicit model, effort or Fast change, an unrelated
    // message or a different attachment set is always admitted.
    const waiting = this.recoveryWaits.get(sessionId);
    if (waiting !== undefined
      && waiting.model === model
      && waiting.effort === effort
      && this.isWaitingResubmission(sessionId, waiting, modelInput.text, attachmentsKey, fast)) {
      return { turn: waiting.turn };
    }

    // Two rapid identical sends before any recovery marker exists share one
    // turn: the narrow latch is set before any async send work. The fingerprint
    // includes the effort, the Fast preference and the stable attachment
    // identity, so a changed level, mode or attachment is never swallowed.
    const pending = this.pendingSends.get(sessionId);
    if (pending !== undefined
      && pending.model === model
      && pending.effort === effort
      && pending.fast === fast
      && pending.text === modelInput.text
      && pending.attachmentsKey === attachmentsKey) {
      return pending.result;
    }

    // A normal user or bot turn supersedes any pending restart continuation and
    // a valid continuation of its own does not. Cleared synchronously, before
    // any await, so a recovery pass still resolving the session cannot admit
    // the continuation afterwards, and recorded so a legacy body replay cannot
    // resurrect the marker either.
    if (resumedFrom === undefined) {
      this.restartSuppressed.add(sessionId);
      this.clearRestartContinuation(sessionId);
    }

    const result = this.admitTurn(sessionId, modelInput, model, resumedFrom);
    this.pendingSends.set(sessionId, { model, effort, fast, text: modelInput.text, attachmentsKey, result });
    try {
      return await result;
    } finally {
      if (this.pendingSends.get(sessionId)?.result === result) this.pendingSends.delete(sessionId);
    }
  }

  /**
   * Whether a new send is the same continuation of a turn already waiting for
   * recovery: the exact original text with an identical attachment set
   * and Fast preference, or a plain attachment-free manual continue (`继续` /
   * `continue`) on the same selected model. Anything else — different text, a
   * different attachment set, a changed Fast preference — is a genuinely new
   * message and must not be swallowed.
   */
  private isWaitingResubmission(
    sessionId: string,
    waiting: RecoveryWait,
    text: string,
    attachmentsKey: string,
    fast: boolean | undefined,
  ): boolean {
    const ongoing = this.sessions.get(sessionId)?.turns.get(waiting.turn);
    if (ongoing === undefined) return false;
    if (ongoing.model.fast !== fast) return false;
    if (text === ongoing.userText && attachmentsKey === waiting.attachmentsKey) return true;
    return attachmentsKey === '' && isPlainContinue(text);
  }

  /**
   * Admit one turn: resolve the session, import attachments, assign the turn
   * number and start the runner. Split out of {@link send} so the synchronous
   * send guard and latch always run before this async work.
   */
  private async admitTurn(
    sessionId: string,
    input: {
      text: string;
      model: {
        provider: string;
        model: string;
        reasoningEffort: ReasoningEffort;
        fast?: boolean;
      };
      attachments?: AttachmentInput[];
      /** Optional provenance of a bot-originated send; absent on ordinary sends. */
      sender?: { botId: string };
    },
    publicId: string,
    /** Original turn id when this admission is its restart continuation. */
    resumedFrom?: string,
  ): Promise<{ turn: number }> {
    // Universal application admission, evaluated before the session is even
    // resolved: every admitted turn — a new session, a resume or a restored
    // selection — runs on a mainstream registered model identity. There is no
    // provider exception and no unknown-intelligence fallback, so an unresolved
    // or non-mainstream selection is refused before any session begin/resume.
    if (!isMainstreamModelId(input.model.model)) {
      throw new Error(`Model ${publicId} is not available for sessions; choose a mainstream registered model`);
    }
    // Resolve (recovering if needed) the session before any import, copy or append.
    const session = await this.ensureSession(sessionId);
    this.assertOpen();
    const metadata = resolveModelMetadata(publicId, (id) => this.host.resolveInferenceProvider(id));
    const effort = input.model.reasoningEffort;
    if (effort === undefined || !REASONING_EFFORTS.includes(effort)) {
      throw new Error(`reasoningEffort '${effort ?? ''}' is not a valid reasoning effort`);
    }
    // A provider-default-only ladder accepts any valid request: the request
    // layer adapts every effort to the route's provider default.
    const providerDefaultOnly = metadata.reasoningEfforts?.length === 1
      && metadata.reasoningEfforts[0] === PROVIDER_DEFAULT_REASONING;
    if (metadata.reasoningEfforts !== undefined && !metadata.reasoningEfforts.includes(effort) && !providerDefaultOnly) {
      throw new Error(
        `reasoningEffort '${effort}' is not supported by ${publicId}; expected one of ${metadata.reasoningEfforts.join(', ')}`,
      );
    }
    // Fast is admitted only for a route that declares a verified Fast mode; the
    // request must fail before the turn starts rather than silently ignoring it.
    if (input.model.fast === true && !declaresFast(this.host.resolveInferenceProvider(input.model.provider), input.model.model)) {
      throw new Error(`Fast is not supported by ${publicId}`);
    }

    // A deletion that completed while this send was waiting on the session lock
    // must not be undone by admitting a turn after the fact.
    this.assertNotDeleted(sessionId);

    // Hold an admission for the whole import so a concurrent delete cannot
    // remove the session (and its files directory) out from under this send.
    this.beginAdmission(sessionId);
    let files: Awaited<ReturnType<FileStore['importAttachments']>>;
    try {
      files = input.attachments === undefined || input.attachments.length === 0
        ? []
        : await this.ports.fileStore.importAttachments(sessionId, input.attachments);
    } finally {
      this.endAdmission(sessionId);
    }
    this.assertNotDeleted(sessionId);

    // Restart continuation fence: every await above may have let a normal send,
    // a bot turn or a user interrupt clear the token. This check is synchronous
    // and runs immediately before the durable turn is created, so that send
    // wins and no duplicate follow-up is admitted. The token's route must still
    // match the provider, effort and Fast preference; the model id is not
    // compared because admission already migrated a historical spelling and
    // `send` validates the registered identity.
    if (resumedFrom !== undefined) {
      const token = this.restartContinuations.get(sessionId)?.get(resumedFrom);
      if (token === undefined
        || token.provider !== input.model.provider
        || token.reasoningEffort !== input.model.reasoningEffort
        || token.fast !== input.model.fast) {
        throw new Error(`Restart continuation ${resumedFrom} is no longer pending for session ${sessionId}`);
      }
    }

    // Turn numbers are assigned synchronously here, so concurrent sends take
    // their numbers in invocation order rather than in resolution order.
    const turnNumber = session.nextTurn;
    session.nextTurn += 1;
    const turn = this.createTurn(
      turnNumber,
      input.text,
      attachmentKey(input.attachments),
      input.model,
      publicId,
      metadata.contextWindow,
    );
    session.turns.set(turnNumber, turn);
    // A new user turn ends the exchange a suggestion described; abort any
    // pending suggestion, including one started by another client.
    this.abortSuggestion(sessionId);
    if (session.firstUserText === undefined) session.firstUserText = input.text;

    // Durable start: the user event is on disk before `send` returns.
    try {
      await this.ports.ledger.append(sessionId, {
        type: 'turn.started',
        turn: turnNumber,
        id: turnId(turnNumber),
        text: input.text,
        model: input.model,
        ...(resumedFrom === undefined ? {} : { resumedFrom }),
        ...(input.sender === undefined ? {} : { sender: input.sender }),
      });
    } catch (error) {
      // A turn whose start never reached the timeline was never admitted:
      // forget it so it is not counted active and cannot be interrupted.
      session.turns.delete(turnNumber);
      throw error;
    }
    // Consumed only now, as part of the same durable append: the ledger already
    // dropped this marker from the derived summary, and the in-memory fence
    // mirrors it for anything still waiting.
    if (resumedFrom !== undefined) {
      const pending = this.restartContinuations.get(sessionId);
      pending?.delete(resumedFrom);
      if (pending !== undefined && pending.size === 0) this.restartContinuations.delete(sessionId);
    }

    // A model the user switched to is a fact the reasoning model should read.
    const previousModel = lastTurnModel(this.ports.ledger.read(sessionId), turnNumber);
    const currentModel = `${input.model.provider}/${input.model.model}`;
    if (previousModel !== undefined && previousModel !== currentModel) {
      await this.ports.ledger.append(sessionId, {
        type: 'system.info',
        turn: turnNumber,
        parent: turnId(turnNumber),
        source: 'user',
        code: 'model.changed',
        message: `The user switched the main model from ${previousModel} to ${currentModel}.`,
      });
    }

    // The imported files enter the context immediately before the turn runs.
    if (files.length > 0) {
      await this.ports.ledger.append(sessionId, {
        type: 'files.attached',
        turn: turnNumber,
        parent: turnId(turnNumber),
        source: 'user',
        files,
      });
    }

    this.track(this.turnRunner.runTurn(session, turn));
    return { turn: turnNumber };
  }

  /**
   * Record that a session's active turn is waiting for recovery. The turn/call
   * path calls this whenever the wait is reported — at its start and whenever
   * its real expected retry time changes — and clears it on the next actual
   * attempt, on completion and on cancel. The wait has no cumulative budget: it
   * is nonterminal and lasts as long as the route really needs. The value only
   * gates duplicate continuations of the same selected model and effort in
   * {@link send}, so the original logical call continues exactly once.
   */
  setRecoveryWait(sessionId: string, waiting: RecoveryWait): void {
    this.recoveryWaits.set(sessionId, waiting);
  }

  /**
   * Clear a session's recovery marker, but only for the turn that set it: the
   * completion or cancel of a different turn must never clear an active wait.
   */
  clearRecoveryWait(sessionId: string, turn: number): void {
    if (this.recoveryWaits.get(sessionId)?.turn === turn) this.recoveryWaits.delete(sessionId);
  }

  async interrupt(sessionId: string, turn: number): Promise<void> {
    this.assertOpen();
    // A session may belong to another engine in this process — a bot dispatcher
    // or a bot-opened context runs on its own ledger root. Forward the
    // interrupt to its owner so a stuck bot turn is stoppable too. An id this
    // process does not own at all still takes the local path and reports the
    // same unknown-session failure as before.
    const owner = this.interruptOwner(sessionId);
    if (owner !== this) {
      await owner.interrupt(sessionId, turn);
      return;
    }
    // The user-interrupt clear itself runs synchronously inside `interruptTurn`
    // before its first await, so it cancels a pending continuation before any
    // recovery pass can admit it.
    const operation = this.interruptTurn(sessionId, turn, 'user');
    this.track(operation);
    await operation;
  }

  /** The live engine whose ledger owns a session; this one when it cannot tell. */
  private interruptOwner(sessionId: string): Engine {
    if (this.ownsSession(sessionId)) return this;
    for (const engine of liveEngines) {
      if (engine === this || engine.closed) continue;
      if (engine.ownsSession(sessionId)) return engine;
    }
    return this;
  }

  /** True when this engine's ledger is the authority for the session id. */
  private ownsSession(sessionId: string): boolean {
    // A session deleted in this process must never be resurrected in another
    // engine that happens to have a stale ledger entry.
    if (this.deletedSessions.has(sessionId)) return true;
    if (this.sessions.has(sessionId)) return true;
    return this.ports.ledger.listSessions().some((entry) => entry.sessionId === sessionId);
  }

  async readMedia(sessionId: string, path: string): Promise<{ path: string; mime: string; dataUrl?: string }> {
    this.assertOpen();
    await this.ready;
    const events = this.ports.ledger.read(sessionId);
    if (findCreated(events) === undefined) throw new Error(`Unknown session: ${sessionId}`);
    // Exact canonical path only; the ledger's own file rows are authoritative.
    const file = collectSessionFiles(events).find((candidate) => candidate.path === path);
    if (!file) throw new Error(`Unknown session file: ${path}`);
    if (!this.isOwnedSessionFile(sessionId, file.path, events)) {
      throw new Error(`Path is outside this session's files: ${path}`);
    }
    if (file.kind !== 'image') return { path: file.path, mime: file.mime };
    const image = await this.ports.fileStore.readImage(file);
    return { path: file.path, mime: file.mime, dataUrl: image.dataUrl };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertOpen();
    await this.ready;
    const prefix = `${sessionId}:`;
    if ([...this.recoveringTurns].some((key) => key.startsWith(prefix))) {
      throw new Error(`Cannot delete a session with a recovering turn: ${sessionId}`);
    }
    if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) {
      throw new Error(`Cannot delete a session while an attachment import is pending: ${sessionId}`);
    }
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      for (const turn of runtime.turns.values()) {
        // A durable terminal alone is not enough: a turn can still be parsing
        // blocks, running actions, or holding late results to flush.
        const lateWork = turn.parsePromises.size > 0
          || turn.actionPromises.size > 0
          || turn.resultQueue.length > 0;
        if (!turn.durableTerminal || lateWork) {
          throw new Error(`Cannot delete a session with a running turn: ${sessionId}`);
        }
      }
    }
    const events = this.ports.ledger.read(sessionId);
    if (events.length === 0 && !runtime) throw new Error(`Unknown session: ${sessionId}`);

    // Mark synchronously, before any await, so a send that already passed its
    // admission check cannot append a turn after the timeline is removed.
    this.deletedSessions.add(sessionId);
    // A suggestion describes a session that no longer exists: stop it now.
    this.abortSuggestion(sessionId);

    const taskRunIds = new Set<string>();
    for (const event of events) {
      if (event.type === 'action.started' && event.taskRunId !== undefined) taskRunIds.add(event.taskRunId);
    }
    for (const turn of runtime?.turns.values() ?? []) {
      for (const taskRunId of turn.taskRunIds) taskRunIds.add(taskRunId);
    }

    try {
      // Remove only the bounded session files directory and each recorded run's
      // bounded artifact directory. Never a checkout or an arbitrary path.
      assertStorageSegment(sessionId);
      await rm(join(this.host.stateRoot, 'sessions', sessionId), { recursive: true, force: true });
      for (const taskRunId of taskRunIds) {
        assertStorageSegment(taskRunId);
        await rm(join(this.host.stateRoot, 'artifacts', taskRunId), { recursive: true, force: true });
      }
      await this.ports.ledger.deleteSession(sessionId);
    } catch (error) {
      // The session survived a failed deletion; allow it to be used again.
      this.deletedSessions.delete(sessionId);
      throw error;
    }
    this.sessions.delete(sessionId);
    this.ensuring.delete(sessionId);
    // The timeline is gone, so nothing is left to recover: drop the uncertain
    // marker that would otherwise keep this session counted as active.
    this.uncertainSessions.delete(sessionId);
    this.restartContinuations.delete(sessionId);
    this.restartSuppressed.delete(sessionId);
    this.recoveryWaits.delete(sessionId);
    this.pendingSends.delete(sessionId);
    this.live.drop(sessionId);
  }

  /**
   * Rename one session with an explicit user title. Appends one manual
   * `session.titled` event through the normal ledger append path, so
   * `index.json`, `listSessions` and every subscriber see the new title. An
   * empty or whitespace-only title and an unknown session are rejected before
   * anything is persisted.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed === '') throw new Error('Session title must not be empty');
    this.assertOpen();
    await this.ready;
    // Resolving the session rejects an unknown id before any append.
    await this.ensureSession(sessionId);
    await this.ports.ledger.append(sessionId, {
      type: 'session.titled',
      text: trimmed,
      manual: true,
    });
  }

  /**
   * Generate a new title on the user's request and record it as a manual
   * title. Rejects an unknown session, a session without messages and a failed
   * or empty generation, with the reason.
   */
  async regenerateTitle(sessionId: string): Promise<string> {
    this.assertOpen();
    await this.ready;
    const session = await this.ensureSession(sessionId);
    let latest: TurnRuntime | undefined;
    for (const turn of session.turns.values()) {
      if (latest === undefined || turn.turn > latest.turn) latest = turn;
    }
    if (latest === undefined) throw new Error('Session has no messages to title');
    return regenerateTitle(this, session, latest);
  }

  /**
   * Update one session's list metadata (archived / pinned). Appends one
   * `session.metadata` event carrying only the provided fields through the
   * normal ledger append path, so `index.json`, `listSessions` and every
   * subscriber see the change. A patch that provides neither field and an
   * unknown session are rejected before anything is persisted.
   */
  async updateMetadata(sessionId: string, patch: { archived?: boolean; pinned?: boolean }): Promise<void> {
    if (patch.archived === undefined && patch.pinned === undefined) {
      throw new Error('Session metadata patch must set archived or pinned');
    }
    this.assertOpen();
    await this.ready;
    // Resolving the session rejects an unknown id before any append.
    await this.ensureSession(sessionId);
    await this.ports.ledger.append(sessionId, {
      type: 'session.metadata',
      ...(patch.archived === undefined ? {} : { archived: patch.archived }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
    });
  }

  async recordWriteTargetsFree(sessionId: string, message: string): Promise<void> {
    this.assertOpen();
    await this.ready;
    const session = await this.ensureSession(sessionId);
    let latestTurn = 0;
    for (const turn of session.turns.values()) latestTurn = Math.max(latestTurn, turn.turn);
    for (const event of this.ports.ledger.read(sessionId)) latestTurn = Math.max(latestTurn, event.turn ?? 0);
    await this.ports.ledger.append(sessionId, {
      type: 'system.info',
      turn: latestTurn,
      ...(latestTurn > 0 ? { parent: turnId(latestTurn) } : {}),
      source: 'system',
      code: 'task.write-targets-free',
      message,
    });
  }

  private async interruptTurn(
    sessionId: string,
    turn: number,
    reason: 'user' | 'shutdown',
  ): Promise<void> {
    // A user interrupt is a deliberate stop: it never resumes and it clears any
    // pending restart continuation, including when the original turn already
    // reached its terminal event and the early return below applies. Both the
    // check and the clear run synchronously, before the first await.
    const cancelledRestart = reason === 'user' && this.hasRestartContinuation(sessionId);
    if (reason === 'user') {
      this.restartSuppressed.add(sessionId);
      this.clearRestartContinuation(sessionId);
    }
    const session = await this.ensureSession(sessionId);
    // A legacy index carried no in-memory marker, so the durable summary is the
    // only place a terminal original turn's pending continuation can be seen.
    // This is read after `ensureSession` because a body replay may have just
    // revealed it.
    const durableRestart = reason === 'user'
      && !cancelledRestart
      && turn >= 1
      && (this.ports.ledger.listSessions()
        .find((entry) => entry.sessionId === sessionId)
        ?.pendingRestarts?.some((marker) => marker.turnId === turnId(turn)) ?? false);
    const runtime = session.turns.get(turn);
    if (!runtime || runtime.finished) {
      // The original turn is already terminal, so no running work is cancelled;
      // the user's stop still has to durably cancel the continuation the
      // shutdown left pending, or the next start would resume it anyway.
      if ((cancelledRestart || durableRestart) && turn >= 1) {
        await this.ports.ledger.append(sessionId, {
          type: 'turn.interrupted',
          turn,
          parent: turnId(turn),
          reason: 'user',
        });
      }
      return;
    }

    // Flip the terminal flag synchronously so an in-flight continuation cannot
    // race this interrupt into writing a second `turn.finished`.
    runtime.status = 'interrupted';
    runtime.phase = 'terminal';
    runtime.finished = true;
    // Late action results are appended immediately, flagged as post-interrupt.
    runtime.reasonCompleted = true;

    // An opted-in shutdown persists the exact route the turn ran with, on the
    // interrupt itself and before cancelling anything, so a later start can
    // admit one linked continuation. A user interrupt never carries it.
    const resume = reason === 'shutdown' && this.restartOptIn
      ? {
          turnId: turnId(turn),
          provider: runtime.model.provider,
          model: runtime.model.model,
          reasoningEffort: runtime.model.reasoningEffort,
          ...(runtime.model.fast === undefined ? {} : { fast: runtime.model.fast }),
        }
      : undefined;
    await this.ports.ledger.append(sessionId, {
      type: 'turn.interrupted',
      turn,
      parent: turnId(turn),
      reason,
      ...(resume === undefined ? {} : { resume }),
    });
    runtime.abort.abort();
    // Queued and in-flight replies check this turn's terminal flag before
    // writing. Do not wait for communication belonging to other live turns.
    await Promise.allSettled([...runtime.taskRunIds].map((id) => this.safeCancelTask(id)));
    await this.turnRunner.flushResults(session, runtime);
    await this.ports.ledger.append(sessionId, { type: 'turn.finished', turn, id: turnId(turn), status: 'interrupted' });
    runtime.durableTerminal = true;
    // An interrupted turn is no longer waiting: drop its recovery marker, fenced
    // by turn number so it never clears another active turn's wait.
    this.clearRecoveryWait(sessionId, turn);
  }

  activeTurnCount(): number {
    // A session with uncertain metadata counts as busy until its deferred body
    // recovery has replayed it: it can hold an interrupted turn that no
    // persisted marker records, so treating it as idle would let the daemon
    // report "no running turns" over work that still has to be recovered and
    // cancelled. The marker is released as soon as the replay settles.
    let count = this.recoveringTurns.size + this.uncertainSessions.size;
    for (const session of this.sessions.values()) {
      for (const turn of session.turns.values()) {
        if (!turn.durableTerminal) count += 1;
      }
    }
    return count;
  }

  hasRunningTurns(): boolean {
    return this.activeTurnCount() > 0;
  }

  readLedger(sessionId: string): LedgerEvent[] {
    return this.ports.ledger.read(sessionId);
  }

  /**
   * One bounded page of a timeline. The ledger owns the binary search and the
   * slice; only a mock ledger without a page read copies the array and pages it
   * here, so production reads never duplicate a full timeline per request.
   */
  readLedgerPage(sessionId: string, afterSeq: number, limit: number): LedgerPage {
    const readPage = this.ports.ledger.readPage;
    if (readPage !== undefined) return readPage.call(this.ports.ledger, sessionId, afterSeq, limit);
    const events = this.ports.ledger.read(sessionId);
    if (events.length === 0) throw new Error(`Unknown session: ${sessionId}`);
    return pageLedger(events, afterSeq, limit);
  }

  async inspectContext(request: ContextInspectRequest): Promise<ContextInspection> {
    this.assertOpen();
    return this.inspector.inspect(request);
  }

  async previewRoutes(): Promise<{ roles: import('../model/roles.ts').AuxiliaryRoutePreview[] }> {
    this.assertOpen();
    return { roles: [...await this.host.previewAuxiliaryRoutes()] };
  }

  readLive(sessionId: string): LiveCall[] {
    return this.live.read(sessionId);
  }

  async suggestPrompt(sessionId: string, requestId: string): Promise<{ suggestion?: string }> {
    this.assertOpen();
    // Register synchronously, before the first await, so a cancel that arrives
    // while the session is still being resolved is not lost. A newer request
    // replaces (and aborts) the previous one for this session.
    this.suggestionRequests.get(sessionId)?.controller.abort();
    const controller = new AbortController();
    this.suggestionRequests.set(sessionId, { requestId, controller });
    try {
      const session = await this.ensureSession(sessionId);
      this.assertNotDeleted(sessionId);
      // A cancel or a newer request during ensureSession wins: nothing runs.
      if (this.suggestionSuperseded(sessionId, controller)) return {};
      const turn = this.latestCompletedTurn(session);
      if (turn === undefined) return {};
      let suggestion: string;
      try {
        suggestion = await suggestNextInput(this, session, turn, controller.signal);
      } catch {
        // Defense in depth: generation is best-effort, so no abort or model
        // error may escape this path and take the daemon down. Session and
        // schema validation above already ran and still surface as before.
        return {};
      }
      // Re-verify the request is still live and still describes this very turn:
      // a cancel, a newer request or a newer turn invalidates the result.
      if (this.suggestionSuperseded(sessionId, controller)) return {};
      if (this.latestCompletedTurn(session) !== turn) return {};
      return suggestion === '' ? {} : { suggestion };
    } finally {
      const current = this.suggestionRequests.get(sessionId);
      if (current?.controller === controller) this.suggestionRequests.delete(sessionId);
    }
  }

  async cancelPromptSuggest(sessionId: string, requestId: string): Promise<void> {
    const current = this.suggestionRequests.get(sessionId);
    // A stale or unknown request id is a no-op: never abort a newer request.
    if (current === undefined || current.requestId !== requestId) return;
    this.abortSuggestion(sessionId);
  }

  /** Whether a registered suggestion request was aborted or superseded. */
  private suggestionSuperseded(sessionId: string, controller: AbortController): boolean {
    return controller.signal.aborted || this.suggestionRequests.get(sessionId)?.controller !== controller;
  }

  /** Abort and forget the in-flight suggestion request for one session, if any. */
  private abortSuggestion(sessionId: string): void {
    const current = this.suggestionRequests.get(sessionId);
    if (current === undefined) return;
    this.suggestionRequests.delete(sessionId);
    current.controller.abort();
  }

  /**
   * The newest turn, returned only when it is the durable completion with status
   * `completed`. A newer running, failed or interrupted turn yields nothing: a
   * suggestion describes the latest exchange, so an older completion is never
   * surfaced past newer work.
   */
  private latestCompletedTurn(session: SessionRuntime): TurnRuntime | undefined {
    let latest: TurnRuntime | undefined;
    for (const turn of session.turns.values()) {
      if (latest === undefined || turn.turn > latest.turn) latest = turn;
    }
    if (latest === undefined || !latest.durableTerminal || latest.status !== 'completed') return undefined;
    return latest;
  }

  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void {
    return this.ports.ledger.subscribe(sessionId, listener);
  }

  subscribeLive(sessionId: string, listener: (live: LiveCall[]) => void): () => void {
    return this.live.subscribe(sessionId, listener);
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    if (this.startupRecoveryTimer !== undefined) {
      clearTimeout(this.startupRecoveryTimer);
      this.startupRecoveryTimer = undefined;
    }
    if (this.backgroundRecoveryTimer !== undefined) {
      clearTimeout(this.backgroundRecoveryTimer);
      this.backgroundRecoveryTimer = undefined;
    }
    if (this.restartRecoveryTimer !== undefined) {
      clearTimeout(this.restartRecoveryTimer);
      this.restartRecoveryTimer = undefined;
    }
    this.uncertainSessions.clear();
    // Drain a recovery pass already in flight: each pass checks `closed`
    // between sessions, so it finishes its current session and returns
    // instead of deadlocking the close.
    while (this.recoveryPasses.size > 0) {
      await Promise.allSettled([...this.recoveryPasses]);
    }
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.idleSince.clear();
    for (const request of this.suggestionRequests.values()) request.controller.abort();
    this.suggestionRequests.clear();
    await this.ready.catch(() => undefined);
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      for (const turn of [...session.turns.values()]) {
        if (!turn.finished) {
          await this.interruptTurn(sessionId, turn.turn, 'shutdown').catch(() => undefined);
        } else if (!turn.abort.signal.aborted) {
          // Abort post-final calls (title) that no interrupt reaches.
          turn.abort.abort();
        }
      }
    }
    // Let every tracked pipeline settle before the timeline is closed.
    while (this.pipeline.size > 0) {
      await Promise.allSettled([...this.pipeline]);
    }
    this.live.clear();
    liveEngines.delete(this);
    await this.ports.ledger.close();
  }

  /**
   * Release session runtimes that no work can reference any more. A runtime is
   * only a candidate when every turn reached its durable terminal append and no
   * parse, action, queued result, admission, send, suggestion, recovery or
   * pending-work marker is left; it must stay quiet for the timeout, and the
   * condition is re-checked immediately before it is dropped. The ledger keeps
   * the durable truth, so a later send recovers the runtime again.
   */
  private sweepIdleSessions(): void {
    if (this.closed) return;
    for (const [sessionId, session] of [...this.sessions]) {
      if (!this.isSessionQuiescent(sessionId, session)) {
        this.idleSince.delete(sessionId);
        continue;
      }
      const since = this.idleSince.get(sessionId);
      if (since === undefined) {
        this.idleSince.set(sessionId, Date.now());
        continue;
      }
      if (Date.now() - since < IDLE_RUNTIME_TIMEOUT_MS) continue;
      if (this.sessions.get(sessionId) !== session || !this.isSessionQuiescent(sessionId, session)) {
        this.idleSince.delete(sessionId);
        continue;
      }
      this.sessions.delete(sessionId);
      this.idleSince.delete(sessionId);
      this.recoveryWaits.delete(sessionId);
    }
    this.pruneDeletedSessions();
  }

  /**
   * Whether nothing in or around one runtime can still make progress. The
   * `ignoreRecoveringBodies` option is used only by the background recovery
   * pass, which holds that flag for its whole run and so could never release
   * a runtime otherwise; every other gate still applies.
   */
  private isSessionQuiescent(
    sessionId: string,
    session: SessionRuntime,
    options?: { ignoreRecoveringBodies?: boolean },
  ): boolean {
    // Conservative global gate first. The pipeline holds the turn runs, the
    // interrupts and the deferred reply, reason, title and status work, and a
    // tracked promise does not carry the session it belongs to, so nothing is
    // released while any of it is in flight: an unloaded runtime would still be
    // referenced by a callback that is about to append to its ledger.
    if (this.pipeline.size > 0) return false;
    // A background pass is reading the body of a session whose pending turns
    // are unknown; a runtime it is about to rebuild must not be dropped.
    if (this.recoveringBodies && !options?.ignoreRecoveringBodies) return false;
    if (this.ensuring.has(sessionId)) return false;
    if (this.pendingSends.has(sessionId)) return false;
    if (this.suggestionRequests.has(sessionId)) return false;
    if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) return false;
    // A live streaming call still owns this runtime's call port.
    if (this.live.read(sessionId).length > 0) return false;
    const prefix = `${sessionId}:`;
    for (const key of this.recoveringTurns) {
      if (key.startsWith(prefix)) return false;
    }
    for (const turn of session.turns.values()) {
      if (!turn.durableTerminal) return false;
      if (turn.parsePromises.size > 0 || turn.actionPromises.size > 0 || turn.resultQueue.length > 0) return false;
      // Late action results can still be on their way after the queue drained.
      if (this.flushPending(turn)) return false;
    }
    return true;
  }

  /**
   * Whether one turn's deferred result flush is still in flight. The chain
   * replaces the promise it runs on, so the last promise we saw decides: an
   * unseen one is treated as pending rather than as settled.
   */
  private flushPending(turn: TurnRuntime): boolean {
    const seen = this.flushStates.get(turn);
    if (seen !== undefined && seen.promise === turn.flushPromise) return !seen.settled;
    const state = { promise: turn.flushPromise as Promise<unknown>, settled: false };
    const settle = (): void => {
      state.settled = true;
    };
    void turn.flushPromise.then(settle, settle);
    this.flushStates.set(turn, state);
    return true;
  }

  /** Forget deletion tombstones once no queued send or import can resurrect them. */
  private pruneDeletedSessions(): void {
    for (const sessionId of [...this.deletedSessions]) {
      if (this.pendingSends.has(sessionId)) continue;
      if (this.ensuring.has(sessionId)) continue;
      if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) continue;
      const prefix = `${sessionId}:`;
      let recovering = false;
      for (const key of this.recoveringTurns) {
        if (key.startsWith(prefix)) {
          recovering = true;
          break;
        }
      }
      if (!recovering) this.deletedSessions.delete(sessionId);
    }
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  private registerSession(sessionId: string, workspaceRoot: string, snapshot: WorkspaceSnapshot): SessionRuntime {
    // Never resurrect a deleted session from a late recovery.
    this.assertNotDeleted(sessionId);
    const files = this.ports.files(snapshot, workspaceRoot);
    const calls = this.live.wrap(sessionId, this.ports.calls(sessionId));
    const session: SessionRuntime = {
      sessionId,
      workspaceRoot,
      snapshot,
      files,
      actions: new ActionRunner({
        host: this.host,
        files,
        calls,
        fileStore: this.ports.fileStore,
        appendSpan: async (draft) => {
          await this.ports.ledger.append(sessionId, draft);
        },
        now: () => this.now(),
      }),
      calls,
      spanSeq: 0,
      actionSeq: 0,
      reasonQueue: Promise.resolve(),
      replyQueue: Promise.resolve(),
      title: '新会话',
      lastTitleVersion: 0,
      titleVersion: 0,
      turns: new Map(),
      nextTurn: 1,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Single-flight session recovery so concurrent callers share one replay. */
  private async ensureSession(sessionId: string): Promise<SessionRuntime> {
    await this.ready;
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    await this.ready;
    const registered = this.sessions.get(sessionId);
    if (registered) return registered;

    let pending = this.ensuring.get(sessionId);
    if (!pending) {
      pending = this.recoverSession(sessionId);
      this.ensuring.set(sessionId, pending);
      void pending.catch(() => undefined).finally(() => {
        if (this.ensuring.get(sessionId) === pending) this.ensuring.delete(sessionId);
      });
    }
    return pending;
  }

  /** Rebuild a session runtime from its stored timeline. */
  private async recoverSession(sessionId: string): Promise<SessionRuntime> {
    const events = this.ports.ledger.read(sessionId);
    const created = findCreated(events);
    if (!created) throw new Error(`unknown session: ${sessionId}`);
    const session = this.registerSession(sessionId, created.workspaceRoot, created.snapshot);
    try {
      this.replay(session, events);
      await this.recover(session, events);
    } catch (error) {
      // A runtime whose recovery failed is only half built: drop it so the next
      // access replays the timeline from scratch instead of handing out a
      // session with unclosed turns and un-cancelled orphan runs.
      if (this.sessions.get(sessionId) === session) {
        this.sessions.delete(sessionId);
        this.idleSince.delete(sessionId);
      }
      throw error;
    }
    return session;
  }

  /** Rebuild cheap derived state (title, next turn, action counter) from the ledger. */
  private replay(session: SessionRuntime, events: LedgerEvent[]): void {
    let nextTurn = 1;
    let maxAction = 0;
    for (const event of events) {
      if (typeof event.turn === 'number' && event.turn >= nextTurn) nextTurn = event.turn + 1;
      if (event.type === 'action.started' || event.type === 'action.finished') {
        const match = /^a(\d+)$/u.exec(event.id);
        if (match !== null) maxAction = Math.max(maxAction, Number(match[1]));
      }
      switch (event.type) {
        case 'session.titled': {
          const title = event.text.trim();
          if (title !== '') {
            session.title = title;
            session.lastTitleVersion += 1;
            session.titleVersion = session.lastTitleVersion;
          }
          break;
        }
        case 'turn.started':
          if (session.firstUserText === undefined) session.firstUserText = event.text;
          break;
        default:
          break;
      }
    }
    session.nextTurn = nextTurn;
    // Continue above the highest action id already on the ledger. A restart used
    // to leave the in-memory counter at 0, so new actions reused `a1` and
    // collided with earlier ones; the maximum suffix (not the count) covers both
    // a plain ledger and one whose ids were already reused by a past recovery.
    session.actionSeq = maxAction;
  }

  /** Append synthetic interruption for turns the previous process never finished. */
  private async recover(session: SessionRuntime, events: LedgerEvent[]): Promise<void> {
    const started = new Set<number>();
    const finished = new Set<number>();
    const finishedSpans = new Set<string>();
    const liveTaskRuns = new Map<number, string[]>();

    for (const event of events) {
      if (event.type === 'span.finished') finishedSpans.add(event.id);
    }
    for (const event of events) {
      if (typeof event.turn !== 'number') continue;
      if (event.type === 'turn.started') started.add(event.turn);
      if (event.type === 'turn.finished') finished.add(event.turn);
      // A dispatch's run id is durable on its task span; a task span without a
      // matching span.finished is the live run a restart must cancel.
      if (event.type === 'span.started' && event.kind === 'task' && !finishedSpans.has(event.id)) {
        liveTaskRuns.set(event.turn, [...(liveTaskRuns.get(event.turn) ?? []), event.request.taskRunId]);
      }
    }

    for (const turn of started) {
      if (finished.has(turn)) continue;
      // Close dangling children before the turn itself: spans, then actions,
      // then steps, so no started id is left without its finish event.
      await this.closeDanglingChildren(session, events, turn);
      await this.ports.ledger.append(session.sessionId, { type: 'turn.interrupted', turn, parent: turnId(turn), reason: 'restart' });
      for (const taskRunId of liveTaskRuns.get(turn) ?? []) {
        await this.safeCancelTask(taskRunId);
      }
      await this.ports.ledger.append(session.sessionId, { type: 'turn.finished', turn, id: turnId(turn), status: 'interrupted' });
      this.recoveringTurns.delete(`${session.sessionId}:${turn}`);
    }
  }

  /**
   * Close every dangling child of one crashed turn: an unfinished span, action
   * or step gets its `*.finished` event with status `interrupted`, in the order
   * spans, actions, steps. Ids repeated by more than one start event (a
   * dispatch's second `action.started`) are finished once.
   */
  private async closeDanglingChildren(session: SessionRuntime, events: LedgerEvent[], turn: number): Promise<void> {
    const turnEvents = events.filter((event) => event.turn === turn);
    const finishedSpans = new Set<string>();
    const finishedActions = new Set<string>();
    const finishedSteps = new Set<string>();
    for (const event of turnEvents) {
      if (event.type === 'span.finished') finishedSpans.add(event.id);
      else if (event.type === 'action.finished') finishedActions.add(event.id);
      else if (event.type === 'step.finished') finishedSteps.add(event.id);
    }

    const seenSpans = new Set<string>();
    for (const event of turnEvents) {
      if (event.type !== 'span.started' || finishedSpans.has(event.id) || seenSpans.has(event.id)) continue;
      seenSpans.add(event.id);
      await this.ports.ledger.append(session.sessionId, {
        type: 'span.finished',
        id: event.id,
        kind: event.kind,
        turn: event.turn,
        ...(event.step === undefined ? {} : { step: event.step }),
        status: 'interrupted',
      });
    }

    const seenActions = new Set<string>();
    for (const event of turnEvents) {
      if (event.type !== 'action.started' || finishedActions.has(event.id) || seenActions.has(event.id)) continue;
      seenActions.add(event.id);
      await this.ports.ledger.append(session.sessionId, {
        type: 'action.finished',
        id: event.id,
        action: { type: event.action.type },
        turn: event.turn,
        ...(event.step === undefined ? {} : { step: event.step }),
        status: 'interrupted',
        result: '',
        afterInterrupt: true,
      });
    }

    const seenSteps = new Set<string>();
    for (const event of turnEvents) {
      if (event.type !== 'step.started' || finishedSteps.has(event.id) || seenSteps.has(event.id)) continue;
      seenSteps.add(event.id);
      await this.ports.ledger.append(session.sessionId, {
        type: 'step.finished',
        id: event.id,
        turn: event.turn,
        ...(event.step === undefined ? {} : { step: event.step }),
        status: 'interrupted',
      });
    }
  }

  // ── turn state machine ──────────────────────────────────────────────────

  private createTurn(
    turn: number,
    userText: string,
    attachmentsKey: string,
    model: TurnRuntime['model'],
    publicId: string,
    contextWindow: number | undefined,
  ): TurnRuntime {
    return {
      turn,
      userText,
      attachmentsKey,
      model,
      publicId,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      imageUnsupported: false,
      phase: 'preparing',
      step: 0,
      abort: new AbortController(),
      actions: new Map(),
      finished: false,
      durableTerminal: false,
      resultQueue: [],
      flushPromise: Promise.resolve(),
      dropDeferred: false,
      reasonCompleted: false,
      actionsThisStep: 0,
      toolCallsThisStep: 0,
      portToolCallsThisTurn: 0,
      asksThisStep: [],
      parsePromises: new Set(),
      actionPromises: new Set(),
      stepText: '',
      taskRunIds: new Set(),
      correctionRequired: false,
      emptyReasonRetried: false,
      currentReasonText: '',
    };
  }

  private isOwnedSessionFile(sessionId: string, path: string, events: readonly LedgerEvent[]): boolean {
    if (isInside(path, join(this.host.stateRoot, 'sessions', sessionId, 'files'))) return true;
    const runIds = new Set<string>();
    for (const event of events) {
      if ((event.type === 'action.started' || event.type === 'files.attached') && event.taskRunId !== undefined) {
        runIds.add(event.taskRunId);
      }
    }
    for (const runId of runIds) {
      if (isInside(path, join(this.host.stateRoot, 'artifacts', runId))) return true;
    }
    return false;
  }

  async appendError(
    sessionId: string,
    stage: string,
    message: string,
    turn: TurnRuntime,
    step?: number,
  ): Promise<void> {
    try {
      const stepNumber = step ?? turn.step;
      // The owning step when one is in progress, else the turn.
      const parent = turn.currentStepId ?? turnId(turn.turn);
      await this.ports.ledger.append(sessionId, {
        type: 'system.error',
        source: 'system',
        code: stage,
        message,
        ...(turn.turn > 0 ? { turn: turn.turn, step: stepNumber, parent } : {}),
      });
    } catch {
      // Error reporting must never take the pipeline down.
    }
  }

  /** Reserve the next session-wide action id. */
  nextActionId(session: SessionRuntime): string {
    return `a${++session.actionSeq}`;
  }

  /** Reserve the next span id for one turn. */
  private nextSpanId(session: SessionRuntime, turn: TurnRuntime): string {
    return `s${turn.turn}.${++session.spanSeq}`;
  }

  /**
   * Run one model call. `calls.ts` writes the `span.started` / `span.finished`
   * events and throws on failure, so every role's failure consequence is decided
   * here.
   */
  async invoke(
    session: SessionRuntime,
    turn: TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra: {
      spanId?: string;
      parent?: string;
      reason?: {
        provider: string;
        model: string;
        reasoningEffort: ReasoningEffort;
        /** Explicit Fast preference forwarded to the main reasoning call. */
        fast?: boolean;
      };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
      onToolCall?: (call: ToolCall) => void;
      /** Forwarded for the `reason` role's recovery wait lifecycle. */
      onWait?: (state: { reason: import('../transport/index.ts').ModelWaitReason; retryAt?: string } | null) => void;
      tools?: readonly import('../transport/index.ts').ToolSpec[];
      toolChoice?: import('../transport/index.ts').ToolChoice;
      maxTokens?: number;
      step?: number;
      /** Overrides the owning turn's abort signal (see `SessionCallHost.invoke`). */
      signal?: AbortSignal;
    } = {},
  ): Promise<InvokedCall> {
    const spanId = extra.spanId ?? this.nextSpanId(session, turn);
    const parent = extra.parent ?? (role === 'reason' ? stepId(turn.turn, turn.step) : turnId(turn.turn));
    // The index a span carries matches the thing it serves: the step for a
    // reasoning span, an explicit step for a step-scoped system call (a reply),
    // and no step for a turn-level system action's own span (title, memory).
    const step = extra.step ?? (role === 'reason' ? turn.step : undefined);
    try {
      const result = await session.calls.run({
        spanId,
        parent,
        role,
        turn: turn.turn,
        step,
        messages: view.messages,
        layers: view.layers,
        signal: extra.signal ?? turn.abort.signal,
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra.onText === undefined ? {} : { onText: extra.onText }),
        ...(extra.onReasoning === undefined ? {} : { onReasoning: extra.onReasoning }),
        ...(extra.onToolCall === undefined ? {} : { onToolCall: extra.onToolCall }),
        ...(extra.onWait === undefined ? {} : { onWait: extra.onWait }),
        ...(extra.tools === undefined ? {} : { tools: extra.tools }),
        ...(extra.toolChoice === undefined ? {} : { toolChoice: extra.toolChoice }),
        ...(extra.maxTokens === undefined ? {} : { maxTokens: extra.maxTokens }),
      });
      return {
        ok: true,
        spanId,
        text: result.text,
        toolCalls: result.toolCalls,
        ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
        ...(result.metrics === undefined ? {} : { metrics: result.metrics }),
      };
    } catch (error) {
      const failure = error instanceof ModelCallError && error.detail.failure !== undefined
        ? {
            model: error.detail.model,
            kind: error.detail.failure.kind,
            ...(error.detail.failure.status === undefined ? {} : { status: error.detail.failure.status }),
            message: error.detail.failure.message,
            ...(error.detail.metrics === undefined ? {} : { metrics: error.detail.metrics }),
          }
        : undefined;
      return {
        ok: false,
        spanId,
        text: '',
        error: messageOf(error),
        ...(failure === undefined ? {} : { failure }),
      };
    }
  }

  async safeCancelTask(taskRunId: string): Promise<void> {
    try {
      await this.host.cancelTaskRun(taskRunId);
    } catch {
      // Cancellation is best-effort; a stale run id must not fail the turn.
    }
  }

  // ── live streaming snapshots ────────────────────────────────────────────

  track(promise: Promise<unknown>): void {
    this.pipeline.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => this.pipeline.delete(promise));
  }

  now(): Date {
    return this.host.now ? this.host.now() : new Date();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('session is closed');
  }

  private assertNotDeleted(sessionId: string): void {
    if (this.deletedSessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
  }

  /** Count one in-flight attachment import for the session. */
  private beginAdmission(sessionId: string): void {
    this.pendingAdmissions.set(sessionId, (this.pendingAdmissions.get(sessionId) ?? 0) + 1);
  }

  /** Release one admission; the entry is dropped only when the last one ends. */
  private endAdmission(sessionId: string): void {
    const remaining = (this.pendingAdmissions.get(sessionId) ?? 1) - 1;
    if (remaining <= 0) this.pendingAdmissions.delete(sessionId);
    else this.pendingAdmissions.set(sessionId, remaining);
  }
}

// ─── shared helpers ────────────────────────────────────────────────────────

/** Guard one storage directory segment (session id / task run id). */
function assertStorageSegment(value: string): void {
  if (value === '.' || value === '..' || value === '' || /[/\\\u0000]/u.test(value)) {
    throw new Error(`invalid storage segment: ${value}`);
  }
}

/**
 * True only when the resolved model declares a verified Fast mode. An unknown
 * provider or model is not Fast-capable, so a requested Fast is refused instead
 * of being silently dropped.
 */
function declaresFast(provider: ProviderDefinition | undefined, modelId: string): boolean {
  if (provider === undefined) return false;
  const resolved = provider.modelAliases?.[modelId] ?? modelId;
  return provider.models.find((entry) => entry.id === resolved)?.supportsFast === true;
}

/** The main model (`provider/model`) of the latest turn before `turn`, if any. */
function lastTurnModel(events: readonly LedgerEvent[], turn: number): string | undefined {
  let started: Extract<LedgerEvent, { type: 'turn.started' }> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'turn.started' && event.turn !== turn) { started = event; break; }
  }
  if (started === undefined) return undefined;
  let model: string | undefined
  for (const event of events) {
    if (event.turn === started.turn && event.type === 'span.finished' && event.kind === 'reasoning' && event.requestModel !== undefined) model = event.requestModel
  }
  return model ?? `${started.model.provider}/${started.model.model}`;
}

/**
 * Stable identity of one send's attachment list, for the narrow send latch and
 * the recovery-resubmission comparison.
 */
function attachmentKey(attachments: readonly AttachmentInput[] | undefined): string {
  if (attachments === undefined || attachments.length === 0) return '';
  // Hash every identity field, so an attachment set with only a data URL (no
  // path) still has a distinct, stable key rather than collapsing to the empty
  // string and being mistaken for an attachment-free send.
  const hash = createHash('sha256');
  for (const item of attachments) {
    hash.update(item.path ?? '');
    hash.update('\u0000');
    hash.update(item.name ?? '');
    hash.update('\u0000');
    hash.update(item.dataUrl ?? '');
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

/** A plain, attachment-free manual continue: trimmed `继续` or `continue`. */
function isPlainContinue(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '继续' || trimmed.toLowerCase() === 'continue';
}

/** The original turn number a restart marker names; unparsable ids sort first. */
function markerTurn(marker: TurnResumeMarker): number {
  const match = /^t(\d+)$/u.exec(marker.turnId);
  return match === null ? 0 : Number(match[1]);
}

/**
 * The one user message of a restart continuation. It names the restart as the
 * reason for the interruption and asks the model to continue from the durable
 * worktree and ledger state, without repeating already completed effects.
 */
function restartContinuationText(marker: TurnResumeMarker): string {
  return [
    `The daemon was restarted to install an upgrade while turn ${marker.turnId} was still running.`,
    'Continue that work from the current worktree and ledger state.',
    'Do not repeat completed side effects or dispatches, and do not replay earlier actions.',
    'Before acting, reconcile the task ids that already exist and any interrupted action whose outcome is uncertain.',
  ].join(' ');
}

/** Page a copied timeline for a ledger that has no native page read. */
function pageLedger(events: readonly LedgerEvent[], afterSeq: number, limit: number): LedgerPage {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.seq <= afterSeq) low = middle + 1;
    else high = middle;
  }
  const width = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : events.length;
  const end = Math.min(events.length, low + width);
  return {
    events: events.slice(low, end),
    lastSeq: events.length > 0 ? events[events.length - 1]!.seq : 0,
    hasMore: end < events.length,
  };
}
