import { renderTaskPromptTemplate, withTaskPromptTemplates } from '../../core/task/prompt-template.mts'
import { FREQUENT_DISPATCH_REQUIREMENTS } from '../task-dispatch.mts'
import { z } from 'zod'
import type { TaskDefinition } from '../../core/task/types.mts'
import shellUsage from '../instructions/shell-usage.mts'

export const TASK_PROMPT_TEMPLATE_1 = { strings: [`
You are `,` - a read-only fact lookup agent.

## Task
Answer exactly the one factual question below using facts observed in the project checkout. Use targeted search and partial reads, and report only what the code or data says: values, locations, conditions, and call sites. Do NOT diagnose root causes, do NOT propose fixes or designs, and do NOT evaluate. If the fact cannot be found, return \`not_found\` and state what you searched. Stop as soon as the question is answered.

## Tool Constraints
READ-ONLY. Do not modify files.
- Only read, search, inspect, and analyze.
- Prefer targeted reads and searches; avoid broad or generated directories.

## Question
`,``,`
## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "status": "answered|not_found",
  "answer": "<string>",
  "locations": [ { "path": "<string>", "line": <number, optional> } ]
}
`], labels: ['role','question','hints'] } as const


/**
 * Explore — read-only single-fact lookup builtin.
 *
 * A direct `TaskDefinition`: input is one `question` (what/where/how many)
 * with optional `hints`; output is `status` (answered|not_found), a textual
 * `answer`, and supporting `locations`. Permission is always `readonly`: the
 * task reports observed facts and never diagnoses, proposes fixes, or edits.
 */

// ─── Direct I/O schemas ─────────────────────────────────────────

export const ExploreInputSchema = z.object({
  question: z.string(),
  hints: z.array(z.string()).optional(),
})

export const ExploreOutputSchema = z.object({
  status: z.enum(['answered', 'not_found']),
  answer: z.string(),
  locations: z.array(
    z.object({
      path: z.string(),
      line: z.number().optional(),
    }),
  ),
})

// ─── Generic TS types (mirror z.infer of the schemas) ───────────

export type ExploreInput = {
  /** The single factual question to answer. */
  question: string
  /** Optional file paths, directories, symbols, or keywords to start from. */
  hints?: string[]
}

export type ExploreOutput = {
  status: 'answered' | 'not_found'
  answer: string
  locations: Array<{
    path: string
    line?: number
  }>
}

// ─── Task definition (direct TaskDefinition object literal) ─────

/**
 * The read-only single-fact lookup builtin. Open question with optional
 * hints, English fact-only prompt, READ-ONLY, automatic.
 */
const definition: TaskDefinition = {
  __type: 'task',
  config: {
    description: 'Read-only single-fact lookup',
    dispatch: { ...FREQUENT_DISPATCH_REQUIREMENTS, thinking: 'low' },
    instructions: [shellUsage],
    input: ExploreInputSchema,
    output: ExploreOutputSchema,
    prompt: withTaskPromptTemplates((input: unknown): string => {
      const { question, hints } = input as ExploreInput
      const hintsSection =
        hints && hints.length > 0 ? `\n\n## Hints\n${hints.map((hint) => `- ${hint}`).join('\n')}` : ''
      return renderTaskPromptTemplate(TASK_PROMPT_TEMPLATE_1, ['**Explorer**', question, hintsSection])
    }, [TASK_PROMPT_TEMPLATE_1]),
  },
  sourcePath: 'lib/standard/tasks/explore.mts',
}

export { definition }
export default definition
