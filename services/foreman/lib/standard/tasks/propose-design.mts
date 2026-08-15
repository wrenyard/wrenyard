import { z } from 'zod'

const designOptionSetSchema = z
  .object({
    schema_version: z.literal('design-option/v1'),
    options: z
      .array(
        z
          .object({
            ref: z.string().regex(new RegExp('^DO-[0-9]{3,}$')),
            name: z.string().min(1),
            summary: z.string().min(1),
            when_to_choose: z.array(z.string().min(1)),
            tradeoffs: z.array(z.string().min(1)),
            risks: z.array(z.string().min(1)),
            evidence_level: z.enum(['enough', 'weak', 'missing']),
            evidence_refs: z.array(z.string().min(1)),
            required_explorations: z.array(z.string().min(1)),
            expected_feature_point_shape: z.array(z.string().min(1)),
            non_goal_implications: z.array(z.string().min(1)),
          })
          .strict(),
      )
      .min(3)
      .max(5),
    recommendation: z
      .object({
        option_ref: z.string().regex(new RegExp('^DO-[0-9]{3,}$')),
        reason: z.string().min(1),
      })
      .strict(),
    summary: z.string().min(1),
  })
  .strict()

const InputSchema = z.object({
  topic: z.string().describe('Feature or requirement topic'),
  context: z
    .object({})
    .passthrough()
    .describe(
      'Complete structured brainstorm context including questions, answers, exploration, ideas, and decisions',
    ),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Generate 3-5 design options with trade-off, evidence, and FeaturePoint-shape analysis',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    input: InputSchema,
    output: designOptionSetSchema,
    prompt: ({ topic, context }: z.infer<typeof InputSchema>) => `
You are **Design Option Strategist** — a high-reasoning design advisor for the brainstorm workflow.

## Mission
Generate 3-5 viable design options from the completed brainstorm context.

This is still product/design-level work. Do not decompose into FunctionalUnits and do not write implementation plans.

Brainstorm owns product/design contracts. Your options must make clear which data models, API/tool contracts, REST routes, stream keys, job names/states, index/collection boundaries, payload/result fields, defaults, filters, error semantics, config exposure, and observability signals each direction would fix. If a direction cannot responsibly fix those contracts with current evidence, set evidence_level to weak/missing and list required_explorations.

## Requirements
- Put exactly one JSON object matching the schema in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>.
- Generate 3-5 options using refs \`DO-001\`, \`DO-002\`, ...
- Each option must be meaningfully different.
- Each option must include tradeoffs, risks, evidence level, evidence refs, and expected FeaturePoint shape.
- \`expected_feature_point_shape\` must name user-perceptible FeaturePoint candidates and the concrete contracts likely to become their design_contracts. Write it so it can become the first draft of the spec's "FeaturePoint 与 FunctionalUnit 清单" grouping after confirmation. It must not list verification, CI/CD, rollout gates, deployment checks, security evidence, or acceptance logistics as FeaturePoint candidates.
- If a design direction requires validation or rollout evidence, mention it as a risk/non-goal implication or acceptance concern for the relevant user-visible FeaturePoint, not as its own FeaturePoint shape.
- If a key fact is missing, set \`evidence_level\` to \`weak\` or \`missing\` and list \`required_explorations\`.
- Include a recommendation by option_ref, but do not hide uncertainty.
- Do not invent user decisions, code paths, documents, commits, or research findings.
- Preserve non-goals and rejected directions from the context.

## Input

### Topic
${topic}

### Brainstorm Context
${JSON.stringify(context, null, 2)}

## Example Shape
\`\`\`json
{
  "schema_version": "design-option/v1",
  "options": [
    {
      "ref": "DO-001",
      "name": "Short descriptive name",
      "summary": "What this design direction does",
      "when_to_choose": ["condition"],
      "tradeoffs": ["tradeoff 1"],
      "risks": ["risk 1"],
      "evidence_level": "enough",
      "evidence_refs": ["user:..."],
      "required_explorations": [],
      "expected_feature_point_shape": ["Feature point category this option will produce"],
      "non_goal_implications": ["What this option explicitly will not do"]
    }
  ],
  "recommendation": {
    "option_ref": "DO-001",
    "reason": "Why this approach is recommended"
  },
  "summary": "Short comparison summary"
}
\`\`\`
`,
  },
  sourcePath: 'lib/standard/tasks/propose-design.mts',
}

export default definition
