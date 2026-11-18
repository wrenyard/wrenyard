/**
 * Session context compaction: summarise the covered part of the timeline into
 * one handover note so the next reasoning request stays inside its model's
 * context window, and execute the step-level reduction + compaction policy.
 */
import { boundedOutputReservation, type ModelMetadata } from '@wrenyard/ai/metadata';
import {
  COMPACTION_THRESHOLD_CAP,
  compactionBudgetOf,
  estimateInputTokens,
  estimateTokens,
} from '@wrenyard/ai';
import type { GatewayModel } from '@wrenyard/ai-protocol';
import type { Message as ModelMessage } from '@wrenyard/ai/transport';
import { CONTEXT_EVENT_TYPES, type LedgerEvent } from '../events.ts';
import { messageOf } from '../errors.ts';
import type { BuiltView, SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../drivers/runtime.ts';
import { hotZoneStart, computeReduction } from './reduction.ts';
import { escapeBody, renderEventText, tag } from './render.ts';

/** The summarisation call's output cap; never above this. */
export const COMPACTION_MAX_OUTPUT_TOKENS = 6000;

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
- The input may hold an earlier handover note followed by newer records: fold them into one updated note keeping the same sections.
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
  /** When set, the verbatim tail is every context event at or after this sequence. */
  tailFromSeq?: number;
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

/** Render one compaction handover block, matching `render.ts`. */
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
 * Compact one timeline. Never deletes or rewrites ledger events.
 */
export async function compactContext(input: CompactionInput): Promise<CompactionResult> {
  const contextWindow = input.metadata.contextWindow;
  const outputReservation = input.outputReservation ?? boundedOutputReservation(input.metadata.maxOutputTokens) ?? 0;
  const threshold = contextWindow === undefined
    ? 0
    : Math.min(
      Math.floor(THRESHOLD_SHARE * (contextWindow - outputReservation)),
      COMPACTION_THRESHOLD_CAP,
      input.metadata.maxInputTokens ?? Number.MAX_SAFE_INTEGER,
    );
  const maxOutputTokens = contextWindow === undefined
    ? COMPACTION_MAX_OUTPUT_TOKENS
    : Math.min(COMPACTION_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4));
  const echoed = {
    ...(input.estimatedInputTokens === undefined ? {} : { estimatedInputTokens: input.estimatedInputTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };

  const contextEvents = input.events.filter((event) => CONTEXT_EVENT_TYPES.has(event.type));
  const renderOne = (event: LedgerEvent): string => (event.type === 'context.compacted'
    ? renderCompactionBlock(event)
    : renderEventText(event) ?? '');
  const tailBudget = Math.floor(TAIL_SHARE * threshold);
  const tailFromSeq = input.tailFromSeq;
  const found = tailFromSeq === undefined
    ? hotZoneStart(contextEvents, (event) => estimateTokens(renderOne(event)), tailBudget)
    : contextEvents.findIndex((event) => event.seq >= tailFromSeq);
  const tailStart = found === -1 ? contextEvents.length : found;

  const covered = contextEvents.slice(0, tailStart);
  if (covered.length === 0) return { throughSeq: 0, summary: '', ...echoed };
  const throughSeq = covered[covered.length - 1]!.seq;

  const previous = previousCompaction(input.events);
  const records = covered
    .filter((event) => event.seq > previous.floor
      && event.type !== 'reasoning.thinking'
      && event.type !== 'context.compacted')
    .map((event) => renderEventText(event, { reduced: true }) ?? '')
    .filter((text) => text !== '')
    .join('\n');
  const source = [
    ...(previous.summary === undefined
      ? []
      : [tag('wy-handover-note', [['through-seq', previous.floor]], escapeBody(previous.summary))]),
    records,
  ].filter((part) => part !== '').join('\n');
  const messages: ModelMessage[] = [
    { role: 'system', content: COMPACTION_SYSTEM },
    { role: 'user', content: `<wy-compaction>\n${source}\n</wy-compaction>` },
  ];

  const summaryInputTokens = estimateInputTokens(messages);
  if (contextWindow !== undefined && summaryInputTokens + maxOutputTokens > contextWindow) {
    const failure = `compaction summary input ${summaryInputTokens} + max output ${maxOutputTokens} exceeds the context window ${contextWindow}`;
    return { throughSeq, summary: fallbackSummary(input.title, input.events, throughSeq), ...echoed, failure };
  }

  let failure: string | undefined;
  try {
    const outcome = await input.summarize(messages, maxOutputTokens);
    if (!outcome.ok) failure = outcome.error;
    else if (outcome.text.trim() === '') failure = 'compaction summary call returned no text';
    else return { throughSeq, summary: outcome.text.trim(), ...echoed };
  } catch (error) {
    failure = messageOf(error);
  }
  return { throughSeq, summary: fallbackSummary(input.title, input.events, throughSeq), ...echoed, failure };
}

function previousCompaction(events: readonly LedgerEvent[]): { floor: number; summary?: string } {
  let floor = 0;
  let summary: string | undefined;
  for (const event of events) {
    if (event.type !== 'context.compacted' || event.throughSeq < floor) continue;
    floor = event.throughSeq;
    summary = event.summary;
  }
  return { floor, ...(summary === undefined ? {} : { summary }) };
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

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

/** Step-level context-budget decision and execution over a session call host. */
export class Compaction {
  constructor(private readonly engine: SessionCallHost) {}

  async prepare(input: {
    session: SessionRuntime;
    turn: TurnRuntime;
    step: number;
    stepKey: string;
    events: LedgerEvent[];
    models: readonly GatewayModel[];
    metadata: ModelMetadata;
    maxTokens: number | undefined;
    view: BuiltView;
    kernelFacts?: () => string | undefined;
    buildView: (events: LedgerEvent[]) => BuiltView;
  }): Promise<{ ok: true; view: BuiltView } | { ok: false; error: string }> {
    const { session, turn, step, stepKey, events, models, metadata, maxTokens, kernelFacts, buildView } = input;
    let view = input.view;

    const budget = compactionBudgetOf(turn.publicId, view.messages, models, maxTokens);
    if (!turn.finished && !turn.abort.signal.aborted
      && budget.threshold !== undefined && budget.estimatedInputTokens > budget.threshold) {
      let source = events;
      let compactEstimate = budget.estimatedInputTokens;
      let overThreshold = true;
      const reduction = computeReduction(source, budget.threshold);
      if (reduction !== undefined) {
        await this.engine.ledger.append(session.sessionId, {
          type: 'context.reduced',
          turn: turn.turn,
          step,
          throughSeq: reduction.throughSeq,
          ...(reduction.releasedTokens === undefined ? {} : { releasedTokens: reduction.releasedTokens }),
        });
        source = this.engine.ledger.read(session.sessionId);
        view = buildView(source);
        const reduced = compactionBudgetOf(turn.publicId, view.messages, models, maxTokens);
        compactEstimate = reduced.estimatedInputTokens;
        overThreshold = reduced.threshold === undefined || reduced.estimatedInputTokens > reduced.threshold;
        if (!overThreshold) {
          const facts = kernelFacts?.();
          if (facts !== undefined && facts.trim() !== '') {
            view.messages.splice(view.messages.length - 1, 0, { role: 'user', content: renderKernelFactsBlock(facts) });
          }
        }
      }
      if (overThreshold) {
        const compact = (
          from: readonly LedgerEvent[],
          estimated: number,
          tailFromSeq?: number,
        ): Promise<CompactionResult> => compactContext({
          events: from,
          metadata,
          ...(maxTokens === undefined ? {} : { outputReservation: maxTokens }),
          estimatedInputTokens: estimated,
          title: session.title,
          ...(tailFromSeq === undefined ? {} : { tailFromSeq }),
          summarize: async (messages, maxOutputTokens) => {
            const outcome = await this.engine.invoke(session, turn, 'reason', { messages: [...messages], layers: {} }, {
              parent: stepKey,
              step,
              reason: {
                provider: turn.model.provider,
                model: turn.model.model,
                reasoningEffort: turn.model.reasoningEffort,
                fast: turn.model.fast,
                ...(turn.model.automatic === true ? { automatic: true } : {}),
              },
              maxTokens: maxOutputTokens,
            });
            return outcome.ok
              ? { ok: true, text: outcome.text }
              : { ok: false, error: outcome.error ?? 'compaction summary call failed' };
          },
        });
        const record = async (compacted: CompactionResult): Promise<LedgerEvent[]> => {
          await this.engine.ledger.append(session.sessionId, {
            type: 'context.compacted',
            turn: turn.turn,
            step,
            throughSeq: compacted.throughSeq,
            summary: compacted.summary,
            ...(compacted.estimatedInputTokens === undefined ? {} : { estimatedInputTokens: compacted.estimatedInputTokens }),
            ...(compacted.contextWindow === undefined ? {} : { contextWindow: compacted.contextWindow }),
            ...(compacted.failure === undefined ? {} : { failure: compacted.failure }),
          });
          const freshEvents = this.engine.ledger.read(session.sessionId);
          view = buildView(freshEvents);
          const facts = kernelFacts?.();
          if (facts !== undefined && facts.trim() !== '') {
            view.messages.splice(view.messages.length - 1, 0, { role: 'user', content: renderKernelFactsBlock(facts) });
          }
          return freshEvents;
        };
        const recheck = () => compactionBudgetOf(turn.publicId, view.messages, models, maxTokens);
        const overWindow = (facts: ReturnType<typeof recheck>): boolean => facts.contextWindow !== undefined
          && facts.estimatedInputTokens >= facts.contextWindow;

        const compacted = await compact(source, compactEstimate);
        if (compacted.throughSeq > 0) {
          let fresh = await record(compacted);
          let after = recheck();
          if (overWindow(after)) {
            const started = [...fresh].reverse()
              .find((event) => event.type === 'turn.started' && event.turn === turn.turn);
            const retry = await compact(fresh, after.estimatedInputTokens, started?.seq);
            if (retry.throughSeq > 0) {
              fresh = await record(retry);
              after = recheck();
            }
          }
          if (overWindow(after)) {
            return {
              ok: false,
              error: `context_overflow: estimated input ${after.estimatedInputTokens} exceeds the context window ${after.contextWindow}`,
            };
          }
        }
      }
    }
    return { ok: true, view };
  }
}
