/**
 * `@wrenyard/harness`: the conversation orchestrator, bot/auxiliary drivers,
 * XML context projectors, and workspace document/memory/media tools layered
 * over `@wrenyard/session`, `@wrenyard/loop`, and `@wrenyard/ai`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  admitSessionModel,
  createCallRunner,
  createModelTransport,
  isReasoningEffortSupported,
  ModelCallError,
  SUGGESTION_MAX_TOKENS,
  type AuxiliaryRoute,
  type ReasonSelection,
  type ReasoningRetryPolicy,
} from '@wrenyard/ai';
import { resolveModelMetadata } from '@wrenyard/ai/metadata';
import type { ToolCall, ToolSpec, ToolChoice, ModelWaitReason } from '@wrenyard/ai/transport';
import { SpanRecorder } from '@wrenyard/loop';
import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models';
import {
  createSessionManager,
  ManagedSession,
  MemorySessionPersistence,
  PendingSendLatch,
  SessionManager,
  type SessionPersistencePort,
} from '@wrenyard/session';
import {
  collectSessionFiles,
  turnId,
  stepId,
  CONTEXT_EVENT_TYPES,
  type ActionType,
  type LedgerEvent,
  type LedgerEventDraft,
  type LedgerPage,
  type ReplySentEvent,
  type SessionSummary,
  type TurnModel,
  type TurnStatus,
  type WorkspaceSnapshot,
} from './events.ts';
import {
  AUXILIARY_ROLE_ORDER,
  ROLE_ROUTE_REQUIREMENTS,
  type AuxiliaryCallRole,
  type AuxiliaryRoutePreview,
  type CallRole,
  type HarnessTurnInput,
} from './types.ts';
import type {
  AgentToolPort,
  BuiltView,
  CallsPort,
  CallRunRequest,
  CallRunResult,
  EnginePorts,
  HarnessHost,
  HarnessSession,
  InvokedCall,
  LedgerPort,
  LiveCall,
  MethodInfo,
  ProjectInfo,
  RecoveryWait,
  Session,
  SessionCallHost,
  SessionHost,
  WorkspaceMemoryPort,
} from './ports.ts';
import { messageOf } from './errors.ts';
import {
  DocumentCommitter,
  createDocumentAuthority,
  type DocumentAuthority,
  type DocumentBeforeAppendContext,
  type DocumentBeforeAppendResult,
  type DocumentCommit,
  type DocumentCommitContext,
  type DocumentPersistencePort,
} from './tools/document-commit.ts';
import { createWorkspaceMemory } from './tools/memory-write.ts';
import { WorkspaceFileSource } from './tools/workspace-files.ts';
import {
  FileStore,
  isInside,
  type AttachmentInput,
  type SessionFile,
  type TaskArtifact,
} from './tools/media-store.ts';
import { ContextInspector, findCreated, type ContextInspectRequest, type ContextInspection } from './context/inspect.ts';
import { buildSnapshot } from './context/snapshot.ts';
import { createReasoningProjector, type ReasoningProjectorInput } from './context/projector.ts';
import { getAuxiliaryDefinition, type AuxiliaryDefinition, type AuxiliaryDefinitionId } from './auxiliary/definitions.ts';
import { ReplyWriter } from './auxiliary/reply.ts';
import { suggestNextInput } from './auxiliary/prompt-suggestion.ts';
import { regenerateTitle } from './auxiliary/title.ts';
import { ActionRunner } from './drivers/executor.ts';
import { OrchestratorLoop } from './drivers/orchestrator.ts';
import { BotLoop } from './drivers/bot.ts';
import type { SessionRuntime, TurnRuntime } from './drivers/runtime.ts';

// ── Composition root contract ───────────────────────────────────────────────

export type {
  AgentToolPort,
  HarnessHost,
  HarnessSession,
  LiveCall,
  MethodInfo,
  ProjectInfo,
  Session,
  SessionHost,
  WorkspaceMemoryPort,
};

export {
  DocumentCommitter,
  createDocumentAuthority,
  type DocumentAuthority,
  type DocumentBeforeAppendContext,
  type DocumentBeforeAppendResult,
  type DocumentCommit,
  type DocumentCommitContext,
  type DocumentPersistencePort,
};

// ── Ledger & events ─────────────────────────────────────────────────────────

export {
  CONTEXT_EVENT_TYPES,
  collectSessionFiles,
  stepId,
  turnId,
  type ActionType,
  type LedgerEvent,
  type LedgerEventDraft,
  type LedgerPage,
  type ReplySentEvent,
  type SessionSummary,
  type TurnModel,
  type TurnStatus,
};

// ── Context inspection & projection ─────────────────────────────────────────

export {
  createReasoningProjector,
  type ContextInspectRequest,
  type ContextInspection,
  type ReasoningProjectorInput,
};

// ── Workspace memory ────────────────────────────────────────────────────────

export { createWorkspaceMemory };

// ── Model routing & auxiliaries ─────────────────────────────────────────────

export {
  AUXILIARY_ROLE_ORDER,
  ROLE_ROUTE_REQUIREMENTS,
  createCallRunner,
  getAuxiliaryDefinition,
  type AuxiliaryCallRole,
  type AuxiliaryDefinition,
  type AuxiliaryDefinitionId,
  type AuxiliaryRoute,
  type AuxiliaryRoutePreview,
  type ReasonSelection,
  type ReasoningRetryPolicy,
};

// ── Media & attachments ─────────────────────────────────────────────────────

export {
  FileStore,
  type AttachmentInput,
  type SessionFile,
  type TaskArtifact,
};

// ─── Session Creation ───────────────────────────────────────────────────────

const DEFAULT_TITLE = '新会话';
const IDLE_RUNTIME_SWEEP_MS = 30_000;
const IDLE_RUNTIME_TIMEOUT_MS = 60_000;

/**
 * Shared process-local peer registry across `SessionManager` instances so
 * cross-engine interrupts (e.g., daemon interrupting a bot-owned manager)
 * route cleanly through `@wrenyard/session`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous manager peer set
const peerManagers = new Set<SessionManager<any, any, any, any>>();

export interface CreateSessionOptions {
  /** Persistence backend implementing `@wrenyard/session`'s `SessionPersistencePort`; defaults to in-memory persistence. */
  persistence?: SessionPersistencePort<LedgerEvent, SessionSummary>;
  /** Fresh ranked routes for an automatic main reasoning turn when switching models. */
  selectAutomaticRoutes?: () => readonly ReasonSelection[] | Promise<readonly ReasonSelection[]>;
  /** Live global retry switches for main reasoning. */
  retryPolicy?: ReasoningRetryPolicy;
  /** Optional shared document committer; if omitted on a hook-capable persistence backend, one is created automatically. */
  documentCommitter?: DocumentCommitter;
}

function hasDocumentPersistenceHook(
  persistence: unknown,
): persistence is DocumentPersistencePort {
  return (
    persistence !== null
    && typeof persistence === 'object'
    && 'setBeforeAppendHook' in persistence
    && typeof (persistence as { setBeforeAppendHook?: unknown }).setBeforeAppendHook === 'function'
  );
}

/** Create a Wrenyard conversation harness session service over a host. */
export function createSession(host: SessionHost, options?: CreateSessionOptions): Session {
  const persistence = options?.persistence ?? new MemorySessionPersistence<LedgerEvent, SessionSummary>({
    ...(host.now === undefined ? {} : { now: host.now }),
  });

  if (options?.documentCommitter === undefined && hasDocumentPersistenceHook(persistence)) {
    createDocumentAuthority({
      workspaceRoot: host.workspaceRoot,
      stateRoot: host.stateRoot,
      persistence,
    });
  }

  return new HarnessEngine(host, persistence, options);
}

/** Alias for {@link createSession}. */
export const createHarnessSession = createSession;

// ─── Harness Engine ─────────────────────────────────────────────────────────

class HarnessEngine implements Session, SessionCallHost {
  readonly host: SessionHost;
  readonly ports: EnginePorts;
  readonly ledger: LedgerPort;

  private readonly manager: SessionManager<LedgerEvent, SessionSummary, HarnessTurnInput, void>;
  private readonly runtimes = new WeakMap<
    ManagedSession<LedgerEvent, HarnessTurnInput, SessionSummary>,
    SessionRuntime
  >();
  private readonly runners = new Map<string, CallsPort>();
  private readonly replies: ReplyWriter;
  private readonly orchestratorLoop: OrchestratorLoop;
  private readonly botLoop: BotLoop;
  private readonly inspector: ContextInspector;
  private readonly pendingSendLatch = new PendingSendLatch<{ turn: number }>();
  private readonly recoveryWaits = new Map<string, RecoveryWait>();
  private readonly suggestionRequests = new Map<string, { requestId: string; controller: AbortController }>();
  private readonly pipeline = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    host: SessionHost,
    persistence: SessionPersistencePort<LedgerEvent, SessionSummary>,
    options?: CreateSessionOptions,
  ) {
    this.host = host;
    const fileStore = new FileStore({ stateRoot: host.stateRoot });

    this.manager = createSessionManager<LedgerEvent, SessionSummary, HarnessTurnInput, void>({
      persistence,
      peerGroup: peerManagers,
      ...(host.now === undefined ? {} : { now: host.now }),
      idleTimeoutMs: IDLE_RUNTIME_TIMEOUT_MS,
      sweepIntervalMs: IDLE_RUNTIME_SWEEP_MS,
      isQuiescent: (sessionId) =>
        this.pipeline.size === 0
        && !this.suggestionRequests.has(sessionId)
        && !this.pendingSendLatch.hasPrefix(`${sessionId}\u0000`)
        && !this.hasPendingResultQueue(sessionId),
      onRecover: async ({ repair }) => {
        for (const taskRunId of repair.danglingTaskRunIds) {
          await this.safeCancelTask(taskRunId);
        }
      },
      onRuntimeCreate: (managed) => {
        this.hydrateSessionRuntime(managed);
      },
      driver: {
        runTurn: async (ctx) => {
          const managed = this.manager.getRuntime(ctx.sessionId);
          if (managed === undefined) {
            throw new Error(`Unknown session runtime: ${ctx.sessionId}`);
          }
          const sessionRuntime = this.ensureHarnessRuntime(managed);
          const turnRuntime = sessionRuntime.turns.get(ctx.turn);
          if (turnRuntime === undefined) {
            throw new Error(`Unknown turn runtime: ${ctx.sessionId}#${ctx.turn}`);
          }
          const onAbort = (): void => {
            turnRuntime.status = 'interrupted';
            turnRuntime.phase = 'terminal';
            turnRuntime.finished = true;
            turnRuntime.reasonCompleted = true;
            turnRuntime.abort.abort();
          };
          if (ctx.signal.aborted) {
            onAbort();
          } else {
            ctx.signal.addEventListener('abort', onAbort, { once: true });
          }
          const loop = this.host.agentTools?.(ctx.sessionId) !== undefined
            ? this.botLoop
            : this.orchestratorLoop;
          try {
            await loop.runTurn(sessionRuntime, turnRuntime, {
              managed,
              signal: ctx.signal,
            });
          } finally {
            ctx.signal.removeEventListener('abort', onAbort);
            if (turnRuntime.finished && !turnRuntime.durableTerminal && !ctx.signal.aborted) {
              turnRuntime.durableTerminal = true;
              this.clearRecoveryWait(ctx.sessionId, ctx.turn);
            }
          }
        },
        interruptTurn: async ({ sessionId, turn }) => {
          const managed = this.manager.getRuntime(sessionId);
          if (managed === undefined) return;
          const sessionRuntime = this.runtimes.get(managed);
          if (sessionRuntime === undefined) return;
          const turnRuntime = sessionRuntime.turns.get(turn);
          if (turnRuntime === undefined) return;

          if (turnRuntime.durableTerminal || turnRuntime.interruptHandled) {
            if (turnRuntime.stepFinishPromise !== undefined) {
              await turnRuntime.stepFinishPromise.catch(() => undefined);
            }
            return;
          }

          turnRuntime.interruptHandled = true;
          turnRuntime.status = 'interrupted';
          turnRuntime.phase = 'terminal';
          turnRuntime.finished = true;
          turnRuntime.reasonCompleted = true;
          if (!turnRuntime.abort.signal.aborted) {
            turnRuntime.abort.abort();
          }
          this.clearRecoveryWait(sessionId, turn);

          const loop = this.host.agentTools?.(sessionId) !== undefined
            ? this.botLoop
            : this.orchestratorLoop;
          await loop.actions.cancelRunningWork(turnRuntime);
          await sessionRuntime.replyQueue;
          await loop.flushResults(sessionRuntime, turnRuntime);
          if (turnRuntime.stepFinishPromise !== undefined) {
            await turnRuntime.stepFinishPromise.catch(() => undefined);
          }
          await loop.finishStep(sessionRuntime, turnRuntime, 'interrupted');
          turnRuntime.durableTerminal = true;
        },
      },
    });

    this.ledger = {
      init: () => this.manager.init(),
      append: (sessionId, draft) => this.manager.append(sessionId, draft),
      read: (sessionId) => this.manager.read(sessionId),
      readPage: (sessionId, afterSeq, limit) => this.manager.readPage(sessionId, afterSeq, limit),
      listSessions: () => this.manager.listSessions(),
      subscribe: (sessionId, listener) => this.manager.subscribe(sessionId, listener),
      deleteSession: (sessionId) => this.manager.deleteSession(sessionId),
      close: () => this.manager.close(),
    };

    const calls = (sessionId: string): CallsPort => {
      let runner = this.runners.get(sessionId);
      if (runner === undefined) {
        const recorder = new SpanRecorder((draft) =>
          this.manager.append(sessionId, draft as unknown as LedgerEventDraft).then(() => undefined),
        );
        const executor = createCallRunner<AuxiliaryCallRole, 'reason'>({
          transport: createModelTransport({ gateway: () => host.gateway() }),
          resolveAuxiliaryModel: (role, input) => host.resolveAuxiliaryModel(role, input),
          ...(options?.selectAutomaticRoutes === undefined
            ? {}
            : { selectAutomaticRoutes: () => options.selectAutomaticRoutes!() }),
          ...(options?.retryPolicy === undefined
            ? (host.retryPolicy === undefined ? {} : { retryPolicy: host.retryPolicy })
            : { retryPolicy: options.retryPolicy }),
          models: async () => (await host.gateway()).models,
          cacheKey: sessionId,
          append: recorder.report,
          roleMaxTokens: { suggestion: SUGGESTION_MAX_TOKENS },
          ...(host.now === undefined ? {} : { now: () => host.now!() }),
        });
        const base: CallsPort = {
          run: (input) => executor.run(input),
          holdSpan: (spanId) => recorder.hold(spanId),
          releaseSpan: (spanId, status) => recorder.release(spanId, status),
          ...(host.recordAuxiliaryRun === undefined ? {} : {
            recordAuxiliaryRun: (input) => host.recordAuxiliaryRun!(input),
          }),
        };
        runner = this.wrapCallsWithLiveHub(sessionId, base);
        this.runners.set(sessionId, runner);
      }
      return runner;
    };

    this.ports = {
      ledger: this.ledger,
      memory: createWorkspaceMemory(host.workspaceRoot),
      ...(host.memoryFor === undefined ? {} : { memoryFor: (sessionId) => host.memoryFor!(sessionId) }),
      files: (_snapshot, workspaceRoot) => new WorkspaceFileSource({ workspaceRoot }),
      calls,
      fileStore,
    };

    this.replies = new ReplyWriter(this, host.deviceName);
    this.orchestratorLoop = new OrchestratorLoop(this, this.replies);
    this.botLoop = new BotLoop(this, this.replies);
    this.inspector = new ContextInspector({
      workspaceRoot: host.workspaceRoot,
      deviceName: host.deviceName,
      ledger: this.ledger,
      models: async () => (await host.gateway()).models,
      now: () => this.now(),
      createSnapshot: () => buildSnapshot(this.host),
    });
  }

  private wrapCallsWithLiveHub(sessionId: string, inner: CallsPort): CallsPort {
    const liveHub = this.manager.liveHub;
    return {
      run: async (input: CallRunRequest): Promise<CallRunResult> => {
        if (input.role !== 'reason') return inner.run(input);
        liveHub.begin(sessionId, input.spanId);
        const onText = input.onText;
        const onReasoning = input.onReasoning;
        try {
          return await inner.run({
            ...input,
            onText: (delta) => {
              liveHub.append(sessionId, input.spanId, 'text', delta);
              onText?.(delta);
            },
            onReasoning: (delta) => {
              liveHub.append(sessionId, input.spanId, 'reasoning', delta);
              onReasoning?.(delta);
            },
          });
        } finally {
          liveHub.end(sessionId, input.spanId);
        }
      },
      holdSpan: (spanId) => inner.holdSpan(spanId),
      releaseSpan: (spanId, status) => inner.releaseSpan(spanId, status),
      ...(inner.recordAuxiliaryRun === undefined ? {} : {
        recordAuxiliaryRun: (input) => inner.recordAuxiliaryRun!(input),
      }),
    };
  }

  private hydrateSessionRuntime(
    managed: ManagedSession<LedgerEvent, HarnessTurnInput, SessionSummary>,
  ): SessionRuntime {
    const events = managed.read();
    const created = findCreated(events);
    if (created === undefined) {
      throw new Error(`unknown session: ${managed.sessionId}`);
    }
    const sessionRuntime = this.buildSessionRuntime(
      managed.sessionId,
      created.workspaceRoot,
      created.snapshot,
    );
    this.replaySessionMetadata(sessionRuntime, events);
    this.runtimes.set(managed, sessionRuntime);
    return sessionRuntime;
  }

  private ensureHarnessRuntime(
    managed: ManagedSession<LedgerEvent, HarnessTurnInput, SessionSummary>,
  ): SessionRuntime {
    return this.runtimes.get(managed) ?? this.hydrateSessionRuntime(managed);
  }

  private buildSessionRuntime(
    sessionId: string,
    workspaceRoot: string,
    snapshot: WorkspaceSnapshot,
  ): SessionRuntime {
    const files = this.ports.files(snapshot, workspaceRoot);
    const calls = this.ports.calls(sessionId);
    return {
      sessionId,
      workspaceRoot,
      snapshot,
      files,
      actions: new ActionRunner(
        {
          host: this.host,
          files,
          calls,
          fileStore: this.ports.fileStore,
          appendSpan: async (draft) => {
            await this.ledger.append(sessionId, draft);
          },
          now: () => this.now(),
        },
        (id) => this.manager.getRuntime(id),
      ),
      calls,
      spanSeq: 0,
      actionSeq: 0,
      reasonQueue: Promise.resolve(),
      replyQueue: Promise.resolve(),
      title: DEFAULT_TITLE,
      lastTitleVersion: 0,
      titleVersion: 0,
      turns: new Map(),
      nextTurn: 1,
    };
  }

  private replaySessionMetadata(session: SessionRuntime, events: readonly LedgerEvent[]): void {
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
    session.actionSeq = maxAction;
  }

  // ── Public Session API ────────────────────────────────────────────────────

  async createSession(): Promise<{ sessionId: string }> {
    this.assertOpen();
    await this.manager.init();
    const snapshot = await buildSnapshot(this.host);
    const sessionId = randomUUID();
    this.assertOpen();
    await this.manager.createSession(sessionId, [{
      type: 'session.created',
      workspaceRoot: this.host.workspaceRoot,
      snapshot,
    }]);
    return { sessionId };
  }

  listSessions(): SessionSummary[] {
    return this.manager.listSessions();
  }

  async send(
    sessionId: string,
    input: Parameters<Session['send']>[1],
  ): Promise<{ turn: number }> {
    this.assertOpen();
    const automatic = this.host.agentTools?.(sessionId) !== undefined;
    const modelInput = automatic
      ? { ...input, model: { ...input.model, automatic: true } }
      : input;
    const publicId = `${modelInput.model.provider}/${modelInput.model.model}`;
    const effort = modelInput.model.reasoningEffort;
    const fast = modelInput.model.fast;
    const attachmentsKey = attachmentKey(modelInput.attachments);

    const waiting = this.recoveryWaits.get(sessionId);
    if (
      waiting !== undefined
      && waiting.model === publicId
      && waiting.effort === effort
      && this.isWaitingResubmission(sessionId, waiting, modelInput.text, attachmentsKey, fast)
    ) {
      return { turn: waiting.turn };
    }

    const dedupKey = JSON.stringify([publicId, effort, fast ?? null, modelInput.text, attachmentsKey]);
    return this.pendingSendLatch.run(`${sessionId}\u0000${dedupKey}`, () =>
      this.admitTurn(sessionId, modelInput, publicId, attachmentsKey, dedupKey),
    );
  }

  private isWaitingResubmission(
    sessionId: string,
    waiting: RecoveryWait,
    text: string,
    attachmentsKey: string,
    fast: boolean | undefined,
  ): boolean {
    const managed = this.manager.getRuntime(sessionId);
    if (managed === undefined) return false;
    const ongoing = this.runtimes.get(managed)?.turns.get(waiting.turn);
    if (ongoing === undefined) return false;
    if (ongoing.model.fast !== fast) return false;
    if (text === ongoing.userText && attachmentsKey === waiting.attachmentsKey) return true;
    return attachmentsKey === '' && isPlainContinue(text);
  }

  private async admitTurn(
    sessionId: string,
    input: Parameters<Session['send']>[1] & { model: TurnRuntime['model'] },
    publicId: string,
    attachmentsKey: string,
    dedupKey?: string,
  ): Promise<{ turn: number }> {
    const models = (await this.host.gateway()).models;
    const gatewayModel = admitSessionModel(
      models,
      input.model.provider,
      input.model.model,
    );
    await this.manager.ensureSession(sessionId);
    this.assertOpen();
    const metadata = resolveModelMetadata(publicId, models);
    const effort = input.model.reasoningEffort;
    if (effort === undefined || !REASONING_EFFORTS.includes(effort)) {
      throw new Error(`reasoningEffort '${effort ?? ''}' is not a valid reasoning effort`);
    }
    if (!isReasoningEffortSupported(metadata, effort)) {
      throw new Error(
        `reasoningEffort '${effort}' is not supported by ${publicId}; expected one of ${metadata.reasoningEfforts?.join(', ') ?? ''}`,
      );
    }
    if (input.model.fast === true && gatewayModel.supportsFast !== true) {
      throw new Error(`Fast is not supported by ${publicId}`);
    }

    const files = input.attachments === undefined || input.attachments.length === 0
      ? []
      : await this.manager.withAdmission(sessionId, () =>
        this.ports.fileStore.importAttachments(sessionId, input.attachments!),
      );

    const turnInput: HarnessTurnInput = {
      text: input.text,
      model: input.model,
      publicId,
      ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
      attachmentsKey,
      ...(input.sender === undefined ? {} : { sender: input.sender }),
    };

    return this.manager.sendTurn(sessionId, turnInput, {
      ...(dedupKey === undefined ? {} : { dedupKey }),
      manageTurnEvents: true,
      buildStartDraft: (turnNumber) => ({
        type: 'turn.started',
        turn: turnNumber,
        id: turnId(turnNumber),
        text: input.text,
        model: input.model,
        ...(input.sender === undefined ? {} : { sender: input.sender }),
      }),
      onTurnAdmitted: async ({ runtime: managed, turn: turnNumber }) => {
        const sessionRuntime = this.ensureHarnessRuntime(managed);
        const turnRecord = managed.turns.get(turnNumber);
        const turnRuntime = this.createTurnRuntime(
          turnNumber,
          input.text,
          attachmentsKey,
          input.model,
          publicId,
          metadata.contextWindow,
          () => {
            if (turnRecord !== undefined) turnRecord.finished = true;
          },
          (status) => {
            this.clearRecoveryWait(sessionId, turnNumber);
            managed.markTurnDurableTerminal(turnNumber, status);
          },
        );
        sessionRuntime.turns.set(turnNumber, turnRuntime);
        this.abortSuggestion(sessionId);
        if (sessionRuntime.firstUserText === undefined) {
          sessionRuntime.firstUserText = input.text;
        }

        try {
          const previousModel = lastTurnModel(managed.read(), turnNumber);
          if (previousModel !== undefined && previousModel !== publicId) {
            await managed.append({
              type: 'system.info',
              turn: turnNumber,
              parent: turnId(turnNumber),
              source: 'user',
              code: 'model.changed',
              message: `The user switched the main model from ${previousModel} to ${publicId}.`,
            });
          }
          if (files.length > 0) {
            await managed.append({
              type: 'files.attached',
              turn: turnNumber,
              parent: turnId(turnNumber),
              source: 'user',
              files,
            });
          }
        } catch (error) {
          turnRuntime.finished = true;
          turnRuntime.durableTerminal = true;
          throw error;
        }
      },
    });
  }

  async steer(
    sessionId: string,
    input: { text: string; sender?: { botId: string } },
  ): Promise<{ turn: number } | undefined> {
    this.assertOpen();
    const managed = await this.manager.ensureSession(sessionId);
    const sessionRuntime = this.ensureHarnessRuntime(managed);
    const running = [...sessionRuntime.turns.entries()].find(([, turn]) => !turn.durableTerminal);
    if (running === undefined) return undefined;
    const [turnNumber, turn] = running;
    if (turn.durableTerminal || turn.finished || turn.closing) return undefined;
    turn.steers = (turn.steers ?? 0) + 1;
    const steered = await this.manager.steer(
      sessionId,
      { text: input.text, ...(input.sender === undefined ? {} : { sender: input.sender }) },
      {
        appendDraft: {
          type: 'turn.steered',
          turn: turnNumber,
          id: turnId(turnNumber),
          text: input.text,
          ...(input.sender === undefined ? {} : { sender: input.sender }),
        },
      },
    );
    return steered;
  }

  async interrupt(sessionId: string, turn: number): Promise<void> {
    this.assertOpen();
    await this.manager.interruptTurn(sessionId, turn, 'user');
  }

  async readMedia(sessionId: string, path: string): Promise<{ path: string; mime: string; dataUrl?: string }> {
    this.assertOpen();
    await this.manager.init();
    const events = this.manager.read(sessionId);
    if (findCreated(events) === undefined) throw new Error(`Unknown session: ${sessionId}`);
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
    await this.manager.init();

    const resident = this.manager.getRuntime(sessionId);
    const residentRuntime = resident === undefined ? undefined : this.runtimes.get(resident);
    const extraTaskRunIds = new Set<string>();
    if (residentRuntime !== undefined) {
      for (const turn of residentRuntime.turns.values()) {
        const lateWork = turn.parsePromises.size > 0
          || turn.actionPromises.size > 0
          || turn.resultQueue.length > 0;
        if (!turn.durableTerminal || lateWork) {
          throw new Error(`Cannot delete a session with a running turn: ${sessionId}`);
        }
        for (const taskRunId of turn.taskRunIds) extraTaskRunIds.add(taskRunId);
      }
    }

    this.abortSuggestion(sessionId);

    await this.manager.deleteSession(sessionId, {
      beforeDelete: async (id, events) => {
        if (events.length === 0) throw new Error(`Unknown session: ${id}`);
        const taskRunIds = new Set<string>(extraTaskRunIds);
        for (const event of events) {
          if (event.type === 'action.started' && event.taskRunId !== undefined) {
            taskRunIds.add(event.taskRunId);
          }
        }
        assertStorageSegment(id);
        await rm(join(this.host.stateRoot, 'sessions', id), { recursive: true, force: true });
        for (const taskRunId of taskRunIds) {
          assertStorageSegment(taskRunId);
          await rm(join(this.host.stateRoot, 'artifacts', taskRunId), { recursive: true, force: true });
        }
      },
    });
    this.recoveryWaits.delete(sessionId);
    this.runners.delete(sessionId);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed === '') throw new Error('Session title must not be empty');
    this.assertOpen();
    await this.manager.init();
    const managed = await this.manager.ensureSession(sessionId);
    await managed.append({
      type: 'session.titled',
      text: trimmed,
      manual: true,
    });
  }

  async regenerateTitle(sessionId: string): Promise<string> {
    this.assertOpen();
    await this.manager.init();
    const managed = await this.manager.ensureSession(sessionId);
    const sessionRuntime = this.ensureHarnessRuntime(managed);
    let latest: TurnRuntime | undefined;
    for (const turn of sessionRuntime.turns.values()) {
      if (latest === undefined || turn.turn > latest.turn) latest = turn;
    }
    if (latest === undefined) throw new Error('Session has no messages to title');
    return regenerateTitle(this, sessionRuntime, latest);
  }

  async updateMetadata(sessionId: string, patch: { archived?: boolean; pinned?: boolean }): Promise<void> {
    if (patch.archived === undefined && patch.pinned === undefined) {
      throw new Error('Session metadata patch must set archived or pinned');
    }
    this.assertOpen();
    await this.manager.init();
    const managed = await this.manager.ensureSession(sessionId);
    await managed.append({
      type: 'session.metadata',
      ...(patch.archived === undefined ? {} : { archived: patch.archived }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
    });
  }

  activeTurnCount(): number {
    return this.manager.activeTurnCount();
  }

  hasRunningTurns(): boolean {
    return this.manager.hasRunningTurns();
  }

  readLedger(sessionId: string): LedgerEvent[] {
    return this.manager.read(sessionId);
  }

  readLedgerPage(sessionId: string, afterSeq: number, limit: number): LedgerPage {
    return this.manager.readPage(sessionId, afterSeq, limit);
  }

  async inspectContext(request: ContextInspectRequest): Promise<ContextInspection> {
    this.assertOpen();
    return this.inspector.inspect(request);
  }

  async previewRoutes(): Promise<{ roles: AuxiliaryRoutePreview[] }> {
    this.assertOpen();
    return { roles: [...await this.host.previewAuxiliaryRoutes()] };
  }

  readLive(sessionId: string): LiveCall[] {
    return this.manager.readLive(sessionId);
  }

  async suggestPrompt(sessionId: string, requestId: string): Promise<{ suggestion?: string }> {
    this.assertOpen();
    this.suggestionRequests.get(sessionId)?.controller.abort();
    const controller = new AbortController();
    this.suggestionRequests.set(sessionId, { requestId, controller });
    try {
      const managed = await this.manager.ensureSession(sessionId);
      const sessionRuntime = this.ensureHarnessRuntime(managed);
      if (this.suggestionSuperseded(sessionId, controller)) return {};
      const turn = this.latestCompletedTurn(sessionRuntime);
      if (turn === undefined) return {};
      let suggestion: string;
      try {
        suggestion = await suggestNextInput(this, sessionRuntime, turn, controller.signal);
      } catch {
        return {};
      }
      if (this.suggestionSuperseded(sessionId, controller)) return {};
      if (this.latestCompletedTurn(sessionRuntime) !== turn) return {};
      return suggestion === '' ? {} : { suggestion };
    } finally {
      const current = this.suggestionRequests.get(sessionId);
      if (current?.controller === controller) this.suggestionRequests.delete(sessionId);
    }
  }

  async cancelPromptSuggest(sessionId: string, requestId: string): Promise<void> {
    const current = this.suggestionRequests.get(sessionId);
    if (current === undefined || current.requestId !== requestId) return;
    this.abortSuggestion(sessionId);
  }

  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void {
    return this.manager.subscribe(sessionId, listener);
  }

  subscribeLive(sessionId: string, listener: (live: LiveCall[]) => void): () => void {
    return this.manager.subscribeLive(sessionId, listener);
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    for (const request of this.suggestionRequests.values()) request.controller.abort();
    this.suggestionRequests.clear();
    await this.manager.init().catch(() => undefined);

    for (const summary of this.manager.listSessions()) {
      const managed = this.manager.getRuntime(summary.sessionId);
      if (managed === undefined) continue;
      const runtime = this.runtimes.get(managed);
      if (runtime === undefined) continue;
      for (const turn of [...runtime.turns.values()]) {
        if (!turn.finished) {
          await this.manager.interruptTurn(summary.sessionId, turn.turn, 'shutdown').catch(() => undefined);
        }
        // Abort post-final detached work (e.g., background title/status calls).
        if (!turn.abort.signal.aborted) {
          turn.abort.abort();
        }
      }
    }

    // Let tracked background pipeline finish while manager and persistence are still open.
    while (this.pipeline.size > 0) {
      await Promise.allSettled([...this.pipeline]);
    }

    await this.manager.close();

    this.runners.clear();
    this.recoveryWaits.clear();
  }

  // ── SessionCallHost & helpers ─────────────────────────────────────────────

  setRecoveryWait(sessionId: string, waiting: RecoveryWait): void {
    this.recoveryWaits.set(sessionId, waiting);
    const managed = this.manager.getRuntime(sessionId);
    if (managed !== undefined) {
      managed.recoveryWait.set(waiting.turn, `${waiting.model}:${waiting.effort}:${waiting.attachmentsKey}`);
    }
  }

  clearRecoveryWait(sessionId: string, turn: number): void {
    if (this.recoveryWaits.get(sessionId)?.turn === turn) {
      this.recoveryWaits.delete(sessionId);
    }
    const managed = this.manager.getRuntime(sessionId);
    managed?.recoveryWait.clear(turn);
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
      const parent = turn.currentStepId ?? turnId(turn.turn);
      await this.ledger.append(sessionId, {
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

  nextActionId(session: SessionRuntime): string {
    return `a${++session.actionSeq}`;
  }

  private nextSpanId(session: SessionRuntime, turn: TurnRuntime): string {
    return `s${turn.turn}.${++session.spanSeq}`;
  }

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
        fast?: boolean;
      };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
      onToolCall?: (call: ToolCall) => void;
      onWait?: (state: { reason: ModelWaitReason; retryAt?: string } | null) => void;
      tools?: readonly ToolSpec[];
      toolChoice?: ToolChoice;
      maxTokens?: number;
      step?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<InvokedCall> {
    const spanId = extra.spanId ?? this.nextSpanId(session, turn);
    const parent = extra.parent ?? (role === 'reason' ? stepId(turn.turn, turn.step) : turnId(turn.turn));
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

  track(promise: Promise<unknown>): void {
    this.pipeline.add(promise);
    const cleanup = (): void => {
      this.pipeline.delete(promise);
    };
    void promise.then(cleanup, cleanup);
  }

  trackTurnWork(sessionId: string, turn: number, promise: Promise<unknown>): void {
    this.track(promise);
    const record = this.manager.getRuntime(sessionId)?.turns.get(turn);
    if (record !== undefined) {
      void record.trackWork(promise).catch(() => undefined);
    }
  }

  private hasPendingResultQueue(sessionId: string): boolean {
    const managed = this.manager.getRuntime(sessionId);
    if (managed === undefined) return false;
    const runtime = this.runtimes.get(managed);
    if (runtime === undefined) return false;
    for (const turn of runtime.turns.values()) {
      if (turn.resultQueue.length > 0) return true;
    }
    return false;
  }

  now(): Date {
    return this.host.now ? this.host.now() : new Date();
  }

  private createTurnRuntime(
    turn: number,
    userText: string,
    attachmentsKey: string,
    model: TurnRuntime['model'],
    publicId: string,
    contextWindow: number | undefined,
    onClaimFinish: () => void,
    onDurableTerminal: (status: 'completed' | 'failed') => void,
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
      onClaimFinish,
      onDurableTerminal,
    };
  }

  private suggestionSuperseded(sessionId: string, controller: AbortController): boolean {
    return controller.signal.aborted || this.suggestionRequests.get(sessionId)?.controller !== controller;
  }

  private abortSuggestion(sessionId: string): void {
    const current = this.suggestionRequests.get(sessionId);
    if (current === undefined) return;
    this.suggestionRequests.delete(sessionId);
    current.controller.abort();
  }

  private latestCompletedTurn(session: SessionRuntime): TurnRuntime | undefined {
    let latest: TurnRuntime | undefined;
    for (const turn of session.turns.values()) {
      if (latest === undefined || turn.turn > latest.turn) latest = turn;
    }
    if (latest === undefined || !latest.durableTerminal || latest.status !== 'completed') return undefined;
    return latest;
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

  private assertOpen(): void {
    if (this.closed) throw new Error('session is closed');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function assertStorageSegment(value: string): void {
  if (value === '.' || value === '..' || value === '' || /[/\\\u0000]/u.test(value)) {
    throw new Error(`invalid storage segment: ${value}`);
  }
}

function lastTurnModel(events: readonly LedgerEvent[], turn: number): string | undefined {
  let started: Extract<LedgerEvent, { type: 'turn.started' }> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'turn.started' && event.turn !== turn) {
      started = event;
      break;
    }
  }
  if (started === undefined) return undefined;
  let model: string | undefined;
  for (const event of events) {
    if (event.turn === started.turn && event.type === 'span.finished' && event.kind === 'reasoning' && event.requestModel !== undefined) {
      model = event.requestModel;
    }
  }
  return model ?? `${started.model.provider}/${started.model.model}`;
}

function attachmentKey(attachments: readonly AttachmentInput[] | undefined): string {
  if (attachments === undefined || attachments.length === 0) return '';
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

function isPlainContinue(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '继续' || trimmed.toLowerCase() === 'continue';
}
