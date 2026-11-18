/** The workspace todo auxiliary task. */
import { createLoopRecord, type LoopRecord } from '@wrenyard/loop';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../ports.ts';
import { runAuxiliary, type AuxiliaryRecordPort } from './runner.ts';
import { createAuxiliaryLoopHelpers } from './shared.ts';

/** Start one workspace todo session for a parsed action. */
export async function runTodoAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record: AuxiliaryRecordPort = {
    ...createLoopRecord(),
    helpers: await createAuxiliaryLoopHelpers(deps.host, 'todo'),
  };
  record.observeToolResult = (content) => observe(record, content);
  return runAuxiliary('todo', action.intent, {
    catalog: deps.host,
    calls: deps.calls,
    record,
    context: ctx,
  });
}

function observe(record: LoopRecord, content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const value = parsed as { todos?: unknown; todo?: unknown; error?: unknown };
  if (value.error !== undefined) return;
  const todos = Array.isArray(value.todos);
  const todo = value.todo !== null && typeof value.todo === 'object' && !Array.isArray(value.todo);
  if (todos || todo) record.observations.push(content);
}
