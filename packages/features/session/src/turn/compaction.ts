/**
 * session turn compaction: the step's context-budget decision and its
 * execution, from releasing cold events to summarising the covered timeline.
 */

import type { GatewayModel } from '@wrenyard/ai-protocol';
import type { LedgerEvent } from '../ledger/store.ts';
import { contextBudgetOf } from '../model/request.ts';
import type { ModelMetadata } from '@wrenyard/ai/metadata';
import { compactContext, renderKernelFactsBlock, type CompactionResult } from '../context/compaction.ts';
import { computeReduction } from '../context/reduction.ts';
import type { BuiltView, SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';

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

    // A request that would cross the compaction threshold is reduced first and
    // summarised only when the reduction left it over the threshold. Both keep
    // every event on the ledger; their floors bound only the rendered view. A
    // rebuilt view that is still over the hard budget is never sent: the
    // summary runs once more with the tail shrunk to the current turn, and a
    // view still over the window fails the turn naming the sizes.
    const budget = contextBudgetOf(
      turn.publicId,
      view.messages,
      models,
      maxTokens,
    );
    if (!turn.finished && !turn.abort.signal.aborted
      && budget.threshold !== undefined && budget.estimatedInputTokens > budget.threshold) {
      // Stage 1: release the bulky content of cold, older events. It makes no
      // model call, so it runs before the summary, and the floor it records
      // keeps the rendered prefix stable until the next reduction.
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
        const reduced = contextBudgetOf(
          turn.publicId,
          view.messages,
          models,
          maxTokens,
        );
        compactEstimate = reduced.estimatedInputTokens;
        overThreshold = reduced.threshold === undefined
          || reduced.estimatedInputTokens > reduced.threshold;
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
        // Record one compaction and rebuild the view from the ledger it wrote.
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
        const recheck = () => contextBudgetOf(
          turn.publicId,
          view.messages,
          models,
          maxTokens,
        );
        const overWindow = (facts: ReturnType<typeof recheck>): boolean => facts.contextWindow !== undefined
          && facts.estimatedInputTokens >= facts.contextWindow;

        const compacted = await compact(source, compactEstimate);
        if (compacted.throughSeq > 0) {
          let fresh = await record(compacted);
          let after = recheck();
          if (overWindow(after)) {
            // Still over the hard budget: summarise once more with the tail
            // shrunk to the current turn, which is the smallest verbatim tail.
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
