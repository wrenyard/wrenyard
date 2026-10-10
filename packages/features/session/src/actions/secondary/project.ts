/**
 * The project secondary session.
 *
 * It manages registered project checkouts and their worktrees through the
 * protocol tools built by `protocolTools`. The daemon reports an unregistered
 * project as an error, so this session no longer pre-checks project ids. Every
 * recorded event uses scope `project`, the call's project id as its target and
 * the worktree id when the call names one.
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

/** Rounds the project loop may run before it fails. */
const PROJECT_MAX_ROUNDS = 16;

/** The project protocol methods this session exposes. */
const METHODS = [
  'project.status',
  'project.diff',
  'project.commit',
  'project.push',
  'project.pull',
  'project.worktree.list',
  'project.worktree.create',
  'project.worktree.remove',
  'project.worktree.merge',
  'project.register',
];

/** The workspace change each method records after a successful call. */
const EFFECTS: Readonly<Record<string, MethodEffect>> = {
  'project.commit': { scope: 'project', change: 'committed' },
  'project.push': { scope: 'project', change: 'pushed', when: 'pushed' },
  'project.pull': { scope: 'project', change: 'pulled', when: 'pulled' },
  'project.worktree.create': { scope: 'project', change: 'worktree-created' },
  'project.worktree.remove': { scope: 'project', change: 'worktree-removed', when: 'removed' },
  'project.worktree.merge': { scope: 'project', change: 'worktree-merged', when: 'merged' },
  'project.register': { scope: 'project', change: 'registered', when: 'registered' },
};

/** Start one project session for a parsed action. */
export async function runProjectAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record = createSecondaryRecord();
  const result = await runSecondary({
    deps,
    ctx,
    role: 'project',
    system: projectSystemPrompt(),
    user: buildSecondaryUser(ctx, action.intent),
    tools: await protocolTools(deps, ctx, record, METHODS, EFFECTS),
    maxRounds: PROJECT_MAX_ROUNDS,
    callIdPrefix: 'project',
  });
  return toActionOutcome(result, record);
}

/** The system prompt: the commit, push and worktree rules. */
function projectSystemPrompt(): string {
  return [
    'You are the project operator of a Wrenyard session. You manage registered project checkouts and their worktrees through the tools.',
    '',
    'Tools:',
    '- project_status: show the working-tree status of a project checkout or worktree.',
    '- project_diff: show a unified diff, optionally limited to paths or staged changes.',
    '- project_commit: commit exactly the named files.',
    '- project_push: push to origin on the current branch.',
    '- project_pull: fast-forward pull the project checkout.',
    '- project_worktree_list: list the managed worktrees of a project.',
    '- project_worktree_create: create one managed worktree.',
    '- project_worktree_remove: remove one managed worktree.',
    '- project_worktree_merge: merge one managed worktree into its project target branch.',
    '',
    'Rules:',
    '- Check status before committing.',
    '- A commit lists exactly the files the intent names. Never add other files.',
    "- When the intent's file list does not match the changed files, do not commit; finish with done failed and explain the difference.",
    '- Push goes only to origin on the current branch, requires a clean tree, and happens only when the intent asks for it.',
    '- Pull happens only when the intent asks for it.',
    '- Never retry a refused commit with a file set the intent did not name.',
    '- Remove or merge a worktree only when the intent asks for it.',
    '- Register a project only when the intent asks to register or add one.',
    '- Use the id, description and checkout path that the intent gives; never invent a checkout path.',
    '- When the intent gives a git checkout but no remote, let the daemon detect it.',
    '- If the project id is already registered, do not register it again; finish with done failed and say so.',
    "- A newly registered project is not in this session's project list until a new session starts; mention that in the done summary.",
    '',
    'A refused commit or worktree operation arrives as an error with a code and a message naming the offending paths or worktree. Read both, correct the call, and try again only with what the intent names. An unregistered project arrives as an error from the host; use an id from the project list in the message.',
    'Finish with done and a summary of one to three sentences.',
  ].join('\n');
}
