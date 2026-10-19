/**
 * session context compaction: summarise the covered part of the timeline into
 * one handover note so the next reasoning request stays inside its model's
 * context window.
 *
 * Compaction never deletes or rewrites ledger events. It returns the summary
 * and the highest covered sequence; the caller appends one `context.compacted`
 * event, and every later request renders from that floor. One summarisation
 * call is attempted, with no retry: a failed or oversized call falls back to a
 * deterministic summary built from ledger facts and records the failure.
 */
import { boundedOutputReservation, type ModelMetadata } from '../model/metadata.ts';
import { COMPACTION_THRESHOLD_CAP, estimateInputTokens, estimateTokens } from '../model/request.ts';
import { CONTEXT_EVENT_TYPES, type LedgerEvent } from '../ledger/store.ts';
import { escapeBody, renderEventText, resumedOriginalTurns, tag } from './render.ts';
import { messageOf } from '../errors.ts';
import type { Message as ModelMessage } from '../transport/index.ts';

/** The summarisation call's output cap; never above this. */
export const COMPACTION_MAX_OUTPUT_TOKENS = 2000;

/** Share of the threshold kept verbatim as the most recent tail. */
const TAIL_SHARE = 0.25;
/** Share of the room left after the output reservation that triggers compaction, before the fixed cap. */
const THRESHOLD_SHARE = 0.5;

const COMPACTION_SYSTEM = `<wy-system>
You are the context compactor for one working session. Summarise the supplied conversation records into a compact handover note that lets the next request continue the work.

Write Markdown with exactly these level-2 sections, in this order, and keep every heading:
## work_so_far
What was done, including durable outcomes.
## worktree_state
Branches, worktrees, commits and files that changed.
## open_tasks
Work that is still running, blocked or waiting.
## decisions
Decisions made and their reasons.
## pending_followups
Promised follow-ups and open questions.
## standing_instructions
Role and standing instructions that arrived through wakes, not the config.
## role_cursors
Per-role cursors such as the last audited or reviewed commit.
## known_pitfalls
Pitfalls learned at run time.

Rules:
- Use only the supplied records. Never invent paths, ids, results or decisions.
- Keep concrete names, paths, ids, numbers and command results exact.
- Do not address the user and do not ask questions.
- Return the Markdown only, with no prose before or after it.
</wy-system>`;

/** The structured model call the caller supplies; one call, no retry. */
export type CompactionSummaryCall = (
  messages: readonly ModelMessage[],
  maxOutputTokens: number,
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;

export interface CompactionInput {
  /** The whole timeline; coverage and fallback facts are derived from it. */
  events: readonly LedgerEvent[];
  /** The session model's metadata, whose `contextWindow` bounds the request. */
  metadata: ModelMetadata;
  /** The one summarisation call, made on the session's own model. */
  summarize: CompactionSummaryCall;
  /** Output tokens the reason request reserves; defaults to the bounded model maximum. */
  outputReservation?: number;
  /** Input-token estimate of the request that triggered the compaction. */
  estimatedInputTokens?: number;
  /** The session's current title, used only by the deterministic fallback. */
  title?: string;
}

export interface CompactionResult {
  /** Highest ledger sequence covered by the summary; 0 when nothing was covered. */
  throughSeq: number;
  /** The handover note: model-written when `failure` is absent. */
  summary: string;
  /** The triggering request's input-token estimate, echoed back. */
  estimatedInputTokens?: number;
  /** The model's context window when the compaction ran. */
  contextWindow?: number;
  /** Why a deterministic fallback summary was used instead of the model's. */
  failure?: string;
}

/**
 * Render one compaction handover block, in the same shape as the other context
 * records built in `render.ts`.
 */
export function renderCompactionBlock(event: Extract<LedgerEvent, { type: 'context.compacted' }>): string {
  const body = event.failure === undefined
    ? escapeBody(event.summary)
    : [escapeBody(event.summary), escapeBody(`compaction failed: ${event.failure}`)].join('\n');
  return tag(
    'wy-compaction',
    [
      ['through-seq', event.throughSeq],
      ['context-window', event.contextWindow],
      ['estimated-input-tokens', event.estimatedInputTokens],
    ],
    body,
  );
}

/**
 * Compact one timeline. The tail is the newest context suffix whose rendered
 * size fits within 25% of the threshold and stays verbatim; everything before
 * it is covered by one summary. When the summary call fails or its own input
 * cannot fit the window, a deterministic summary is built from ledger facts and
 * the failure is recorded.
 */
export async function compactContext(input: CompactionInput): Promise<CompactionResult> {
  const contextWindow = input.metadata.contextWindow;
  const outputReservation = input.outputReservation ?? boundedOutputReservation(input.metadata.maxOutputTokens) ?? 0;
  const threshold = contextWindow === undefined
    ? 0
    : Math.min(Math.floor(THRESHOLD_SHARE * (contextWindow - outputReservation)), COMPACTION_THRESHOLD_CAP);
  const echoed = {
    ...(input.estimatedInputTokens === undefined ? {} : { estimatedInputTokens: input.estimatedInputTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };

  const contextEvents = input.events.filter((event) => CONTEXT_EVENT_TYPES.has(event.type));
  const resumedTurns = resumedOriginalTurns(input.events);
  const renderOne = (event: LedgerEvent): string => (event.type === 'context.compacted'
    ? renderCompactionBlock(event)
    : renderEventText(event, resumedTurns) ?? '');
  const tailBudget = Math.floor(TAIL_SHARE * threshold);
  let tailStart = contextEvents.length;
  let tailTokens = 0;
  for (let index = contextEvents.length - 1; index >= 0; index -= 1) {
    const size = estimateTokens(renderOne(contextEvents[index]!));
    if (tailTokens + size > tailBudget) break;
    tailTokens += size;
    tailStart = index;
  }

  const covered = contextEvents.slice(0, tailStart);
  if (covered.length === 0) return { throughSeq: 0, summary: '', ...echoed };
  const throughSeq = covered[covered.length - 1]!.seq;

  const source = covered
    .map(renderOne)
    .filter((text) => text !== '')
    .join('\n');
  const messages: ModelMessage[] = [
    { role: 'system', content: COMPACTION_SYSTEM },
    { role: 'user', content: `<wy-compaction>\n${escapeBody(source)}\n</wy-compaction>` },
  ];

  const summaryInputTokens = estimateInputTokens(messages);
  if (contextWindow !== undefined && summaryInputTokens + COMPACTION_MAX_OUTPUT_TOKENS > contextWindow) {
    const failure = `compaction summary input ${summaryInputTokens} + max output ${COMPACTION_MAX_OUTPUT_TOKENS} exceeds the context window ${contextWindow}`;
    return { throughSeq, summary: fallbackSummary(input.title, input.events, throughSeq), ...echoed, failure };
  }

  let failure: string | undefined;
  try {
    const outcome = await input.summarize(messages, COMPACTION_MAX_OUTPUT_TOKENS);
    if (!outcome.ok) failure = outcome.error;
    else if (outcome.text.trim() === '') failure = 'compaction summary call returned no text';
    else return { throughSeq, summary: outcome.text.trim(), ...echoed };
  } catch (error) {
    failure = messageOf(error);
  }
  return { throughSeq, summary: fallbackSummary(input.title, input.events, throughSeq), ...echoed, failure };
}

/** Collapse whitespace and cap one fallback line. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

/**
 * Deterministic handover note built from ledger facts only: the session title,
 * the covered replies, recorded worktree changes and the titles of actions that
 * never finished. Never calls a model and never depends on wall-clock state.
 */
function fallbackSummary(title: string | undefined, events: readonly LedgerEvent[], throughSeq: number): string {
  const facts = events.filter((event) => event.seq <= throughSeq);
  const replies: string[] = [];
  const titles = new Map<string, string>();
  const finished = new Set<string>();
  const started: Extract<LedgerEvent, { type: 'action.started' }>[] = [];
  const worktrees: string[] = [];

  for (const event of facts) {
    switch (event.type) {
      case 'reply.sent':
        replies.push(`- ${oneLine(event.text)}`);
        break;
      case 'action.titled':
        titles.set(event.id, event.title);
        break;
      case 'action.finished':
        finished.add(`${event.id}:${event.turn ?? 0}:${event.step ?? 0}`);
        break;
      case 'action.started':
        started.push(event);
        break;
      case 'workspace.changed':
        if (event.scope === 'document' && event.worktreeId === undefined) break;
        worktrees.push(`- ${oneLine([event.change, event.target, event.worktreeId === undefined ? '' : `(${event.worktreeId})`].filter((part) => part !== '').join(' '))}`);
        break;
      default:
        break;
    }
  }

  const open = started.flatMap((event) => {
    const key = `${event.id}:${event.turn ?? 0}:${event.step ?? 0}`;
    if (finished.has(key)) return [];
    return [`- ${oneLine(titles.get(event.id) ?? event.action.prompt)}`];
  });

  const section = (lines: readonly string[]): string => (lines.length === 0 ? '_(none recorded)_' : lines.join('\n'));
  const worked = [
    ...(title === undefined || title.trim() === '' ? [] : [`Session: ${oneLine(title)}`]),
    ...replies.slice(-12),
  ];
  return [
    '## work_so_far',
    section(worked),
    '## worktree_state',
    section(worktrees.slice(-12)),
    '## open_tasks',
    section(open.slice(-12)),
    '## decisions',
    '_(none recorded)_',
    '## pending_followups',
    '_(none recorded)_',
    '## standing_instructions',
    '_(none recorded)_',
    '## role_cursors',
    '_(none recorded)_',
    '## known_pitfalls',
    '_(none recorded)_',
  ].join('\n');
}

/** Render verbatim kernel facts (watches, routines, bot roster) as one context block. */
export function renderKernelFactsBlock(facts: string): string {
  return tag('wy-kernel-facts', [], escapeBody(facts));
}
