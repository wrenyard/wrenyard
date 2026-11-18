/**
 * The next-input suggestion: after a turn finishes, one bounded auxiliary call
 * proposes a short message the user is likely to type next.
 */

import { escapeBody, tag, twoPartView } from '../context/render.ts';
import { turnId, type LedgerEvent } from '../events.ts';
import type { BuiltView, SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../drivers/runtime.ts';

const SUGGESTION_SYSTEM = `<wy-system>
You suggest what the user is most likely to type next in a coding conversation. Read the recent exchange and output ONE short, concrete next message the user might send, in the language of the user's latest message. It must be a plain sentence the user could send as-is: no quotes, no bullets, no explanation, no code fences, no markdown and no emoji. Keep it to at most 20 Chinese characters or 12 words. When there is no useful follow-up, output nothing at all.
</wy-system>`;

const MAX_ENTRIES = 6;
const MAX_TOTAL_CHARS = 6000;

export interface PromptSuggestionEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface PromptSuggestionViewInput {
  entries: readonly PromptSuggestionEntry[];
}

function buildSuggestion(input: PromptSuggestionViewInput): BuiltView {
  const body = input.entries
    .map((entry) => tag(entry.role, [], escapeBody(entry.text)))
    .join('\n');
  return twoPartView(SUGGESTION_SYSTEM, tag('wy-suggestion', [], body), 'wy-suggestion');
}

export type PromptSuggestionHost = Pick<SessionCallHost, 'ledger' | 'invoke'>;

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
  if (total > MAX_TOTAL_CHARS) {
    const only = recent[0]!;
    recent[0] = { role: only.role, text: only.text.slice(-MAX_TOTAL_CHARS) };
  }
  return recent;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.trim();
}

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
