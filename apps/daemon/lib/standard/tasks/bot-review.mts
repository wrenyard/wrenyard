import { renderTaskPromptTemplate, withTaskPromptTemplates } from '../../core/task/prompt-template.mts'
import { REVIEW_DISPATCH_REQUIREMENTS } from '../task-dispatch.mts'
import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

export const TASK_PROMPT_TEMPLATE_1 = { strings: [`
You are the **Session Reviewer** for an autonomous dispatcher bot. Judge whether one work session is still on track against the request it was given and the acceptance criteria that must hold, and say what to do next.

## Request
`,`

## Brief the session was given
`,`

## Worktree
`,`

## Worktree diff
`,`

## Recent session turns
`,`

## Corrections already sent
`,`

## Rules
- READ-ONLY. Inspect the diff and the turns; never modify files and never propose a code patch inline.
- Judge only what the diff and the turns show. Do not invent files, commits or behaviour.
- Answer with exactly one verdict:
  - \`continue\`: the session is making sound progress towards the brief and needs no intervention.
  - \`correct\`: the session is off track, has stalled on the wrong problem, is drifting from the brief, or is ignoring the rules (minimal diff, no unneeded tests, commit in its worktree only, never merge/push/tag/release). Supply \`correction\`: one short, concrete instruction the session can act on immediately. Do not restate the whole brief.
  - \`ready\`: the work is complete and correct: the diff implements the brief and the acceptance criteria, and nothing is missing. Only answer \`ready\` when you would accept the change yourself.
  - \`park\`: the session cannot proceed without a user decision, or the request itself is now unclear. Supply \`question\`: the precise question to ask the user.
- \`reason\` always states the concrete observation behind the verdict, citing files, hunks or turn text.
- Repeated corrections mean the session has failed to converge; when corrections are high and the work is still not on track, prefer \`park\` with the blocker rather than another correction.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "verdict": "continue|correct|ready|park",
  "reason": "<the observation behind the verdict>",
  "correction": "<one concrete instruction, when correct>",
  "question": "<the precise question, when park>"
}
`], labels: ['request', 'brief', 'worktree', 'diff', 'recentTurns', 'corrections'] } as const

/**
 * Bot Review — read-only session reviewer builtin for Bot mode.
 *
 * The bot host runs this while an item is `in_progress`, on new session
 * activity or after an idle timeout, and never while the session is running a
 * turn. The task compares the worktree diff and the recent turns against the
 * request and its acceptance criteria, and returns one of `continue`,
 * `correct` (with the correction text), `ready` or `park` (with the question).
 *
 * Permission is always readonly: it never edits and never restates the brief.
 */

// ─── I/O schemas ──────────────────────────────────────────────────

export const BotReviewInputSchema = z.object({
  request: z.object({
    title: z.string().min(1),
    body: z.string().optional(),
    url: z.string().optional(),
  }),
  brief: z.string(),
  worktree: z.string(),
  /** Truncated by the caller to 60k characters. */
  diff: z.string(),
  /** The last replies, truncated by the caller to 20k characters. */
  recentTurns: z.string(),
  corrections: z.number().int().min(0),
})

export const BotReviewOutputSchema = z.object({
  verdict: z.enum(['continue', 'correct', 'ready', 'park']),
  reason: z.string().min(1),
  correction: z.string().optional(),
  question: z.string().optional(),
})

export type BotReviewInput = z.infer<typeof BotReviewInputSchema>
export type BotReviewOutput = z.infer<typeof BotReviewOutputSchema>

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Read-only session reviewer for the dispatcher bot: judges a work session against its brief and acceptance criteria and returns continue, correct, ready or park. Never edits.',
    dispatch: REVIEW_DISPATCH_REQUIREMENTS,
    instructions: [shellUsage],
    input: BotReviewInputSchema,
    output: BotReviewOutputSchema,
    prompt: withTaskPromptTemplates((input: unknown): string => {
      const { request, brief, worktree, diff, recentTurns, corrections } = input as BotReviewInput
      return renderTaskPromptTemplate(TASK_PROMPT_TEMPLATE_1, [
        JSON.stringify(request, null, 2),
        brief,
        worktree,
        diff === '' ? '(empty diff)' : diff,
        recentTurns === '' ? '(no replies yet)' : recentTurns,
        String(corrections),
      ])
    }, [TASK_PROMPT_TEMPLATE_1]),
  },
  sourcePath: 'lib/standard/tasks/bot-review.mts',
}

export default definition
