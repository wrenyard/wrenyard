/**
 * session engine: the session lifecycle and composition of the turn loop.
 *
 * The engine owns session creation, on-demand timeline recovery, deletion, media and the
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
    // Startup is metadata-only: session bodies are read only on first touch.
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
   * Completed timelines are never parsed here. A session that is touched first
   * is recovered by `ensureSession` on demand.
   */
  private async initialize(): Promise<void> {
    await this.ports.ledger.init();
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
   * checked turn by turn. Never touches the ledger, so it stays a pure read of
   * in-memory state.
   */
  private sessionHasRunningTurns(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      for (const turn of runtime.turns.values()) {
        if (!turn.durableTerminal) return true;
      }
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
    if (turn.durableTerminal || turn.finished || turn.closing) return undefined;
    // Counted in the same tick as the append is queued, so a step that reads
    // this count before its own step.started also sees the event.
    turn.steers = (turn.steers ?? 0) + 1;
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
        /** Auto-selection provenance recorded on the turn. */
        autoSelected?: boolean;
      };
      attachments?: AttachmentInput[];
      /** Optional provenance of a bot-originated send; absent on ordinary sends. */
      sender?: { botId: string };
    }
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
    // A bot's own session (a host that binds it to a bot tool port) runs on an
    // automatically selected model that may be replaced within the turn. A
    // work session's model is chosen by its caller, a person or a bot sending
    // to it, and never switches inside a running turn.
    const automatic = this.host.agentTools?.(sessionId) !== undefined;
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

    const result = this.admitTurn(sessionId, modelInput, model);
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
        /** Auto-selection provenance recorded on the turn. */
        autoSelected?: boolean;
      };
      attachments?: AttachmentInput[];
      /** Optional provenance of a bot-originated send; absent on ordinary sends. */
      sender?: { botId: string };
    },
    publicId: string
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
        ...(input.sender === undefined ? {} : { sender: input.sender }),
      });
    } catch (error) {
      // A turn whose start never reached the timeline was never admitted:
      // forget it so it is not counted active and cannot be interrupted.
      session.turns.delete(turnNumber);
      throw error;
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

  private async interruptTurn(
    sessionId: string,
    turn: number,
    reason: 'user' | 'shutdown',
  ): Promise<void> {
    const session = await this.ensureSession(sessionId);
    const runtime = session.turns.get(turn);
    if (!runtime || runtime.finished) {
      return;
    }

    // Flip the terminal flag synchronously so an in-flight step cannot race
    // this interrupt into writing a second `turn.finished`.
    runtime.status = 'interrupted';
    runtime.phase = 'terminal';
    runtime.finished = true;
    // Late action results are appended immediately, flagged as post-interrupt.
    runtime.reasonCompleted = true;

    await this.ports.ledger.append(sessionId, {
      type: 'turn.interrupted',
      turn,
      parent: turnId(turn),
      reason,
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
    let count = 0;
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

  /** Whether nothing in or around one runtime can still make progress. */
  private isSessionQuiescent(
    sessionId: string,
    session: SessionRuntime,
  ): boolean {
    // Conservative global gate first. The pipeline holds the turn runs, the
    // interrupts and the deferred reply, reason, title and status work, and a
    // tracked promise does not carry the session it belongs to, so nothing is
    // released while any of it is in flight: an unloaded runtime would still be
    // referenced by a callback that is about to append to its ledger.
    if (this.pipeline.size > 0) return false;
    if (this.ensuring.has(sessionId)) return false;
    if (this.pendingSends.has(sessionId)) return false;
    if (this.suggestionRequests.has(sessionId)) return false;
    if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) return false;
    // A live streaming call still owns this runtime's call port.
    if (this.live.read(sessionId).length > 0) return false;
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
      this.deletedSessions.delete(sessionId);
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
      // matching span.finished is the live run an orphaned turn must cancel.
      if (event.type === 'span.started' && event.kind === 'task' && !finishedSpans.has(event.id)) {
        liveTaskRuns.set(event.turn, [...(liveTaskRuns.get(event.turn) ?? []), event.request.taskRunId]);
      }
    }

    for (const turn of started) {
      if (finished.has(turn)) continue;
      // Close dangling children before the turn itself: spans, then actions,
      // then steps, so no started id is left without its finish event.
      await this.closeDanglingChildren(session, events, turn);
      await this.ports.ledger.append(session.sessionId, { type: 'turn.interrupted', turn, parent: turnId(turn), reason: 'shutdown' });
      for (const taskRunId of liveTaskRuns.get(turn) ?? []) {
        await this.safeCancelTask(taskRunId);
      }
      await this.ports.ledger.append(session.sessionId, { type: 'turn.finished', turn, id: turnId(turn), status: 'interrupted' });
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
        ...(result.route === undefined ? {} : { route: result.route }),
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
