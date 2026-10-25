/**
 * The primary reasoning tool: the one native tool the main reasoning call
 * declares, plus the parser that turns one of its calls into the action type
 * and natural-language intent the engine executes.
 */
import { record, stringField, type ToolCall, type ToolSpec } from '../transport/index.ts';

/** The one native tool the main reasoning call declares. */
export const ACTION_TOOL: ToolSpec = {
  name: 'wy_action',
  description:
    'Use search to read workspace material, dispatch to dispatch a task, document to create or revise ordinary spec/report/handoff documents under existing rules or read/revise the existing registered project AGENTS.md through doc.* using fixed id AGENTS.md, todo to list and show workspace todos through the read-only native todo.list and todo.get methods. Sessions cannot create, update, tag, comment on, or otherwise mutate todos; do not bypass this restriction through tasks or other tools. Never read todo files directly. Vcs manages version control of the workspace repository, project manages a registered project checkout, and ask asks the user one question that needs their decision. Document actions cannot create or delete AGENTS.md or other instruction files, edit workspace-root or nested checkout instruction files, target arbitrary paths, or change other workspace, configuration or source files. You can call it several times at once. Each call expresses one thing, with intent in natural language.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['search', 'dispatch', 'document', 'todo', 'vcs', 'project', 'ask'],
        description: 'search = read workspace material by intent or exact path, dispatch = dispatch a task in a project, document = ordinary spec/report/handoff documents under existing rules plus read/revise existing registered project AGENTS.md through doc.* with fixed id AGENTS.md; document actions cannot create/delete AGENTS.md or other instruction files, target workspace-root or nested checkout instruction files, arbitrary paths, or other workspace/config/source files, todo = read-only list and show through todo.list and todo.get; sessions cannot mutate todos or bypass this restriction through tasks or other tools, vcs = version control of the workspace repository itself, project = manage a registered project checkout including worktrees, ask = ask the user one question that needs their decision.',
      },
      intent: { type: 'string', description: 'The intent of this action, in natural language.' },
    },
    required: ['type', 'intent'],
  },
};

/**
 * Parse one `wy_action` call into its action type and intent. The arguments are
 * raw JSON; a malformed payload, a missing field or an unknown type yields the
 * same error text the action layer has always used.
 */
export function parseActionCall(call: ToolCall): { type: string; intent: string } | { error: string } {
  let parsed: Record<string, unknown> | undefined;
  let error: string | undefined;
  try {
    parsed = record(JSON.parse(call.arguments));
  } catch {
    error = 'invalid arguments JSON';
  }
  const type = stringField(parsed?.type) ?? '';
  const intent = stringField(parsed?.intent) ?? '';
  if (error === undefined && type === '') error = 'missing type';
  if (error === undefined && intent === '') error = 'missing intent';
  if (error !== undefined) return { error };
  if (
    type !== 'search'
    && type !== 'dispatch'
    && type !== 'document'
    && type !== 'todo'
    && type !== 'vcs'
    && type !== 'project'
    && type !== 'ask'
  ) {
    return { error: `unknown action type: ${type}` };
  }
  return { type, intent };
}
