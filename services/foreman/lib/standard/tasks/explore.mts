import { z } from 'zod'
import {
  ConstraintSchema,
  evidenceWith,
  findingWith,
  GoalSchema,
  QuestionSchema,
  TargetSchema,
  type Constraint,
  type Evidence,
  type Finding,
  type Goal,
  type Question,
  type Target,
  type TargetBase,
} from '../../core/task/concepts.mts'
import type { TaskDefinition } from '../../core/task/types.mts'

/**
 * Explore — problem-driven read-only exploration builtin.
 *
 * A direct `TaskDefinition`: input is `goal` + `questions`(≥1) + `targets`
 * (open `Target`) + optional `constraints`; output is `results` (one entry
 * per question, status answered|unanswered|blocked) plus a pooled
 * `evidences` set with derived `findings`. Permission is always
 * `readonly`. Domain explore tasks (explore-code / explore-commit) are
 * sibling direct definitions that narrow `targets` and the
 * evidence/finding `source`/`targets` to a domain Target subtype.
 */

// ─── Direct I/O schemas (canonical concept references) ───────────

export const ExploreInputSchema = z.object({
  goal: GoalSchema,
  questions: z.array(QuestionSchema).min(1),
  targets: z.array(TargetSchema),
  constraints: z.array(ConstraintSchema).optional(),
})

export const ExploreOutputSchema = z.object({
  results: z.array(
    z.object({
      question_id: z.string(),
      status: z.enum(['answered', 'unanswered', 'blocked']),
      reason: z.string().optional(),
      findings: z.array(findingWith(TargetSchema)),
    }),
  ),
  evidences: z.array(evidenceWith(TargetSchema)),
})

// ─── Generic TS types (mirror z.infer of the schemas) ───────────

export type ExploreInput<TTarget extends TargetBase = Target> = {
  goal: Goal
  /** Questions that drive the investigation, 1:1 with output results. */
  questions: Question[]
  /** Investigation targets (files, symbols, commands, urls, ...). */
  targets: TTarget[]
  /** Optional constraints the exploration must respect. */
  constraints?: Constraint[]
}

export type ExploreOutput<TTarget extends TargetBase = Target> = {
  /** One entry per input question, in the same order. */
  results: Array<{
    question_id: string
    status: 'answered' | 'unanswered' | 'blocked'
    reason?: string
    findings: Finding<TTarget>[]
  }>
  /** Pooled evidence referenced by `findings[].evidences`. */
  evidences: Evidence<TTarget>[]
}

// ─── Common prompt builder (shared by the explore-family definitions) ──

/**
 * Build the common explore prompt: the problem framing, goal/questions/
 * targets/constraints rendering, the pooled-evidence workflow, and the
 * fixed `<result>` JSON output shape. Each explore-family task contributes
 * its own `role`, `toolConstraints`, and `workflow` string.
 */
export function buildExplorePrompt(args: {
  role: string
  toolConstraints: string
  workflow: string
  goal: Goal
  questions: Question[]
  targets: TargetBase[]
  constraints?: Constraint[]
}): string {
  const { role, toolConstraints, workflow, goal, questions, targets, constraints } = args
  return `
You are ${role} - a read-only investigation agent.

## Problem
Answer every question using direct evidence gathered from the declared targets. Do not guess beyond what the evidence supports.

## Goal
${goal.outcome}

## Questions (answer all, 1:1)
${JSON.stringify(questions, null, 2)}

## Targets to investigate
${JSON.stringify(targets, null, 2)}

${constraints && constraints.length > 0 ? `## Constraints\n${JSON.stringify(constraints, null, 2)}\n` : ''}
## Tool Constraints
${toolConstraints}

## Workflow
1. Read the goal and every question. Treat the questions as the driving problem — each must end as \`answered\`, \`unanswered\`, or \`blocked\`.
2. Investigate the declared targets only. Prefer targeted reads and searches; avoid broad or generated directories.
3. As you observe facts, record them as pooled \`evidences\`. Each evidence has an \`id\`, a \`source\` target, and an \`observation\`.
4. Derive \`findings\` from the evidence pool. Each finding states a \`conclusion\`, references supporting evidence \`ids\`, carries a \`confidence\`, and may reference \`targets\`.
5. For every input question, produce exactly one result with the same \`question_id\`:
   - \`answered\`: the evidence supports a conclusion.
   - \`unanswered\`: investigation was inconclusive or evidence was insufficient.
   - \`blocked\`: a missing input, access, tooling, or environment limit prevented a verdict. Add a short \`reason\`.
6. Keep \`evidences\` pooled (shared across findings) and reference them by id — do not duplicate observations inline.

${workflow}

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "results": [
    { "question_id": "<id>", "status": "answered|unanswered|blocked", "reason": "<optional>", "findings": [ ... ] }
  ],
  "evidences": [ { "id": "...", "source": { "kind": "...", "value": "..." }, "observation": "..." } ]
}
`
}

// ─── Task definition (direct TaskDefinition object literal) ─────

/**
 * The independent, generic explore builtin. No domain specifics: open
 * `Target`, generic role, READ-ONLY, forge/fast.
 */
const definition: TaskDefinition = {
  __type: 'task',
  config: {
    description:
      'Problem-driven read-only exploration. Investigates targets against a goal and questions, pooling evidences and findings, and answers each question as answered/unanswered/blocked.',
    agentRuntime: 'forge/fast',
    permission: 'readonly',
    instructions: [],
    input: ExploreInputSchema,
    output: ExploreOutputSchema,
    prompt: (input: unknown): string => {
      const { goal, questions, targets, constraints } = input as ExploreInput
      return buildExplorePrompt({
        role: '**Explorer**',
        toolConstraints:
          'READ-ONLY. Do not modify files.\n- Only read, search, inspect, and analyze.\n- Prefer targeted reads and searches; avoid broad or generated directories.',
        workflow: '',
        goal,
        questions,
        targets,
        constraints,
      })
    },
  },
  sourcePath: 'lib/standard/tasks/explore.mts',
}

export { definition }
export default definition
