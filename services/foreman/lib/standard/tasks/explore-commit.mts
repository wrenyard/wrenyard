import { z } from 'zod'
import { GitCommitTargetSchema } from '../../core/task/targets/git-commit.mts'
import {
  ConstraintSchema,
  evidenceWith,
  findingWith,
  GoalSchema,
  QuestionSchema,
} from '../../core/task/concepts.mts'
import { buildExplorePrompt } from './explore.mts'
import shellUsage from '../instructions/shell-usage.mts'
import type { TaskCapabilityConfig, TaskDefinition } from '../../core/task/types.mts'

/**
 * Explore Commit — git history analysis agent (Batch D3).
 *
 * A direct `TaskDefinition` built on the explore contract: input is
 * `goal` + `questions`(≥1) + `targets` (narrowed to `GitCommitTarget`) +
 * optional `constraints`, plus the typed optional `count` (default 20)
 * and `focus` extensions that bound and prioritize history inspection.
 * Output evidences/findings reference `GitCommitTarget` sources (kind
 * `git_commit` with hash/date/theme). Permission is `readonly`.
 *
 * The task runs under the Forge `git-history` capability, which only
 * permits `git --no-optional-locks log --oneline *`,
 * `git --no-optional-locks show --name-only *`, and
 * `git --no-optional-locks show --stat *`. It is selected
 * deterministically for every run so the readonly agent can inspect
 * history without BashGate denying generic `git log`/`git show`.
 */

const inputSchema = z.object({
  goal: GoalSchema,
  questions: z.array(QuestionSchema).min(1),
  targets: z.array(GitCommitTargetSchema),
  constraints: z.array(ConstraintSchema).optional(),
  count: z.number().optional(),
  focus: z.string().optional(),
})

const output = z.object({
  results: z.array(
    z.object({
      question_id: z.string(),
      status: z.enum(['answered', 'unanswered', 'blocked']),
      reason: z.string().optional(),
      findings: z.array(findingWith(GitCommitTargetSchema)),
    }),
  ),
  evidences: z.array(evidenceWith(GitCommitTargetSchema)),
})

type CommitInput = z.infer<typeof inputSchema>

/**
 * Forge capability config for explore-commit: exactly `git-history` is
 * declared and selected unconditionally so every run mounts the narrow
 * read-only git-history command set under the readonly permission.
 */
export const commitCapabilityConfig: TaskCapabilityConfig = {
  available: ['git-history'],
  select: (): readonly string[] => ['git-history'],
}

const definition: TaskDefinition = {
  __type: 'task',
  config: {
    description:
      'Read recent git commits and identify change trends and active development areas. Read-only git history analysis.',
    agentRuntime: 'forge/fast',
    permission: 'readonly',
    capabilities: commitCapabilityConfig,
    instructions: [shellUsage],
    input: inputSchema,
    output,
    prompt: (promptInput: unknown): string => {
      const {
        goal,
        questions,
        targets,
        constraints,
        count = 20,
        focus = '',
      } = promptInput as CommitInput
      const workflow = `1. Run \`git --no-optional-locks log --oneline -${count}\` to list recent commits.
2. For each commit, inspect its message and changed files with \`git --no-optional-locks show --name-only <hash>\` and \`git --no-optional-locks show --stat <hash>\`.
3. Categorize each commit's theme.
4. If a focus is provided, explicitly identify commits and changed files relevant to that focus, and say when no relevant recent history exists.
5. Identify active development areas from recurring paths, files, and themes.
6. Summarize overall change trends, separating focus-relevant history from general repository activity.

## Commit Count
${count}

## Focus
${focus || '(none)'}`
      return buildExplorePrompt({
        role: '**Commit Explorer**',
        toolConstraints:
          'READ-ONLY. Do not modify files or git state.\n- Only inspect git history and analyze change patterns.\n- Follow the shell usage rules exactly.',
        workflow,
        goal,
        questions,
        targets,
        constraints,
      })
    },
  },
  sourcePath: 'lib/standard/tasks/explore-commit.mts',
}

export default definition
