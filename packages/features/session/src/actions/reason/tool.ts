/**
 * The primary reasoning tool: the one native tool the main reasoning call
 * declares, plus the parser that turns one of its calls into the action type
 * and natural-language intent the engine executes.
 */
import { record, stringField, type ToolCall, type ToolSpec } from '../../driver.ts';

/** The one native tool the main reasoning call declares. */
export const ACTION_TOOL: ToolSpec = {
  name: 'wy_action',
  description:
    'Use search to read workspace material, dispatch to dispatch a task, document to create or revise documents, vcs to manage version control of the workspace repository, project to manage a registered project checkout, and ask to ask the user one question that needs their decision. You can call it several times at once. Each call expresses one thing, with intent in natural language.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['search', 'dispatch', 'document', 'vcs', 'project', 'ask'],
        description: 'search = read workspace material by intent or exact path, dispatch = dispatch a task in a project, document = create or revise documents under projects/<project>/docs, vcs = version control of the workspace repository itself, project = manage a registered project checkout including worktrees, ask = ask the user one question that needs their decision.',
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
    && type !== 'vcs'
    && type !== 'project'
    && type !== 'ask'
  ) {
    return { error: `unknown action type: ${type}` };
  }
  return { type, intent };
}
