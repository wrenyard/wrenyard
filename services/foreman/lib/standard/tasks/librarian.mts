import { renderTaskPromptTemplate, withTaskPromptTemplates } from '../../core/task/prompt-template.mts'
import { GENERAL_DISPATCH_REQUIREMENTS } from '../task-dispatch.mts'
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
import shellUsage from '../instructions/shell-usage.mts'

export const TASK_PROMPT_TEMPLATE_1 = { strings: [`
You are **Librarian** - a research specialist.

## Mission
Search and retrieve high-quality information to answer the user's questions under the stated goal. Return structured, verifiable results.

## Constraints
- You are READ-ONLY. Do not modify any files.
- Do not use write, edit, or any tool with side effects.
- If no search capability is available, say so. Do not fabricate answers from training data.
- Prefer primary sources (official docs, papers, authoritative sites) and cross-reference across sources.

Use native web search and cite retrieved source URLs. If the search tool is unavailable, report that inability explicitly; never fabricate retrieval or substitute local file search.

## Goal
`,
`

## Questions (answer all)
`,
`

`,
`
## Workflow
1. Analyze each question to identify key search terms (try both English and Chinese keywords).
2. Search 3-6 high-quality sources per question. Prefer primary sources.
3. Cross-reference findings across sources; flag anything unverified.
4. As you observe facts, record them as pooled \`evidences\`. Each evidence has an \`id\`, a \`source\` target (use a url target for web sources), and an \`observation\`.
5. Derive \`findings\` from the evidence pool. Each finding states a \`conclusion\`, references supporting evidence \`ids\`, carries a \`confidence\`, and may reference \`targets\`.
6. Keep \`evidences\` pooled (shared across findings) and reference them by id — do not duplicate observations inline.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "findings": [ { "id": "f-1", "conclusion": "...", "targets": [], "evidences": ["ev-1"], "confidence": "high|medium|low" } ],
  "evidences": [ { "id": "ev-1", "source": { "kind": "url", "value": "https://..." }, "observation": "..." } ]
}
`], labels: ["goal.outcome","questions","constraints"] } as const


/**
 * Librarian — web-only research agent builtin (Batch D2).
 *
 * Redesigned I/O (D2 fixed contract): input is a `goal`, a set of
 * `questions`, and optional `constraints`. Output is a pool of
 * `evidences` plus derived `findings`, aligned to the common concepts.
 *
 * The original role is preserved: this is a READ-ONLY web research agent
 * that searches the internet, cross-references sources, and returns
 * structured, verifiable results. It must never fabricate answers and
 * must not use any tool with side effects.
 *
 * I/O references the canonical concepts directly; `LibrarianInputSchema` /
 * `LibrarianOutputSchema` use the open `Target`.
 */

// ─── Direct I/O schemas (canonical concept references) ───────────

export const LibrarianInputSchema = z.object({
  goal: GoalSchema,
  questions: z.array(QuestionSchema).min(1),
  constraints: z.array(ConstraintSchema).optional(),
})

export const LibrarianOutputSchema = z.object({
  findings: z.array(findingWith(TargetSchema)),
  evidences: z.array(evidenceWith(TargetSchema)),
})

// ─── Generic TS types (mirror z.infer of the with-factories) ──────

export type LibrarianInput<TTarget extends TargetBase = Target> = {
  goal: Goal
  questions: Question[]
  constraints?: Constraint[]
}

export type LibrarianOutput<TTarget extends TargetBase = Target> = {
  findings: Finding<TTarget>[]
  evidences: Evidence<TTarget>[]
}

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Web-only research agent. Searches the internet to answer questions under a goal, cross-references sources, and returns structured findings and evidences. Read-only; never fabricates or mutates files.',
    dispatch: { ...GENERAL_DISPATCH_REQUIREMENTS, requiresWebSearch: true },
    permission: 'readonly',
    instructions: [shellUsage],
    input: LibrarianInputSchema,
    output: LibrarianOutputSchema,
    prompt: withTaskPromptTemplates((input: unknown): string => {
      const { goal, questions, constraints } = input as LibrarianInput
      return renderTaskPromptTemplate(TASK_PROMPT_TEMPLATE_1, [goal.outcome,
JSON.stringify(questions, null, 2),
constraints && constraints.length > 0 ? `## Constraints\n${JSON.stringify(constraints, null, 2)}\n` : ''])
    }, [TASK_PROMPT_TEMPLATE_1]),
  },
  sourcePath: 'lib/standard/tasks/librarian.mts',
}

export default definition
