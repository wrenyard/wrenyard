/** The version-control auxiliary task. */
import { createLoopRecord } from '@wrenyard/loop';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../ports.ts';
import { runAuxiliary, type AuxiliaryRecordPort } from './runner.ts';
import { createAuxiliaryLoopHelpers, observeSuccessfulToolResult } from './shared.ts';

/** Start one version-control session for a parsed action. */
export async function runVcsAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record: AuxiliaryRecordPort = {
    ...createLoopRecord(),
    helpers: await createAuxiliaryLoopHelpers(deps.host, 'vcs'),
  };
  record.observeToolResult = (content) => observeSuccessfulToolResult(record, content);
  return runAuxiliary('vcs', action.intent, {
    catalog: deps.host,
    calls: deps.calls,
    record,
    context: ctx,
  });
}
