/**
 * The version-control auxiliary task.
 *
 * The loop and the vcs definition (workspace protocol methods, effect map,
 * round budget and system prompt) live in `@wrenyard/agent-loop`. This module
 * is the session-side adapter: it supplies the method catalog, the model
 * transport and the record adapter. A successful commit, push or pull is
 * recorded by the definition's effect map as a `ws.updated` draft with scope
 * `workspace` and target `workspace`.
 */

import { runAuxiliary, type AuxiliaryRecordPort, createLoopRecord } from '@wrenyard/agent-loop';

import { escapeBody, renderEventsBlock } from '../context/render.ts';
import { messageOf } from '../errors.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../reasoning/actions.ts';

/** Start one version-control session for a parsed action. */
export async function runVcsAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record: AuxiliaryRecordPort = {
    ...createLoopRecord(),
    helpers: {
      messageOf,
      escapeBody,
      renderEventsBlock,
    },
  };
  return runAuxiliary('vcs', action.intent, {
    catalog: deps.host,
    calls: deps.calls,
    record,
    context: ctx,
  });
}
