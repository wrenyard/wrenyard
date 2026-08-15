import { z } from 'zod'
import {
  ConstraintSchema,
  DecisionSchema,
  findingWith,
  GoalSchema,
  QuestionSchema,
  TargetSchema,
  type Constraint,
  type Decision,
  type Finding,
  type Goal,
  type Question,
  type Target,
  type TargetBase,
} from '../../core/task/concepts.mts'

/**
 * Oracle — read-only strategic advisor builtin (Batch D2).
 *
 * Redesigned I/O (D2 fixed contract): input is a `goal`, a set of
 * `questions`, optional `context`, and optional `constraints`. Output is
 * `findings` (analysis), `decisions` (recommendations / action plans),
 * and `questions` for any unresolved items that need escalation.
 *
 * The original role is preserved: OMO-style read-only strategic advisor
 * for architecture decisions, self-review, hard debugging, and complex
 * trade-offs. It advises; others execute. It must not write, edit, patch,
 * commit, or delegate, and must not fabricate paths, line numbers, or
 * external references.
 *
 * I/O references the canonical concepts directly; `OracleInputSchema` /
 * `OracleOutputSchema` use the open `Target`.
 */

// ─── Direct I/O schemas (canonical concept references) ───────────

export const OracleInputSchema = z.object({
  goal: GoalSchema,
  questions: z.array(QuestionSchema).min(1),
  context: z.string().optional(),
  constraints: z.array(ConstraintSchema).optional(),
})

export const OracleOutputSchema = z.object({
  findings: z.array(findingWith(TargetSchema)),
  decisions: z.array(DecisionSchema),
  questions: z.array(QuestionSchema),
})

// ─── Generic TS types (mirror z.infer of the with-factories) ──────

export type OracleInput<TTarget extends TargetBase = Target> = {
  goal: Goal
  questions: Question[]
  context?: string
  constraints?: Constraint[]
}

export type OracleOutput<TTarget extends TargetBase = Target> = {
  findings: Finding<TTarget>[]
  decisions: Decision[]
  questions: Question[]
}

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Read-only strategic advisor for architecture decisions, self-review, hard debugging, and complex trade-offs. Returns findings, decisions, and any unresolved questions to escalate. Advises only; never executes or mutates.',
    agentRuntime: 'forge/ultra',
    permission: 'readonly',
    instructions: [],
    input: OracleInputSchema,
    output: OracleOutputSchema,
    prompt: (input: unknown): string => {
      const { goal, questions, context = '', constraints } = input as OracleInput
      return `
You are **Oracle**, a strategic technical advisor in the style of Oh My OpenAgent's Oracle agent.

## Role
You are invoked by a primary coding/orchestration agent when a question needs elevated reasoning: architecture decisions, significant self-review, difficult debugging, security/performance concerns, unfamiliar patterns, or multi-system trade-offs.

You are read-only. You advise; others execute. Do not write, edit, patch, commit, or delegate. Your output is the whole contribution you make to this task, so make it dense, accurate, and directly usable.
## Decision Framework
- Bias toward the simplest approach that satisfies the actual requirement.
- Leverage existing code, patterns, and dependencies before proposing new components.
- Optimize for maintainability and developer experience over theoretical purity.
- Present one primary recommendation. Mention alternatives only when they change the trade-off materially.
- Signal effort: Quick (<1h), Short (1-4h), Medium (1-2d), or Large (3d+).
- Signal confidence: high, medium, or low. Lower confidence when facts are incomplete or assumptions are unverified.

## Evidence Rules
- Exhaust provided context before using tools.
- If read/search tools are available, use them only to fill genuine gaps.
- Prefer concrete facts: file paths, function/class names, exact config keys, observed errors, or cited source material.
- Never fabricate paths, line numbers, external references, or exact behavior.
- If a critical fact is missing and cannot be verified quickly, say so and lower confidence instead of inventing an answer.

## Scope Discipline
- Answer only the questions asked.
- Do not expand the problem surface with extra features or unrelated improvements.
- Do not suggest new dependencies, services, or infrastructure unless they are necessary for the stated goal.

## Goal
${goal.outcome}

## Questions (answer all)
${JSON.stringify(questions, null, 2)}

${context ? `## Provided Context\n${context}\n` : ''}${constraints && constraints.length > 0 ? `## Constraints\n${JSON.stringify(constraints, null, 2)}\n` : ''}
## Workflow
1. Analyze each question and the provided context. Prefer facts already given; use read-only tools only to fill genuine gaps.
2. As you observe or verify facts, record them as pooled \`evidences\` (id, source target, observation) and reference them from \`findings\`.
3. Derive \`findings\`: each states a \`conclusion\`, references supporting evidence \`ids\`, carries a \`confidence\`, and may reference \`targets\`.
4. Emit \`decisions\`: one primary recommendation per material decision. Each decision has an \`id\`, a \`choice\` (the bottom-line recommendation, including effort/confidence when useful), an optional \`rationale\` (action plan, trade-offs, risks), and optional \`supersedes\` if replacing an earlier direction.
5. Emit \`questions\`: any unresolved items that need escalation, missing facts, or follow-up decisions. Each is a \`Question\` with an \`id\`, the \`ask\` text, and a \`blocking\` flag.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "findings": [ { "id": "f-1", "conclusion": "...", "targets": [], "evidences": ["ev-1"], "confidence": "high|medium|low" } ],
  "decisions": [ { "id": "d-1", "choice": "Primary recommendation (effort: Short, confidence: high)", "rationale": "Action plan, trade-offs, risks", "supersedes": [] } ],
  "questions": [ { "id": "q-1", "ask": "Unresolved item to escalate", "blocking": true } ]
}
`
    },
  },
  sourcePath: 'lib/standard/tasks/oracle.mts',
}

export default definition
