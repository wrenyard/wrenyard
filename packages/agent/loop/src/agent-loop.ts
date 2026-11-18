/**
 * Generic multi-step agent loop skeleton.
 *
 * Drives the `prepareStep -> runModelStep -> executeStepActions` cycle across
 * consecutive steps, guarantees `finishStep` runs in `finally` with the exact
 * step status (`done` | `failed` | `interrupted`), enforces cancellation
 * guards between stages, and delegates unexpected exceptions to
 * `onTurnException`.
 */

import type { AgentLoopStepStatus, RunAgentLoopOptions } from './types.ts';

/** Run one multi-step agent turn until terminal completion, failure, or abort. */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<void> {
  try {
    for (let step = 1; ; step += 1) {
      if (options.isFinished() || options.isAborted()) return;

      let stepStatus: AgentLoopStepStatus = 'done';
      let turnFailed = false;
      try {
        await options.prepareStep(step);
        if (options.isFinished() || options.isAborted()) return;

        const reasoned = await options.runModelStep(step);
        if (options.isFinished() || options.isAborted()) return;
        if (!reasoned.ok) {
          turnFailed = true;
          stepStatus = 'failed';
          await options.onTurnFailed(reasoned.error, reasoned.failure);
          return;
        }
        if (reasoned.terminal) return;

        const outcome = await options.executeStepActions(step);
        if (options.isFinished() || options.isAborted()) return;
        if (!outcome.continueLoop) return;
      } catch (error) {
        stepStatus = 'failed';
        throw error;
      } finally {
        if (options.isAborted() || (options.isFinished() && !turnFailed)) {
          stepStatus = 'interrupted';
        }
        await options.finishStep(step, stepStatus);
      }
    }
  } catch (error) {
    if (!options.isFinished()) {
      await options.onTurnException(error);
    }
  }
}
