import { z } from 'zod'
import {
  evidenceWith,
  findingWith,
  QuestionSchema,
  TargetSchema,
  type Evidence,
  type Finding,
  type Question,
  type Target,
  type TargetBase,
} from '../../core/task/concepts.mts'

/**
 * Look At — multimodal visual inspection builtin (Batch D2).
 *
 * Redesigned I/O (D2 fixed contract): input is a single `question` and
 * an `image` `Target` to inspect; output is a pool of `evidences` plus
 * derived `findings`, aligned to the common concepts.
 *
 * The original multimodal runtime is preserved: the agent opens and looks
 * at the image directly (its client supports image input) and answers the
 * question from what is visible. It must not invent details beyond the
 * image (plus provided context carried inside the `Question`).
 *
 * I/O references the canonical concepts directly; `LookAtInputSchema` /
 * `LookAtOutputSchema` use the open `Target`.
 */

// ─── Direct I/O schemas (canonical concept references) ───────────

export const LookAtInputSchema = z.object({
  question: QuestionSchema,
  image: TargetSchema,
})

export const LookAtOutputSchema = z.object({
  findings: z.array(findingWith(TargetSchema)),
  evidences: z.array(evidenceWith(TargetSchema)),
})

// ─── Generic TS types (mirror z.infer of the with-factories) ──────

export type LookAtInput<TTarget extends TargetBase = Target> = {
  question: Question
  /** The image to inspect (e.g. a file target whose client supports image input). */
  image: TTarget
}

export type LookAtOutput<TTarget extends TargetBase = Target> = {
  findings: Finding<TTarget>[]
  evidences: Evidence<TTarget>[]
}

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Multimodal visual inspection. Opens and looks at an image, then answers a question about it from what is visible. Read-only; never fabricates details beyond the image.',
    agentRuntime: 'forge/gk-kimi',
    permission: 'readonly',
    instructions: [],
    input: LookAtInputSchema,
    output: LookAtOutputSchema,
    prompt: (input: unknown): string => {
      const { question, image } = input as LookAtInput
      return `
You are **Look At** — a visual inspection specialist.

## Mission
Open and look at the image, then answer the question about it.

## Image
${JSON.stringify(image, null, 2)}

View this file directly (your client supports image input). If the file does not exist or cannot be read as an image, state that explicitly in your findings instead of guessing.

## Question
${question.ask}
${question.blocking ? '\nThis question is blocking — a concrete verdict is required.\n' : ''}
## Rules
- Answer only from what is visible in the image; do not invent details.
- Keep observations concrete: positions, colors, text content, counts, anomalies.
- As you observe facts, record them as pooled \`evidences\`. Each evidence has an \`id\`, a \`source\` target (the inspected image), and an \`observation\`.
- Derive one or more \`findings\` that directly answer the question. Each finding states a \`conclusion\`, references supporting evidence \`ids\`, carries a \`confidence\`, and may reference \`targets\`.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "findings": [ { "id": "f-1", "conclusion": "Direct answer to the question", "targets": [], "evidences": ["ev-1"], "confidence": "high|medium|low" } ],
  "evidences": [ { "id": "ev-1", "source": { "kind": "file", "value": "/abs/path.png" }, "observation": "Notable visual observation" } ]
}
`
    },
  },
  sourcePath: 'lib/standard/tasks/look-at.mts',
}

export default definition
