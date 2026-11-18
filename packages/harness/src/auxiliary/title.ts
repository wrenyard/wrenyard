/**
 * The session title: generated automatically once, from the opening user
 * message, and again only when the user asks for it.
 */

import { escapeBody, tag, twoPartView } from '../context/render.ts';
import { turnId } from '../events.ts';
import type { BuiltView, SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../drivers/runtime.ts';

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

export type TitleHost = Pick<SessionCallHost, 'ledger' | 'invoke' | 'track' | 'now'>;

function hasManualTitle(host: TitleHost, session: SessionRuntime): boolean {
  for (const event of host.ledger.read(session.sessionId)) {
    if (event.type === 'session.titled' && event.manual === true) return true;
  }
  return false;
}

export function startInitialTitle(host: TitleHost, session: SessionRuntime, turn: TurnRuntime): void {
  if (hasManualTitle(host, session)) return;
  const version = ++session.titleVersion;
  const userText = session.firstUserText ?? turn.userText;
  host.track(runTitle(host, session, turn, version, buildTitle({ userText })));
}

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

function latestReplyText(events: ReturnType<TitleHost['ledger']['read']>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'reply.sent') return event.text;
  }
  return undefined;
}

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

export function applyTitle(session: SessionRuntime, version: number, text: string): string | undefined {
  const title = text.trim().split('\n')[0]!.trim();
  if (title === '') return undefined;
  if (version < session.lastTitleVersion) return undefined;
  session.lastTitleVersion = version;
  session.title = title;
  return title;
}
