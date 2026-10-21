/**
 * The project auxiliary task.
 *
 * The loop and the project definition (project protocol methods, effect map,
 * round budget and system prompt) live in `@wrenyard/agent-loop`. This module
 * is the session-side adapter: it supplies the method catalog, the model
 * transport and the record adapter.
 *
 * The daemon reports an unregistered project as an error, so this session no
 * longer pre-checks project ids. Every recorded event uses scope `project`, the
 * call's project id as its target and the worktree id when the call names one.
 */

import { runAuxiliary, type AuxiliaryRecordPort, createLoopRecord } from '@wrenyard/agent-loop';

import { createAuxiliaryLoopHelpers, observeSuccessfulToolResult } from './shared.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../reasoning/actions.ts';

/** Start one project session for a parsed action. */
export async function runProjectAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record: AuxiliaryRecordPort = {
    ...createLoopRecord(),
    helpers: await createAuxiliaryLoopHelpers(deps.host, 'project'),
  };
  record.observeToolResult = (content) => observeSuccessfulToolResult(record, content);
  return runAuxiliary('project', action.intent, {
    catalog: deps.host,
    calls: deps.calls,
    record,
    context: ctx,
  });
}
