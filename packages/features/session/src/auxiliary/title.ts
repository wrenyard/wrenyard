/**
 * The session title: generated automatically once, from the opening user
 * message, and again only when the user asks for it.
 */

import { escapeBody, tag, twoPartView } from '../context/render.ts';
import { turnId } from '../ledger/store.ts';
import type { BuiltView, SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../turn/runtime.ts';

const TITLE_SYSTEM = `<wy-system>
You write a title for a conversation. Output one line with a short title in the language of the user's message: at most 20 characters for Chinese or Japanese, at most 8 words otherwise. Do not use quotes, title marks or ending punctuation. Do not explain.
</wy-system>`;

export interface TitleViewInput {
  userText: string;
  finalReply?: string;
}

function buildTitle(input: TitleViewInput): BuiltView {
  const body = [
    tag('user', [], escapeBody(input.userText)),
    ...(input.finalReply === undefined ? [] : [tag('final-reply', [], escapeBody(input.finalReply))]),
  ].join('\n');
  return twoPartView(TITLE_SYSTEM, tag('wy-title', [], body), 'wy-title');
}

/** The engine surface one title task needs. */
export type TitleHost = Pick<SessionCallHost, 'ledger' | 'invoke' | 'track' | 'now'>;

/**
 * Whether the session carries an explicit manual title. The marker lives on the
 * `session.titled` event, so the ledger is the source of truth: once a manual
 * rename is recorded, automatic title generation stops for good.
 */
function hasManualTitle(host: TitleHost, session: SessionRuntime): boolean {
  for (const event of host.ledger.read(session.sessionId)) {
    if (event.type === 'session.titled' && event.manual === true) return true;
  }
  return false;
}

/** Start the initial title task for a turn's opening message. */
export function startInitialTitle(host: TitleHost, session: SessionRuntime, turn: TurnRuntime): void {
  // A manually renamed session never receives an automatic title.
  if (hasManualTitle(host, session)) return;
  const version = ++session.titleVersion;
  const userText = session.firstUserText ?? turn.userText;
  host.track(runTitle(host, session, turn, version, buildTitle({ userText })));
}

/**
 * Generate a new title on the user's request from the first user message and
 * the latest reply, and record it as a manual title. Rejects when the model
 * call fails or returns nothing, so the caller can show why.
 */
export async function regenerateTitle(host: TitleHost, session: SessionRuntime, turn: TurnRuntime): Promise<string> {
  const finalReply = latestReplyText(host.ledger.read(session.sessionId));
  const userText = session.firstUserText ?? turn.userText;
  const outcome = await host.invoke(session, turn, 'title', buildTitle({
    userText,
    ...(finalReply === undefined ? {} : { finalReply }),
  }), { parent: turnId(turn.turn) });
  if (!outcome.ok) throw new Error(outcome.error ?? 'Title generation failed');
  const applied = applyTitle(session, ++session.titleVersion, outcome.text);
  if (applied === undefined) throw new Error('Title generation returned no title');
  await host.ledger.append(session.sessionId, {
    type: 'session.titled',
    turn: turn.turn,
    parent: outcome.spanId,
    text: applied,
    manual: true,
  });
  return applied;
}

/** The text of the latest reply on the timeline, if any. */
function latestReplyText(events: ReturnType<TitleHost['ledger']['read']>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'reply.sent') return event.text;
  }
  return undefined;
}

/**
 * One title task: a system auxiliary task owned by the turn. An applied title
 * is recorded as `session.titled`, parented by the title span. Title updates
 * are best-effort; a failure keeps the existing title.
 */
async function runTitle(
  host: TitleHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  version: number,
  view: BuiltView,
): Promise<void> {
  try {
    const outcome = await host.invoke(session, turn, 'title', view, { parent: turnId(turn.turn) });
    if (!outcome.ok) return;
    // The user renamed the session while this call was in flight.
    if (hasManualTitle(host, session)) return;
    const applied = applyTitle(session, version, outcome.text);
    if (applied === undefined) return;
    await host.ledger.append(session.sessionId, {
      type: 'session.titled',
      turn: turn.turn,
      parent: outcome.spanId,
      text: applied,
    });
  } catch {
    // Keep the existing title.
  }
}

/**
 * Apply a generated title. Later title generations always win, so an older
 * slow call cannot overwrite one; returns the applied title, or `undefined`
 * when this generation lost or produced nothing. A recorded manual title is
 * the caller's guard (`hasManualTitle`), so this stays a pure version check.
 */
export function applyTitle(session: SessionRuntime, version: number, text: string): string | undefined {
  const title = text.trim().split('\n')[0]!.trim();
  if (title === '') return undefined;
  if (version < session.lastTitleVersion) return undefined;
  session.lastTitleVersion = version;
  session.title = title;
  return title;
}
