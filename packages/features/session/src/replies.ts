/**
 * session replies: the communication calls of a turn (spaced progress replies
 * and the final reply) and the session title derived from them.
 */

import type { LedgerEvent, TurnStatus } from './ledger.ts';
import type { CallRole } from './calls.ts';
import type { BuiltView, ReplyViewInput } from './views.ts';
import type { EnginePorts } from './ports.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';

/** Output-token allowance for the single communication reply call. */
const REPLY_MAX_TOKENS = 800;
/** Minimum spacing between two actually-appended intermediate replies. */
const INTERMEDIATE_REPLY_MIN_INTERVAL_MS = 20_000;

/** What the reply writer needs from the engine that owns the turn. */
export interface ReplyHost {
  now(): Date;
  track(promise: Promise<unknown>): void;
  invoke(
    session: SessionRuntime,
    turn: TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra?: { maxTokens?: number; cycle?: number },
  ): Promise<{ ok: boolean; callId: string; text: string; error?: string }>;
  appendError(sessionId: string, stage: string, message: string, turn: TurnRuntime, cycle?: number): Promise<void>;
}

/** Writes a turn's progress replies, its final reply and the session title. */
export class ReplyWriter {
  constructor(
    private readonly ports: Pick<EnginePorts, 'ledger' | 'views'>,
    private readonly engine: ReplyHost,
  ) {}

  scheduleReply(session: SessionRuntime, turn: TurnRuntime): void {
    if (turn.finished || turn.abort.signal.aborted) return;
    // Several dispatches in one cycle share one progress message; a second
    // message within the cycle could only restate the first.
    if (turn.lastReplyCycle === turn.cycle) return;
    const now = this.engine.now().getTime();
    if (turn.replyInFlight) {
      turn.replyPending = true;
      return;
    }
    const since = turn.lastReplyAt === undefined ? Number.POSITIVE_INFINITY : now - turn.lastReplyAt;
    if (since >= INTERMEDIATE_REPLY_MIN_INTERVAL_MS) {
      this.startIntermediateReply(session, turn);
      return;
    }
    turn.replyPending = true;
    if (turn.replyTimer === undefined) {
      turn.replyTimer = setTimeout(() => {
        turn.replyTimer = undefined;
        turn.replyPending = false;
        this.startIntermediateReply(session, turn);
      }, INTERMEDIATE_REPLY_MIN_INTERVAL_MS - since);
    }
  }

  private startIntermediateReply(session: SessionRuntime, turn: TurnRuntime): void {
    if (turn.finished || turn.abort.signal.aborted) return;
    turn.replyInFlight = true;
    turn.lastReplyCycle = turn.cycle;
    const promise = this.emitIntermediateReply(session, turn)
      .catch(() => undefined)
      .finally(() => {
        turn.replyInFlight = false;
        if (turn.replyPending && !turn.finished && !turn.abort.signal.aborted) {
          // Re-enter through the scheduler so a pending trigger after an
          // in-flight reply still respects the minimum spacing.
          turn.replyPending = false;
          this.scheduleReply(session, turn);
        }
      });
    turn.replyPromise = promise;
    this.engine.track(promise);
  }

  private async emitIntermediateReply(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    if (turn.finished || turn.abort.signal.aborted) return;
    // Snapshot the originating cycle before any await: the turn's `cycle` field
    // advances as soon as the next cycle starts, but this reply call, its
    // reply event and any call error belong to the cycle that triggered it.
    const replyCycle = turn.cycle;
    // An intermediate reply always reports a running turn: current actions may
    // all be finished while the reason call is still streaming. The newest
    // current-turn action failure rides the existing `error` field so the
    // authoritative latest failure outranks stale reason text and prior replies.
    const error = this.latestFailedActionResultForCycle(turn, this.ports.ledger.read(session.sessionId), replyCycle);
    const view = this.ports.views.reply(this.buildReplyInput(session, turn, {
      status: 'running',
      ...(error === undefined ? {} : { error }),
    }));
    const outcome = await this.engine.invoke(session, turn, 'reply', view, { maxTokens: REPLY_MAX_TOKENS, cycle: replyCycle });
    turn.lastReplyAt = this.engine.now().getTime();
    if (turn.finished || turn.abort.signal.aborted) return;
    if (!outcome.ok) {
      await this.engine.appendError(session.sessionId, 'reply', outcome.error ?? 'reply call failed', turn, replyCycle);
      if (turn.finished || turn.abort.signal.aborted) return;
    }
    // An empty progress reply means nothing new since the last message: skip it.
    if (outcome.ok && outcome.text.trim() === '') return;
    const text = outcome.ok ? outcome.text : fallbackReply('running', error);
    await this.ports.ledger.append(session.sessionId, {
      type: 'reply',
      turn: turn.turn,
      cycle: replyCycle,
      text,
      callId: outcome.callId,
    });
  }

  clearIntermediateReply(turn: TurnRuntime): void {
    if (turn.replyTimer !== undefined) {
      clearTimeout(turn.replyTimer);
      turn.replyTimer = undefined;
    }
    turn.replyPending = false;
  }

  async finishReply(
    session: SessionRuntime,
    turn: TurnRuntime,
    status: TurnStatus,
    error: string | undefined,
    question?: string,
  ): Promise<void> {
    if (turn.finished || turn.abort.signal.aborted) return;
    turn.phase = 'replying';
    this.clearIntermediateReply(turn);
    // Any in-flight intermediate reply finishes before the terminal reply starts.
    await turn.replyPromise.catch(() => undefined);
    if (turn.finished) return;

    let text: string | undefined;
    let callId: string | undefined;
    if (status !== 'interrupted') {
      const input = this.buildReplyInput(session, turn, {
        status,
        ...(error === undefined ? {} : { error }),
        ...(question === undefined ? {} : { question }),
        ...(turn.imageUnsupported ? { imageNotice: true } : {}),
      });
      const outcome = await this.engine.invoke(session, turn, 'reply', this.ports.views.reply(input), { maxTokens: REPLY_MAX_TOKENS });
      if (turn.finished || turn.abort.signal.aborted) return;
      if (outcome.ok) {
        callId = outcome.callId;
        if (outcome.text.trim() !== '') text = outcome.text;
      } else {
        await this.engine.appendError(session.sessionId, 'reply', outcome.error ?? 'reply call failed', turn);
      }
    }

    // The one communication call is recorded as written. An empty or failed
    // call uses the fixed fallback line; the turn's own status and error are
    // never changed by the reply.
    if (turn.finished) return;
    if (text === undefined || text === '') {
      text = fallbackReply(status, error);
    }
    if (turn.finished) return;
    // The image notice must reach the user even when the reply omitted it.
    if (turn.imageUnsupported && !text.includes('当前模型看不到图片')) {
      text = `${text}\n（当前模型看不到图片）`;
    }

    await this.ports.ledger.append(session.sessionId, {
      type: 'reply',
      turn: turn.turn,
      cycle: turn.cycle,
      text,
      ...(callId === undefined ? {} : { callId }),
    });

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

    await this.maybeUpdateTitle(session, turn, text);
  }

  private buildReplyInput(
    session: SessionRuntime,
    turn: TurnRuntime,
    options: {
      status?: string;
      error?: string;
      question?: string;
      imageNotice?: boolean;
    } = {},
  ): ReplyViewInput {
    const events = this.ports.ledger.read(session.sessionId);
    // While the main reason call is streaming, its partial text is the latest.
    const lastReasonText = turn.phase === 'reasoning' && turn.cycleText !== ''
      ? turn.cycleText
      : latestReasonText(events);
    return {
      userText: turn.userText,
      lastReasonText,
      actions: this.replyActions(turn, events),
      recentReplies: replyTexts(events).slice(-5),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.imageNotice === true ? { imageNotice: true } : {}),
      ...(options.question === undefined ? {} : { question: options.question }),
    };
  }

  /**
   * Factual action table for the reply view: current-turn running actions from
   * the runtime map, finished results still queued, and committed results. A
   * later fact for the same action id replaces the running one.
   */
  private replyActions(turn: TurnRuntime, events: readonly LedgerEvent[]): { name: string; status: string }[] {
    const byId = new Map<string, { name: string; status: string }>();
    for (const action of turn.actions.values()) {
      byId.set(action.actionId, { name: action.goal, status: 'running' });
    }
    for (const bundle of turn.resultQueue) {
      const finished = bundle.finished;
      if (finished.type === 'action.finished') {
        byId.set(finished.actionId, { name: finished.task ?? finished.kind, status: finished.status });
      }
    }
    for (const event of events) {
      if (event.type === 'action.finished' && event.turn === turn.turn) {
        byId.set(event.actionId, { name: event.task ?? event.kind, status: event.status });
      }
    }
    return [...byId.values()];
  }

  /**
   * Newest failed action result for the current turn and the given captured
   * cycle. A result still queued but not yet committed is newer than the
   * committed ones, so it wins within the same cycle; the scan is bounded to
   * that turn and cycle and never aggregates history, so an earlier cycle's
   * failure cannot ride a later cycle's intermediate reply error.
   */
  private latestFailedActionResultForCycle(
    turn: TurnRuntime,
    events: readonly LedgerEvent[],
    cycle: number,
  ): string | undefined {
    for (let index = turn.resultQueue.length - 1; index >= 0; index -= 1) {
      const finished = turn.resultQueue[index]!.finished;
      if (
        finished.type === 'action.finished'
        && finished.turn === turn.turn
        && finished.cycle === cycle
        && finished.status === 'failed'
      ) {
        return finished.result;
      }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (
        event.type === 'action.finished'
        && event.turn === turn.turn
        && event.cycle === cycle
        && event.status === 'failed'
      ) {
        return event.result;
      }
    }
    return undefined;
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

  private async maybeUpdateTitle(session: SessionRuntime, turn: TurnRuntime, finalReply: string): Promise<void> {
    if (session.titleUpdatedWithReply) return;
    session.titleUpdatedWithReply = true;
    const version = ++session.titleVersion;
    const userText = session.firstUserText ?? turn.userText;
    try {
      const view = this.ports.views.title({ userText, finalReply });
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

export function latestReasonText(events: readonly LedgerEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'reason.completed') return event.text;
  }
  return '';
}

/** Every visible reply text on the timeline, in timeline order. */
function replyTexts(events: readonly LedgerEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type === 'reply') texts.push(event.text);
  }
  return texts;
}

/** Fixed-format fallback used when the communication call itself fails. */
export function fallbackReply(status: TurnStatus | 'running', _error: string | undefined): string {
  switch (status) {
    case 'running':
      return '本轮仍在进行。';
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
