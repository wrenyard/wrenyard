/**
 * The version-control secondary session.
 *
 * It operates the workspace repository itself — the agent-workspace root set by
 * `workspace.root` — through the protocol tools built by `protocolTools`. A
 * successful commit, push or pull is recorded as a `ws.updated` draft with
 * scope `workspace` and target `workspace`.
 */

import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../index.ts';
import {
  buildSecondaryUser,
  createSecondaryRecord,
  protocolTools,
  runSecondary,
  toActionOutcome,
  type MethodEffect,
} from './framework.ts';

/** Rounds the vcs loop may run before it fails. */
const VCS_MAX_ROUNDS = 16;

/** The workspace protocol methods this session exposes. */
const METHODS = [
  'workspace.vcs.status',
  'workspace.vcs.diff',
  'workspace.vcs.commit',
  'workspace.vcs.push',
  'workspace.vcs.pull',
];

/** The workspace change each method records after a successful call. */
const EFFECTS: Readonly<Record<string, MethodEffect>> = {
  'workspace.vcs.commit': { scope: 'workspace', change: 'committed' },
  'workspace.vcs.push': { scope: 'workspace', change: 'pushed', when: 'pushed' },
  'workspace.vcs.pull': { scope: 'workspace', change: 'pulled', when: 'pulled' },
};

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
    tools: await protocolTools(deps, ctx, record, METHODS, EFFECTS),
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
    'Tools:',
    '- workspace_vcs_status: show the working-tree status of the workspace repository.',
    '- workspace_vcs_diff: show a unified diff, optionally limited to paths or staged changes.',
    '- workspace_vcs_commit: commit exactly the named files.',
    '- workspace_vcs_push: push the workspace repository.',
    '- workspace_vcs_pull: fast-forward pull the workspace repository.',
    '',
    'Rules:',
    '- Check status before committing.',
    '- A commit lists exactly the files the intent names. Never add other files.',
    "- When the intent's file list does not match the changed files, do not commit; finish with done failed and explain the difference.",
    '- Push or pull only when the intent asks for it.',
    '- Never retry a refused commit with a file set the intent did not name.',
    '',
    'A refused commit arrives as an error with a code such as file_unchanged, foreign_staged or staged_mismatch and names the offending paths. Read the code and message, correct the call, and try again only with the files the intent names.',
    'Finish with done and a summary of one to three sentences.',
  ].join('\n');
}
