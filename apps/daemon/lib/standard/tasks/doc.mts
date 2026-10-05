import { renderTaskPromptTemplate, withTaskPromptTemplates } from '../../core/task/prompt-template.mts'
import { FREQUENT_DISPATCH_REQUIREMENTS } from '../task-dispatch.mts'
import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

export const TASK_PROMPT_TEMPLATE_1 = { strings: [`
You are **Document Author** - a documentation author and reviser for exactly one workspace project.

## Mission
Author or revise exactly one Markdown document under the target project's docs directory, guided by the supplied conversation, intent, and workspace template rules.

## Hard Boundary
- Read and write ONLY the exact target document path below. Do not touch any other file.
- Respect the target category and every supplied project/template instruction.
- Create the document if it is absent; otherwise modify only the requested sections.
- Do not write code, commit, push, or run side-effecting commands.
- Do not fabricate program-authoritative before/after claims. Report only the document path and a concise summary.

## Target
- Project: `,
`
- Category: `,
`
- Document path (exact, workspace-relative): `,
`

## Intent
`,
`

## Template rules
`,
`

## Conversation (authoritative domain input, supplied in full)
`,
`

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "summary": "what the document now covers",
  "paths": ["<the exact target document path>"]
}
`], labels: ['targetProject', 'category', 'targetPath', 'intent', 'templateRules', 'conversation'] } as const

/**
 * Doc — document author/reviser builtin.
 *
 * Input is the full originating conversation plus the target project, category,
 * exact target path, intent, and (authoritative) template rules. Output is a
 * short summary and the single document path. The task is a narrowly scoped,
 * automatic dispatch task; it never pins a model or profile and the model may
 * only write the one declared target document.
 */

// ─── I/O schemas ──────────────────────────────────────────────────

export const DocInputSchema = z.object({
  targetProject: z.string().min(1),
  category: z.enum(['spec', 'plan', 'report', 'handoff']),
  targetPath: z.string().min(1),
  intent: z.string().min(1),
  /** Full originating conversation. Supplied verbatim; never truncated. */
  conversation: z.string(),
  /** Authoritative workspace document rules. Filled by the daemon. */
  templateRules: z.string().optional(),
})

export const DocOutputSchema = z.object({
  summary: z.string(),
  paths: z.array(z.string().min(1)).length(1),
})

export type DocInput = z.infer<typeof DocInputSchema>
export type DocOutput = z.infer<typeof DocOutputSchema>

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Document author/reviser. Authors or revises exactly one Markdown document under the target workspace project docs directory, guided by the supplied conversation, intent, and workspace template rules.',
    dispatch: { ...FREQUENT_DISPATCH_REQUIREMENTS, thinking: 'low' },
    writeTargets: (input: unknown): readonly string[] => {
      const docInput = input as DocInput
      return [docInput.targetPath]
    },
    instructions: [shellUsage],
    input: DocInputSchema,
    output: DocOutputSchema,
    prompt: withTaskPromptTemplates((input: unknown): string => {
      const docInput = input as DocInput
      return renderTaskPromptTemplate(TASK_PROMPT_TEMPLATE_1, [docInput.targetProject,
docInput.category,
docInput.targetPath,
docInput.intent,
docInput.templateRules && docInput.templateRules.length > 0 ? docInput.templateRules : '(none supplied)',
docInput.conversation])
    }, [TASK_PROMPT_TEMPLATE_1]),
  },
  sourcePath: 'lib/standard/tasks/doc.mts',
}

export { definition }
export default definition
