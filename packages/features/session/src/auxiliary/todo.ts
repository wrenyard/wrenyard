/**
 * The workspace todo auxiliary task.
 *
 * The loop and the todo definition (native methods, round budget and system
 * prompt) live in `@wrenyard/agent-loop`. This module is the session-side
 * adapter: it supplies the method catalog, the model transport and a record
 * adapter that records each successful todo result as an observation — a
 * `todos` array for a list, a `todo` object for a get, create or update. An
 * error result is never recorded.
 *
 * Todo files are never read or written directly, so the daemon store stays
 * authoritative.
 */

import {
  runAuxiliary,
  type AuxiliaryRecordPort,
  createLoopRecord,
  type LoopRecord,
} from '@wrenyard/agent-loop';

import { createAuxiliaryLoopHelpers } from './shared.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../reasoning/actions.ts';

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
  // Todo records every successful authoritative payload; project and vcs record
  // successful tool results through the shared helper.
  record.observeToolResult = (content) => observe(record, content);
  return runAuxiliary('todo', action.intent, {
    catalog: deps.host,
    calls: deps.calls,
    record,
    context: ctx,
  });
}

/**
 * Record one tool result as an observation only when it is a successful todo
 * payload: an error result is never evidence, and neither is any other shape.
 */
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
