import { z } from 'zod'
import {
  ConstraintSchema,
  evidenceWith,
  FileTargetSchema,
  findingWith,
  GoalSchema,
  QuestionSchema,
} from '../../core/task/concepts.mts'
import { buildExplorePrompt, type ExploreInput } from './explore.mts'
import type { TaskDefinition } from '../../core/task/types.mts'

/**
 * Explore Code — code fact-confirmation agent (Batch D3).
 *
 * A direct `TaskDefinition` built on the explore contract: input is
 * `goal` + `questions`(≥1) + `targets` (narrowed to `FileTarget`) +
 * optional `constraints`; output is `results` + pooled `evidences` with
 * `findings` referencing `FileTarget` sources. Permission is `readonly`,
 * role is `**Code Explorer**`, and the workflow preserves the source
 * `explore-code` behavior: prefer `rg`, trace entry points / callers /
 * data flow, and report confidence.
 */

const input = z.object({
  goal: GoalSchema,
  questions: z.array(QuestionSchema).min(1),
  targets: z.array(FileTargetSchema),
  constraints: z.array(ConstraintSchema).optional(),
})

const output = z.object({
  results: z.array(
    z.object({
      question_id: z.string(),
      status: z.enum(['answered', 'unanswered', 'blocked']),
      reason: z.string().optional(),
      findings: z.array(findingWith(FileTargetSchema)),
    }),
  ),
  evidences: z.array(evidenceWith(FileTargetSchema)),
})

const definition: TaskDefinition = {
  __type: 'task',
  config: {
    description:
      'Confirm implementation facts against requirements and the doc-first context baseline. Read-only code search that prefers rg and traces entry/data flow.',
    agentRuntime: 'forge/fast',
    permission: 'readonly',
    instructions: [],
    input,
    output,
    prompt: (input: unknown): string => {
      const { goal, questions, targets, constraints } = input as ExploreInput
      return buildExplorePrompt({
        role: '**Code Explorer**',
        toolConstraints:
          'READ-ONLY. Do not modify files.\n- Only read, search, inspect, and analyze.\n- Follow the shell usage rules exactly.\n- Prefer `rg` for search; fall back to grep/find only when needed.',
        workflow: `1. Parse the goal and every question. Treat this as a fact-confirmation pass: repository docs/specs/plans/handoffs carry design intent, code carries current implementation facts.
2. Treat Foreman task context as the document baseline when present; do not search for or re-read exact content already supplied there. Otherwise do one short pass for nearby AGENTS.md, README, specs, plans, handoff, or reports.
3. Group related questions into the fewest \`rg\` searches, then read only the matching regions needed to answer them. Exact target paths do not require Glob discovery.
4. Read a file once per evidence pass unless a newly discovered caller makes a second region necessary. Stop searching as soon as every question has sufficient evidence.
5. Trace entry points, callers, and data flow far enough to avoid architecture conclusions from one isolated file.
6. Identify concrete files, symbols, line ranges, and why each reference is relevant.
7. Say whether code confirms, refines, or contradicts the supplied/nearby documentation; report confidence and unresolved gaps.`,
        goal,
        questions,
        targets,
        constraints,
      })
    },
  },
  sourcePath: 'lib/standard/tasks/explore-code.mts',
}

export default definition
