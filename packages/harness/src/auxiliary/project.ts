/** The project auxiliary task. */
import { createLoopRecord } from '@wrenyard/loop';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../ports.ts';
import { runAuxiliary, type AuxiliaryRecordPort } from './runner.ts';
import { createAuxiliaryLoopHelpers, observeSuccessfulToolResult } from './shared.ts';

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
