/** Document auxiliaries use the host's durable workspace document commit path. */
import { runAuxiliary, createLoopRecord } from '@wrenyard/agent-loop';
import { createAuxiliaryLoopHelpers } from './shared.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../reasoning/actions.ts';

export async function runDocumentAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record = {
    ...createLoopRecord(),
    helpers: await createAuxiliaryLoopHelpers(deps.host, 'document', () => deps.files.readDocumentRules()),
  };
  return runAuxiliary('document', action.intent, {
    catalog: deps.host, calls: deps.calls, record, context: ctx,
    documentRules: () => deps.files.readDocumentRules(),
  });
}
