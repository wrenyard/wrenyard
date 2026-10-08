/**
 * session replies: the communication calls of a session. Exactly one call is
 * made after each main reasoning output that produced something (a progress
 * reply while the turn runs, or the terminal reply that also ends the turn),
 * plus one closing call when a turn ends without fresh output. The session
 * title is derived from the same replies.
 */

import type { LedgerEvent, TurnStatus } from './ledger.ts';
import type { CallRole } from './calls.ts';
import type { BuiltView, ReplyViewInput } from './views.ts';
import type { EnginePorts } from './ports.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';

/** Output-token allowance for the single communication reply call. */
const REPLY_MAX_TOKENS = 800;

/** What the reply writer needs from the engine that owns the turn. */
export interface ReplyHost {
  track(promise: Promise<unknown>): void;
  now(): Date;
  invoke(
    session: SessionRuntime,
    turn: TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra?: { maxTokens?: number; cycle?: number },
  ): Promise<{ ok: boolean; callId: string; text: string; error?: string }>;
  appendError(sessionId: string, stage: string, message: string, turn: TurnRuntime, cycle?: number): Promise<void>;
}

/** One queued communication invocation. */
interface ReplyRequest {
  turn: number;
  cycle: number;
  status: ReplyViewInput['status'];
  /** True for the invocation that also finalizes the turn. */
  terminal: boolean;
  error?: string;
}

/** The statuses a terminal communication call carries. */
type TerminalStatus = 'completed' | 'failed' | 'exhausted';

/** Writes a session's communication replies and its title. */
export class ReplyWriter {
  constructor(
    private readonly ports: Pick<EnginePorts, 'ledger' | 'views'>,
    private readonly engine: ReplyHost,
    private readonly deviceName: string,
  ) {}

  /**
   * Enqueue the one communication invocation for a nonempty main reason output.
   * The invocation is serialized with every other reply of the session, and its
   * ledger view is built when it is dequeued.
   */
  request(
    session: SessionRuntime,
    turn: TurnRuntime,
    options: { cycle: number; status: 'running' | 'completed'; terminal: boolean },
  ): void {
    this.enqueue(session, {
      turn: turn.turn,
      cycle: options.cycle,
      status: options.status,
      terminal: options.terminal,
    });
  }

  /**
   * Enqueue the one closing communication of a turn that ends without fresh
   * output (reason failure or exhaustion). Always terminal.
   */
  close(
    session: SessionRuntime,
    turn: TurnRuntime,
    status: 'failed' | 'exhausted',
    error: string | undefined,
  ): Promise<void> {
    return this.enqueue(session, {
      turn: turn.turn,
      cycle: turn.cycle,
      status,
      terminal: true,
      ...(error === undefined ? {} : { error }),
    });
  }

  /** Append one request to the session's serialized reply chain. */
  private enqueue(session: SessionRuntime, request: ReplyRequest): Promise<void> {
    const run = session.replyQueue.then(
      () => this.process(session, request),
      () => this.process(session, request),
    );
    // Keep the chain alive after a failed reply so later replies still run.
    session.replyQueue = run.then(
      () => undefined,
      () => undefined,
    );
    this.engine.track(run);
    return run;
  }

  private async process(session: SessionRuntime, request: ReplyRequest): Promise<void> {
    const turn = session.turns.get(request.turn);
    if (!turn) return;
    // An interrupted or already-finished turn never communicates.
    if (turn.finished || turn.abort.signal.aborted) return;

    const input: ReplyViewInput = {
      events: this.ports.ledger.read(session.sessionId),
      turn: request.turn,
      cycle: request.cycle,
      status: request.status,
      now: this.engine.now().toISOString(),
      deviceName: this.deviceName,
      ...(request.error === undefined ? {} : { error: request.error }),
      ...(turn.imageUnsupported ? { imageUnsupported: true } : {}),
    };
    const outcome = await this.engine.invoke(session, turn, 'reply', this.ports.views.reply(input), {
      maxTokens: REPLY_MAX_TOKENS,
      cycle: request.cycle,
    });
    // An interrupt that landed while the call was in flight suppresses it.
    if (turn.finished || turn.abort.signal.aborted) return;

    let text: string | undefined;
    let callId: string | undefined;
    if (outcome.ok) {
      callId = outcome.callId;
      // A call that did not use the reply tool records the call only; a reply
      // is stored unchanged.
      if (outcome.text.trim() !== '') text = outcome.text;
    } else if (request.terminal) {
      // Running failures stay in the call record only; they add no error to
      // the main reasoning context. Terminal failures retain the fixed fallback.
      await this.engine.appendError(session.sessionId, 'reply', outcome.error ?? 'reply call failed', turn, request.cycle);
      if (turn.finished || turn.abort.signal.aborted) return;
      text = fallbackReply(request.status as TerminalStatus, request.error);
    }

    if (text !== undefined) {
      await this.ports.ledger.append(session.sessionId, {
        type: 'reply',
        turn: request.turn,
        cycle: request.cycle,
        text,
        ...(callId === undefined ? {} : { callId }),
      });
    }
    if (turn.finished) return;

    if (request.terminal) {
      await this.finishTurn(session, turn, request.status as TerminalStatus, request.error, text);
    }
  }

  /** Write the durable terminal rows and update the title. */
  private async finishTurn(
    session: SessionRuntime,
    turn: TurnRuntime,
    status: TerminalStatus,
    error: string | undefined,
    replyText: string | undefined,
  ): Promise<void> {
    if (turn.finished) return;
    turn.status = status;
    turn.phase = 'terminal';
    turn.finished = true;
    await this.ports.ledger.append(session.sessionId, {
      type: 'turn.finished',
      turn: turn.turn,
      status,
      ...(error === undefined ? {} : { error }),
    });
    turn.durableTerminal = true;

    // A terminal call without a reply leaves no new reply; the title still uses
    // the latest real reply already on the timeline.
    const titleReply = replyText ?? latestReplyText(this.ports.ledger.read(session.sessionId));
    await this.maybeUpdateTitle(session, turn, titleReply);
  }

  // ── title ───────────────────────────────────────────────────────────────

  startInitialTitle(session: SessionRuntime, turn: TurnRuntime): void {
    const version = ++session.titleVersion;
    const userText = session.firstUserText ?? turn.userText;
    const promise = (async () => {
      const view = this.ports.views.title({ userText });
      const outcome = await this.engine.invoke(session, turn, 'title', view);
      if (!outcome.ok) return;
      await this.applyTitle(session, version, outcome.callId, outcome.text);
    })();
    this.engine.track(promise);
  }

  private async maybeUpdateTitle(session: SessionRuntime, turn: TurnRuntime, finalReply: string | undefined): Promise<void> {
    if (session.titleUpdatedWithReply) return;
    session.titleUpdatedWithReply = true;
    const version = ++session.titleVersion;
    const userText = session.firstUserText ?? turn.userText;
    try {
      const view = this.ports.views.title({
        userText,
        ...(finalReply === undefined ? {} : { finalReply }),
      });
      const outcome = await this.engine.invoke(session, turn, 'title', view);
      if (!outcome.ok) return;
      await this.applyTitle(session, version, outcome.callId, outcome.text);
    } catch {
      // Title updates are best-effort; keep the existing title.
    }
  }

  /** Later title generations always win, so an older slow call cannot overwrite one. */
  private async applyTitle(
    session: SessionRuntime,
    version: number,
    callId: string,
    text: string,
  ): Promise<void> {
    const title = text.trim().split('\n')[0]!.trim();
    if (title === '') return;
    if (version < session.lastTitleVersion) return;
    session.lastTitleVersion = version;
    session.title = title;
    await this.ports.ledger.append(session.sessionId, {
      type: 'title',
      text: title,
      callId,
    });
  }
}

/** The visible text of the latest completed reasoning output, or the empty string. */
export function latestReasonText(events: readonly LedgerEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'reason.completed') return event.text;
  }
  return '';
}

/** The text of the latest visible reply on the timeline, if any. */
function latestReplyText(events: readonly LedgerEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'reply') return event.text;
  }
  return undefined;
}

/** Fixed-format fallback used when a terminal communication call itself fails. */
export function fallbackReply(status: TurnStatus, _error: string | undefined): string {
  switch (status) {
    case 'failed':
      return '本轮未完成。';
    case 'exhausted':
      return '已达到本轮的最大推理次数。';
    case 'interrupted':
      return '本轮已中断。';
    default:
      return '本轮已结束。';
  }
}
