/**
 * session replies: the communication calls of a session. Exactly one call is
 * made after each main reasoning output that produced something (a progress
 * reply while the turn runs, or the terminal reply that also ends the turn),
 * plus one closing call when a turn ends without fresh output.
 */

import type { LedgerEvent, TurnStatus } from '../../ledger.ts';
import type { ToolCall, ToolSpec } from '../../driver.ts';
import { escapeReplyBody, tag } from '../../render.ts';
import { messageOf } from '../../errors.ts';
import type { BuiltView, SessionCallHost } from '../../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../../runtime.ts';
import { maybeUpdateTitle } from './title.ts';

/** Output-token allowance for the single communication reply call. */
const REPLY_MAX_TOKENS = 800;

/**
 * The one native tool the communication call declares. The model sends its
 * message through this tool; not calling it sends nothing.
 */
export const REPLY_TOOL: ToolSpec = {
  name: 'reply',
  description: 'Send one message to the user. The user sees only this text.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The message to the user, as Markdown text.' },
    },
    required: ['text'],
  },
};

/** The text of one reply call; a malformed payload fails the call. */
function replyCallText(call: ToolCall): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    throw new Error('Model returned an invalid reply call');
  }
  const text = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>).text : undefined;
  if (typeof text !== 'string') throw new Error('Model returned an invalid reply call');
  return text;
}

/**
 * The message text of a call output: the `text` of every call to the reply
 * tool, in call order, joined with a blank line. Calls of other tools are
 * ignored.
 */
export function replyTextOfCalls(calls: readonly ToolCall[]): string {
  return calls.filter((call) => call.name === REPLY_TOOL.name).map(replyCallText).join('\n\n');
}

/** What the reply writer needs from the engine that owns the turn. */
export type ReplyHost = Pick<SessionCallHost, 'ledger' | 'now' | 'track' | 'invoke' | 'appendError'>;

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
type TerminalStatus = 'completed' | 'failed';

/** Writes a session's communication replies. */
export class ReplyWriter {
  constructor(
    private readonly host: ReplyHost,
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
   * Enqueue the one closing communication of a turn whose reasoning failed
   * without fresh output. Always terminal.
   */
  close(session: SessionRuntime, turn: TurnRuntime, error: string | undefined): Promise<void> {
    return this.enqueue(session, {
      turn: turn.turn,
      cycle: turn.cycle,
      status: 'failed',
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
    this.host.track(run);
    return run;
  }

  private async process(session: SessionRuntime, request: ReplyRequest): Promise<void> {
    const turn = session.turns.get(request.turn);
    if (!turn) return;
    // An interrupted or already-finished turn never communicates.
    if (turn.finished || turn.abort.signal.aborted) return;

    const input: ReplyViewInput = {
      events: this.host.ledger.read(session.sessionId),
      turn: request.turn,
      cycle: request.cycle,
      status: request.status,
      now: this.host.now().toISOString(),
      deviceName: this.deviceName,
      ...(request.error === undefined ? {} : { error: request.error }),
      ...(turn.imageUnsupported ? { imageUnsupported: true } : {}),
    };
    const outcome = await this.host.invoke(session, turn, 'reply', buildReply(input), {
      maxTokens: REPLY_MAX_TOKENS,
      cycle: request.cycle,
      tools: [REPLY_TOOL],
    });
    // An interrupt that landed while the call was in flight suppresses it.
    if (turn.finished || turn.abort.signal.aborted) return;

    let text: string | undefined;
    let callId: string | undefined;
    let failure: string | undefined;
    if (outcome.ok) {
      try {
        const replyText = replyTextOfCalls(outcome.toolCalls ?? []);
        callId = outcome.callId;
        // A call that did not use the reply tool records the call only; a reply
        // is stored unchanged.
        if (replyText.trim() !== '') text = replyText;
      } catch (error) {
        failure = messageOf(error);
      }
    } else {
      failure = outcome.error ?? 'reply call failed';
    }
    // Running failures stay in the call record only; they add no error to the
    // main reasoning context. Terminal failures retain the fixed fallback.
    if (failure !== undefined && request.terminal) {
      await this.host.appendError(session.sessionId, 'reply', failure, turn, request.cycle);
      if (turn.finished || turn.abort.signal.aborted) return;
      text = fallbackReply(request.status as TerminalStatus, request.error);
    }

    if (text !== undefined) {
      await this.host.ledger.append(session.sessionId, {
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
    await this.host.ledger.append(session.sessionId, {
      type: 'turn.finished',
      turn: turn.turn,
      status,
      ...(error === undefined ? {} : { error }),
    });
    turn.durableTerminal = true;

    // A terminal call without a reply leaves no new reply; the title still uses
    // the latest real reply already on the timeline.
    const titleReply = replyText ?? latestReplyText(this.host.ledger.read(session.sessionId));
    await maybeUpdateTitle(this.host, session, turn, titleReply);
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
    case 'interrupted':
      return '本轮已中断。';
    default:
      return '本轮已结束。';
  }
}

// ─── Reply view ─────────────────────────────────────────────────────────────

const REPLY_SYSTEM = `<wy-system>
You are the replier in a Wrenyard work session. You communicate with the user.
The session also has a reasoning model. It works in the background: it reads material, calls tools, dispatches tasks and writes down its conclusions. The user cannot see the output of the reasoning model. The user sees only the messages you send with the reply tool.
Each time the reasoning model outputs a segment, the program calls you once. You decide whether to reply to the user this time.

Input:
- wy-conversation in wy-ctx is the whole conversation of this session so far. role="user" is a message from the user. role="assistant" is a message you sent earlier with reply.
- wy-info is the information the program gives you this time. infos holds the time, the device and the turn status. actions lists the actions that have not finished. wy-output is the latest output of the reasoning model. It does not contain its thinking. It contains the actions it started.

When to reply:
- When a reply is needed, you must call the reply tool once and put the entire message in its text argument. Never send a reply as ordinary output text.
- While the turn is running, when there is no new conclusion, progress, question or thing for the user to do, choose not to reply. If you choose not to reply, do not call the reply tool and do not output any text. Just end.
- Do not say again what you already said in wy-conversation, not even in other words.
- The user can see running actions in the interface. Do not report that something is "still running".
- When the turn ends (the turn status is not running), you must call the reply tool once with the closing message. State the conclusion and what the user needs to do. When the reasoning model asked a question, ask that question. You cannot choose silence for a closing message.

Language:
- Write text in the language of the latest user message in wy-conversation.
- The reasoning model writes in English. Translate its content. Keep names, commands, paths and numbers exactly as written.

Identity and tone:
- To the user, you and the reasoning model are the same coworker. Use "I" for what the reasoning model did.
- You are a professional, reliable coworker who sends messages to the user in a chat app. Be as short as possible while the user can still understand. The user does not like long text and asks when they need details.
- State the conclusion first, then what the user needs to do. Do not describe the process.
- When the reasoning model wrote a long answer, pick only the conclusion and the one or two most important reasons. Do not restate it point by point. Do not paste code, list a full comparison or add a recap.
- Say only what the reasoning model said. Do not add or guess. Copy numbers and names. Keep the meaning of conditions and uncertainty: do not change "may" into "will".
- Do not raise questions or proposals that the reasoning model did not raise.
- Do not mention internal names, paths or identifiers unless the user needs to open them.
- The states in infos and actions are facts from the program. They take priority over the plans of the reasoning model.

How to write: follow about 80% of the ASD-STE100 Simplified Technical English writing rules, applied to the language you write in.
- One sentence says one thing. Keep sentences short: usually no more than 20 words, or 30 characters in Chinese or Japanese.
- Use the active voice. Say who did what.
- Always use the same name for the same thing.
- When there is a condition, put it at the start of the sentence.
- Do not use semicolons or pleasantries.
- A progress message is usually one sentence, at most two. A closing message is usually no more than 6 sentences.

Layout: text is shown as Markdown. The user must be able to read it word by word without spending much time, and to skim a long message.
- Write a short message as one or two plain sentences, without lists.
- A long message may use ordered or unordered lists. One list item says one thing.
- Use inline code for the names, commands and paths that the user needs.
- Use only these three formats. Do not use headings, bold, tables, quotes or code blocks. Do not write an article with section titles.

Tools:
- reply(text): send text to the user as one message.

Output contract:
- A reply must be a native function call to reply, with your message in the text argument. Ordinary assistant content does not send a message and is discarded.
- Do not describe a tool call, print its JSON as text, or write the answer outside the function call.
- If you choose not to reply while the turn is running, return no content and no tool calls.
</wy-system>`;

export interface ReplyViewInput {
  events: readonly LedgerEvent[];
  turn: number;
  /** The reasoning cycle whose output triggered this call. */
  cycle: number;
  status: 'running' | 'completed' | 'failed';
  /** ISO time of this call. */
  now: string;
  deviceName: string;
  error?: string;
  imageUnsupported?: boolean;
}

/**
 * Render the communication request as one system and one user message. The
 * user message carries `<wy-ctx>`, the whole session conversation (every user
 * input and every visible reply, in timeline order), then `<wy-info>`: the
 * call's facts, the actions still running, and the worker output of the
 * triggering cycle. Earlier worker outputs, thinking, action results and call
 * records are never rendered.
 */
function buildReply(input: ReplyViewInput): BuiltView {
  const conversation: string[] = [];
  const running = new Map<string, string>();
  let worker: Extract<LedgerEvent, { type: 'reason.completed' }> | undefined;
  for (const event of input.events) {
    switch (event.type) {
      case 'turn.started':
        conversation.push(tag('message', [['role', 'user'], ['turn', event.turn]], escapeReplyBody(event.text)));
        break;
      case 'reply':
        conversation.push(tag('message', [['role', 'assistant'], ['turn', event.turn]], escapeReplyBody(event.text)));
        break;
      case 'reason.completed':
        if (event.turn === input.turn && event.cycle === input.cycle) worker = event;
        break;
      case 'action.started':
        running.set(event.actionId, event.kind);
        break;
      case 'action.titled':
        if (running.has(event.actionId)) running.set(event.actionId, event.title);
        break;
      case 'action.finished':
        running.delete(event.actionId);
        break;
      default:
        break;
    }
  }

  const infos = [
    `time: ${input.now}`,
    `device: ${input.deviceName}`,
    `turn status: ${input.status}`,
    ...(input.error === undefined ? [] : [`error: ${input.error}`]),
    ...(input.imageUnsupported === true ? ['The reasoning model cannot see the images the user sent.'] : []),
  ];
  const actions = [...running.values()].map((name) => `- ${name}`);

  const ctx = [
    '<wy-ctx>',
    tag('wy-conversation', [], conversation.length === 0 ? '(none)' : `\n${conversation.join('\n')}\n`),
    '</wy-ctx>',
  ].join('\n');
  const info = [
    '<wy-info>',
    tag('infos', [], escapeReplyBody(infos.join('\n'))),
    tag('actions', [], actions.length === 0 ? '(none)' : escapeReplyBody(actions.join('\n'))),
    tag('wy-output', [], escapeReplyBody(worker === undefined ? '(none)' : worker.workerOutput ?? worker.text)),
    '</wy-info>',
    ...(input.status === 'running' ? [] : [tag('wy-reply-instruction', [], '\nThis is the final reply of this turn. You must call the reply function now. Put the closing message in the text argument. Do not write ordinary assistant content. Do not end without a reply function call.\n')]),
  ].join('\n');
  const user = `${ctx}\n${info}`;
  return {
    messages: [
      { role: 'system', content: REPLY_SYSTEM },
      { role: 'user', content: user },
    ],
    layers: { 'wy-system': REPLY_SYSTEM.length, 'wy-ctx': ctx.length, 'wy-info': info.length },
    segments: { 'wy-system': REPLY_SYSTEM, 'wy-ctx': ctx, 'wy-info': info },
  };
}
