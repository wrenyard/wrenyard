/**
 * The workspace todo auxiliary task.
 *
 * It operates the daemon-owned workspace todos through the protocol tools
 * built by `protocolTools`. Only the four native todo methods are exposed:
 * `todo.list`, `todo.get`, `todo.create` and `todo.update`. Todo files are
 * never read or written directly, so the daemon store stays authoritative.
 *
 * Every successful call records its authoritative JSON result as an
 * observation — a `todos` array for a list, a `todo` object for a get, create
 * or update. An error result is never recorded. Reads fabricate no workspace
 * change, and writes rely on the returned record rather than inventing a new
 * change category.
 */

import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../reasoning/actions.ts';
import {
  buildAuxiliaryUser,
  createLoopRecord,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
  type LoopRecord,
  type LoopTool,
} from '../loop/loop.ts';

/** Rounds the todo loop may run before it fails. */
const TODO_MAX_ROUNDS = 8;

/** The native workspace todo methods this session exposes. */
const METHODS = [
  'todo.list',
  'todo.get',
  'todo.create',
  'todo.update',
];

/** Start one workspace todo session for a parsed action. */
export async function runTodoAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record = createLoopRecord();
  const tools = await protocolTools(deps, ctx, record, METHODS, {});
  const result = await runAuxiliaryLoop({
    deps,
    ctx,
    role: 'todo',
    system: todoSystemPrompt(),
    user: buildAuxiliaryUser(ctx, action.intent),
    tools: tools.map((tool) => observed(tool, record)),
    maxRounds: TODO_MAX_ROUNDS,
    spanIdPrefix: 'todo',
    record,
  });
  return toActionOutcome(result, record);
}

/** Wrap one todo tool so its successful authoritative result is recorded. */
function observed(tool: LoopTool, record: LoopRecord): LoopTool {
  return {
    spec: tool.spec,
    async run(args, signal) {
      const content = await tool.run(args, signal);
      observe(record, content);
      return content;
    },
  };
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

/** The system prompt: the native todo rules of this session. */
function todoSystemPrompt(): string {
  return [
    'You are the workspace todo operator of a Wrenyard session. You work only through the native todo methods below.',
    '',
    'Tools:',
    '- todo_list: list every workspace todo.',
    '- todo_get: read one workspace todo by its id.',
    '- todo_create: create one workspace todo.',
    '- todo_update: update one existing workspace todo by its id.',
    '',
    'Rules:',
    '- Use only these native methods. Never read or edit todo files directly, and never dispatch a task or an external task for todo work.',
    '- For a read, return the actual todo contents from the result: id, title, status, dependencies, request, acceptance and attachments as reported. Do not replace them with a summary.',
    '- done means execution finished; accepted means acceptance passed. They are distinct statuses. Never claim a todo is accepted from implementation alone; set accepted only when the intent says the acceptance criteria were verified.',
    '- An update changes only the fields the intent names. Omit every other field so the store keeps it unchanged.',
    '- Change a status, project label, dependency, request, acceptance or attachment only when the intent asks for that change and is authorized for it. When the intent does not authorize a change, leave it out and say so in the summary.',
    '- There is no delete. Never try to remove a todo; report that removal is unsupported.',
    '- Do not claim success without a successful method result. An error result is reported as it arrived.',
    'Finish with done and a summary of one to three sentences.',
  ].join('\n');
}
