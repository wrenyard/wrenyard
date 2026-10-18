/**
 * Turn answer index.
 *
 * One shared reading of "what a turn ended on", so every surface that reports a
 * session result — the text a wake is opened with, and the answer a `read`
 * reports per finished turn — reads the same text from the same events.
 *
 * A turn answers with its closing reply. A turn that published none still
 * carries its answer as the worker output of its terminal reasoning step, which
 * is what a turn ends on when it hands the result to the session instead of
 * speaking it. Only a turn with neither falls back to its last published reply.
 */

import type { LedgerEvent } from '@wrenyard/session'

/** What one turn has published so far. */
interface TurnRecord {
  /** The last reply the turn published. */
  last?: string
  /** The reply the turn published as its closing one. */
  final?: string
  /** The worker output of the last reasoning step the turn completed. */
  reasoning?: string
}

/**
 * The answer of every turn of one ledger, accumulated in one pass. Events are
 * fed in ledger order; `answerOf` may be read at any point afterwards, and
 * before a turn is finished it reports what that turn has published so far.
 */
export class TurnAnswerIndex {
  private readonly turns = new Map<number, TurnRecord>()

  /** Record one ledger event. Events of other kinds, and turn-less ones, skip. */
  feed(event: LedgerEvent): void {
    const turn = event.turn
    if (turn === undefined) return
    if (event.type === 'reply.sent') {
      const record = this.record(turn)
      record.last = event.text
      if (event.kind === 'final') record.final = event.text
      return
    }
    if (event.type === 'reasoning.completed') {
      // Every step of a turn reports one, so the last one is its terminal.
      this.record(turn).reasoning = event.workerOutput ?? event.text
    }
  }

  /**
   * The text one turn ended on, or `undefined` when it published nothing that
   * could answer: a closing reply, else the terminal reasoning output, else the
   * last published reply.
   */
  answerOf(turn: number): string | undefined {
    const record = this.turns.get(turn)
    if (record === undefined) return undefined
    return record.final ?? record.reasoning ?? record.last
  }

  private record(turn: number): TurnRecord {
    const existing = this.turns.get(turn)
    if (existing !== undefined) return existing
    const created: TurnRecord = {}
    this.turns.set(turn, created)
    return created
  }
}
