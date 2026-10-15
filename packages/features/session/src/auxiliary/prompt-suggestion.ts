/**
 * The next-input suggestion: after a turn finishes, one bounded auxiliary call
 * proposes a short message the user is likely to type next. The view reads only
 * the current session's own ledger — the latest user inputs and the visible
 * assistant replies, as plain text — never tool calls, recalled memories,
 * workspace files, attachments, images or hidden reasoning from any other
 * session.
 *
 * The call is best-effort and carries no tools. It is never written to the
 * session or a draft: the returned text is a renderer-facing hint only, and the
 * caller decides whether to keep it. Every failure — a model error, the short
 * total deadline, an abort — is silent and yields no suggestion.
 */

import { escapeBody, tag, twoPartView } from '../context/render.ts';
import { turnId, type LedgerEvent } from '../ledger/store.ts';
import type { BuiltView, SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../turn/runtime.ts';

const SUGGESTION_SYSTEM = `<wy-system>
You suggest what the user is most likely to type next in a coding conversation. Read the recent exchange and output ONE short, concrete next message the user might send, in the language of the user's latest message. It must be a plain sentence the user could send as-is: no quotes, no bullets, no explanation, no code fences, no markdown and no emoji. Keep it to at most 20 Chinese characters or 12 words. When there is no useful follow-up, output nothing at all.
</wy-system>`;

/** At most this many transcript entries reach the view. */
const MAX_ENTRIES = 6;
/** Combined character budget of the transcript entries. */
const MAX_TOTAL_CHARS = 6000;

/** One plain-text transcript turn: a user input or a visible assistant reply. */
export interface PromptSuggestionEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface PromptSuggestionViewInput {
  entries: readonly PromptSuggestionEntry[];
}

/** One system message plus one user message: the bounded recent transcript. */
function buildSuggestion(input: PromptSuggestionViewInput): BuiltView {
  const body = input.entries
    .map((entry) => tag(entry.role, [], escapeBody(entry.text)))
    .join('\n');
  return twoPartView(SUGGESTION_SYSTEM, tag('wy-suggestion', [], body), 'wy-suggestion');
}

/** The engine surface one suggestion needs. */
export type PromptSuggestionHost = Pick<SessionCallHost, 'ledger' | 'invoke'>;

/**
 * The most recent plain-text transcript of one session, oldest first: user
 * inputs (`turn.started`) and visible assistant replies (`reply.sent`) only.
 * At most {@link MAX_ENTRIES} entries survive, and the oldest are dropped until
 * the combined length fits {@link MAX_TOTAL_CHARS}. A single message that alone
 * exceeds the budget is truncated to its last {@link MAX_TOTAL_CHARS}
 * characters rather than dropped, so one long reply never discards all context.
 */
export function recentTranscript(events: readonly LedgerEvent[]): PromptSuggestionEntry[] {
  const entries: PromptSuggestionEntry[] = [];
  for (const event of events) {
    if (event.type === 'turn.started') entries.push({ role: 'user', text: event.text });
    else if (event.type === 'reply.sent') entries.push({ role: 'assistant', text: event.text });
  }
  const recent = entries.slice(-MAX_ENTRIES);
  let total = recent.reduce((sum, entry) => sum + entry.text.length, 0);
  while (recent.length > 1 && total > MAX_TOTAL_CHARS) {
    total -= recent.shift()!.text.length;
  }
  // The loop stops with one entry when that entry alone is over budget; keep its
  // most recent characters so the single short output still has a transcript.
  if (total > MAX_TOTAL_CHARS) {
    const only = recent[0]!;
    recent[0] = { role: only.role, text: only.text.slice(-MAX_TOTAL_CHARS) };
  }
  return recent;
}

/** The single trimmed first line of a suggestion; `''` when there is none. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.trim();
}

/**
 * Generate one next-input suggestion for a session's latest turn. `signal`
 * aborts the upstream request for real when the caller cancels. Never rejects:
 * a failed, timed-out or aborted call returns no suggestion.
 */
export async function suggestNextInput(
  host: PromptSuggestionHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  signal: AbortSignal,
): Promise<string> {
  try {
    const entries = recentTranscript(host.ledger.read(session.sessionId));
    if (entries.length === 0) return '';
    const outcome = await host.invoke(session, turn, 'suggestion', buildSuggestion({ entries }), {
      parent: turnId(turn.turn),
      signal,
    });
    if (!outcome.ok) return '';
    return firstLine(outcome.text);
  } catch {
    return '';
  }
}
