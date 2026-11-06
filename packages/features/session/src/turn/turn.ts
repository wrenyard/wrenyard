/**
 * session turn facade: `engine.ts` owns the session lifecycle and calls into
 * {@link TurnRunner} for everything a turn does. The loop, the compaction and
 * the actions live in `native-loop.ts`, `compaction.ts` and `actions.ts`.
 */

import type { ReplyWriter } from '../auxiliary/reply.ts';
import type { SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';
import { ActionRunner } from './actions.ts';
import { Compaction } from './compaction.ts';
import { NativeLoop } from './native-loop.ts';

/** Run the turn and step loop over the session runtime. */
export class TurnRunner {
  private readonly actions: ActionRunner;
  private readonly loop: NativeLoop;

  constructor(
    engine: SessionCallHost,
    replies: ReplyWriter,
  ) {
    const compaction = new Compaction(engine);
    this.actions = new ActionRunner(engine);
    this.loop = new NativeLoop(engine, replies, this.actions, compaction);
  }

  async runTurn(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    await this.loop.runTurn(session, turn);
  }

  async flushResults(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    await this.actions.flushResults(session, turn);
  }
}
