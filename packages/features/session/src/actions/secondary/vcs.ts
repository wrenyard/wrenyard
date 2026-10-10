/**
 * The version-control secondary session.
 *
 * It operates the workspace repository itself — the agent-workspace root set by
 * `workspace.root` — through `deps.host.workspaceVcs`. A successful commit,
 * push or pull is recorded as a `ws.updated` draft with scope `workspace` and
 * target `workspace`.
 */

import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../index.ts';
import {
  buildSecondaryUser,
  createSecondaryRecord,
  jsonResult,
  optionalBooleanArg,
  optionalStringListArg,
  recordWorkspaceUpdate,
  runSecondary,
  stringArg,
  stringListArg,
  toActionOutcome,
  type SecondaryRecord,
  type SecondaryTool,
} from './framework.ts';

/** Rounds the vcs loop may run before it fails. */
const VCS_MAX_ROUNDS = 16;

/** Start one version-control session for a parsed action. */
export async function runVcsAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record = createSecondaryRecord();
  const result = await runSecondary({
    deps,
    ctx,
    role: 'vcs',
    system: vcsSystemPrompt(),
    user: buildSecondaryUser(ctx, action.intent),
    tools: vcsTools(deps, ctx, record),
    maxRounds: VCS_MAX_ROUNDS,
    callIdPrefix: 'vcs',
  });
  return toActionOutcome(result, record);
}

/** The system prompt: the commit and push rules of the workspace repository. */
function vcsSystemPrompt(): string {
  return [
    'You are the version-control operator of a Wrenyard session. You operate the workspace repository that holds the workspace root.',
    '',
    'Rules:',
    '- Check status before committing.',
    '- A commit lists exactly the files the intent names. Never add other files.',
    "- When the intent's file list does not match the changed files, do not commit; finish with done failed and explain the difference.",
    '- Push or pull only when the intent asks for it.',
    '- Never retry a refused commit with a file set the intent did not name.',
    '- If a tool returns workspace_not_repository, do not call any other tool. Finish with done failed and tell the user that the workspace has no git repository of its own.',
    '',
    'A refused commit arrives as an error with a code such as file_unchanged, foreign_staged or staged_mismatch and names the offending paths. Read the code and message, correct the call, and try again only with the files the intent names.',
    'Finish with done and a summary of one to three sentences.',
  ].join('\n');
}

/** The four repository tools plus the shared `done` tool. */
function vcsTools(
  deps: ActionRunnerDeps,
  ctx: ActionRunContext,
  record: SecondaryRecord,
): SecondaryTool[] {
  return [
    {
      spec: {
        name: 'status',
        description: 'Show the working-tree status of the workspace repository.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async run() {
        return jsonResult(await deps.host.workspaceVcs.status());
      },
    },
    {
      spec: {
        name: 'diff',
        description: 'Show a unified diff of the workspace repository, optionally limited to paths or to staged changes.',
        parameters: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, description: 'Limit the diff to these paths.' },
            staged: { type: 'boolean', description: 'Diff staged changes only.' },
          },
          additionalProperties: false,
        },
      },
      async run(args) {
        const paths = optionalStringListArg(args, 'paths');
        const staged = optionalBooleanArg(args, 'staged');
        const diff = await deps.host.workspaceVcs.diff({
          ...(paths === undefined ? {} : { paths }),
          ...(staged === undefined ? {} : { staged }),
        });
        return jsonResult({ diff });
      },
    },
    {
      spec: {
        name: 'commit',
        description: 'Commit exactly the named files in the workspace repository. Never add files the intent did not name.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The commit message.' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'The exact workspace-relative files to commit.',
            },
          },
          required: ['message', 'files'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const message = stringArg(args, 'message');
        const files = stringListArg(args, 'files');
        const result = await deps.host.workspaceVcs.commit({ message, files });
        recordWorkspaceUpdate(record, ctx, {
          scope: 'workspace',
          target: 'workspace',
          change: 'committed',
          hash: result.hash,
          files: result.files,
        });
        return jsonResult(result);
      },
    },
    {
      spec: {
        name: 'push',
        description: 'Push the workspace repository. Only call it when the intent asks for a push.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async run() {
        const result = await deps.host.workspaceVcs.push();
        if (result.pushed === true) {
          recordWorkspaceUpdate(record, ctx, { scope: 'workspace', target: 'workspace', change: 'pushed' });
        }
        return jsonResult(result);
      },
    },
    {
      spec: {
        name: 'pull',
        description: 'Fast-forward pull the workspace repository. Only call it when the intent asks for a pull.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async run() {
        const result = await deps.host.workspaceVcs.pull();
        if (result.pulled === true) {
          recordWorkspaceUpdate(record, ctx, { scope: 'workspace', target: 'workspace', change: 'pulled' });
        }
        return jsonResult(result);
      },
    },
  ];
}
