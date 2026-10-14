/**
 * The post-turn status judgement: after a completed turn that did not end on a
 * single standalone question, one forced `set_status` call decides whether the
 * reply needs the user to do something, with an optional short label. A
 * successful judgement is recorded as a `turn.attention` event with
 * `source: 'model'`, so the session list can show it.
 *
 * The call is fire-and-forget. It is started after the turn is durable, never
 * delays the turn, and swallows every failure: no `system.error` is written and
 * no reply is sent.
 */

import { turnId, type LedgerEvent } from '../ledger/store.ts';
import { escapeBody, tag, twoPartView } from '../context/render.ts';
import type { ToolCall, ToolSpec } from '../transport/index.ts';
import type { BuiltView, SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../turn/runtime.ts';

/** Output-token allowance for the one status judgement call. */
const STATUS_MAX_TOKENS = 200;

/**
 * The one native tool the status judgement declares. The model answers through
 * this tool; a payload without a boolean `needsUser` fails the judgement.
 */
const SET_STATUS_TOOL: ToolSpec = {
  name: 'set_status',
  description: 'Record whether the user must do something before this work can continue or be closed.',
  parameters: {
    type: 'object',
    properties: {
      needsUser: { type: 'boolean', description: 'True when the user must act before this work can continue or be closed.' },
      label: { type: 'string', description: 'When needsUser is true, a very short phrase saying what the user should do.' },
    },
    required: ['needsUser'],
    additionalProperties: false,
  },
};

const STATUS_SYSTEM = `<wy-system>
You decide whether the user must do something before this work can continue or be closed. Answer needsUser=true when the replies ask the user to answer a question, choose an option, approve a commit, push or other action, check or accept a result, or do something outside the app (for example stop a process or fix a credential). Answer needsUser=false when the replies only report progress or completion and need no response. When needsUser is true, give label: a very short phrase in the language of the user's message saying what the user should do (at most 10 Chinese characters or 4 English words), e.g. 等你确认提交 or Confirm commit. Call set_status exactly once.
</wy-system>`;

export interface StatusViewInput {
  /** This turn's opening user input. */
  userText: string;
  /** Every reply sent in this turn, in order. */
  replies: readonly string[];
}

/** One system message plus one user message: this turn's input and its replies. */
function buildStatus(input: StatusViewInput): BuiltView {
  const body = [
    tag('user', [], escapeBody(input.userText)),
    ...input.replies.map((text) => tag('reply', [], escapeBody(text))),
  ].join('\n');
  return twoPartView(STATUS_SYSTEM, tag('wy-status', [], body), 'wy-status');
}

/** The engine surface one status judgement needs. */
export type StatusHost = Pick<SessionCallHost, 'ledger' | 'invoke'>;

/**
 * Judge one finished turn and append a `turn.attention` event when it succeeds.
 * Only a `completed` turn that did not end on its single standalone question is
 * judged; `endedWithAsk` is that terminal flag, computed by the caller. Never
 * rejects, so a caller may start it without awaiting.
 */
export async function maybeClassifyStatus(
  host: StatusHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  endedWithAsk: boolean,
): Promise<void> {
  if (turn.status !== 'completed' || endedWithAsk) return;
  try {
    const view = buildStatus({
      userText: turn.userText,
      replies: turnReplies(host.ledger.read(session.sessionId), turn.turn),
    });
    const outcome = await host.invoke(session, turn, 'status', view, {
      parent: turnId(turn.turn),
      maxTokens: STATUS_MAX_TOKENS,
      tools: [SET_STATUS_TOOL],
      toolChoice: { name: SET_STATUS_TOOL.name },
    });
    if (!outcome.ok) return;
    const judged = parseStatus(outcome.toolCalls ?? []);
    if (judged === undefined) return;
    await host.ledger.append(session.sessionId, {
      type: 'turn.attention',
      turn: turn.turn,
      turnId: turnId(turn.turn),
      needsUser: judged.needsUser,
      ...(judged.label === undefined ? {} : { label: judged.label }),
      source: 'model',
    });
  } catch {
    // Silent by design: a failed judgement leaves the turn as a plain completion.
  }
}

/** This turn's reply texts, in order. */
function turnReplies(events: readonly LedgerEvent[], turn: number): string[] {
  const replies: string[] = [];
  for (const event of events) {
    if (event.type === 'reply.sent' && event.turn === turn) replies.push(event.text);
  }
  return replies;
}

/**
 * Read the strict `set_status` payload: exactly one call with a boolean
 * `needsUser` and an optional string `label`. The label is trimmed and dropped
 * when it is empty or the reply needs no user. Any other payload is a failure.
 */
function parseStatus(calls: readonly ToolCall[]): { needsUser: boolean; label?: string } | undefined {
  const selections = calls.filter((call) => call.name === SET_STATUS_TOOL.name);
  if (selections.length !== 1) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(selections[0]!.arguments);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const needsUser = (parsed as { needsUser?: unknown }).needsUser;
  if (typeof needsUser !== 'boolean') return undefined;
  const rawLabel = (parsed as { label?: unknown }).label;
  if (rawLabel !== undefined && typeof rawLabel !== 'string') return undefined;
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (!needsUser || label === '') return { needsUser };
  return { needsUser, label };
}
