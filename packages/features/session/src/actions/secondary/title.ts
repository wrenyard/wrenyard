/**
 * The session title: the first title taken from the opening user message and
 * the later refresh from the terminal reply.
 */

import { escapeBody, tag, twoPartView } from '../../render.ts';
import type { BuiltView, SessionCallHost } from '../../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../../runtime.ts';

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

/** The engine surface one title call needs. */
export type TitleHost = Pick<SessionCallHost, 'ledger' | 'invoke' | 'track' | 'now'>;

/** Start the initial title call for a turn's opening message. */
export function startInitialTitle(host: TitleHost, session: SessionRuntime, turn: TurnRuntime): void {
  const version = ++session.titleVersion;
  const userText = session.firstUserText ?? turn.userText;
  const promise = (async () => {
    const view = buildTitle({ userText });
    const outcome = await host.invoke(session, turn, 'title', view);
    if (!outcome.ok) return;
    await applyTitle(host, session, version, outcome.callId, outcome.text);
  })();
  host.track(promise);
}

/** Refresh the title once, when a turn finishes with its terminal reply. */
export async function maybeUpdateTitle(
  host: TitleHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  finalReply: string | undefined,
): Promise<void> {
  if (session.titleUpdatedWithReply) return;
  session.titleUpdatedWithReply = true;
  const version = ++session.titleVersion;
  const userText = session.firstUserText ?? turn.userText;
  try {
    const view = buildTitle({
      userText,
      ...(finalReply === undefined ? {} : { finalReply }),
    });
    const outcome = await host.invoke(session, turn, 'title', view);
    if (!outcome.ok) return;
    await applyTitle(host, session, version, outcome.callId, outcome.text);
  } catch {
    // Title updates are best-effort; keep the existing title.
  }
}

/** Later title generations always win, so an older slow call cannot overwrite one. */
export async function applyTitle(
  host: TitleHost,
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
  await host.ledger.append(session.sessionId, {
    type: 'title',
    text: title,
    callId,
  });
}
