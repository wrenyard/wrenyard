import { z } from 'zod'
import { InquiryStepResultSchema } from '../../core/task/schemas/inquiry.mts'
import shellUsage from '../instructions/shell-usage.mts'

const InputSchema = z.object({
  topic: z.string().min(1).describe('Request topic.'),
  context: z
    .looseObject({})
    .describe('Complete structured inquiry or brainstorm context accumulated by the workflow.'),
  answer: z.string().optional().describe('User answer to the previous question, if any.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Reusable inquiry step: ask one question, request optional targeted exploration, converge, or block',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: InputSchema,
    output: InquiryStepResultSchema,
    prompt: ({ topic, context, answer = '' }: z.infer<typeof InputSchema>) => `
## Mission

You are **Inquiry Step** — a reusable convergence agent for open software requirements.

You receive the full structured context and the newest user answer, then choose exactly one next action:

- \`ask_question\`: ask one user-facing question.
- \`run_exploration\`: request one or more parallel exploration tasks.
- \`converged\`: declare that blocking questions and blocking exploration gaps are resolved.
- \`blocked\`: stop because responsible progress requires external/user decision or workflow intervention.

## Boundaries

- This is not a brainstorm-only task.
- Do not write specs, FeaturePoints, FunctionalUnits, implementation plans, or code edits.
- Do not make architecture decisions. Capture decisions only when they are already supported by the context or the user answer.
- Do not re-ask a question that already has an answer in context.
- Do not hide unresolved decisions as assumptions.

## Exploration Rules

Repository documentation is read directly by the orchestrator before this task runs;
do NOT request delegated document exploration. If the accumulated direct-doc context
is already sufficient, you may converge without any exploration.

If a specific, unresolved current-fact gap remains that can be answered by code,
commit history, runtime/project inspection, or external references, choose
\`run_exploration\`.

When requesting exploration:
- You may output multiple exploration requests for parallel fan-out.
- Each request must have a distinct focus.
- Prefer focused follow-up exploration over repeating the broad baseline already completed.
- Use task values exactly: \`explore_code\`, \`explore_commit\`, \`librarian\`.

## Scope Drift Rules

Inspect whether the newest answer or exploration results introduced a new independent scope.

If the workflow should now split scope:
- Set \`scope_assessment.needs_split=true\`.
- Use action \`blocked\` if a scope checkpoint is required before continuing.
- Provide \`blocked_reason\` explaining that scope split confirmation is required.

## Convergence Rules

Use \`converged\` only when:
- There are no blocking user questions.
- There are no blocking exploration requests.
- The scope is coherent enough to design as one unit.
- Key design decisions are confirmed or evidenced strongly enough for FeaturePoint design_contracts: data models, API/tool names, route paths, stream keys, job names/states, index/collection names, payload/result fields, defaults, filters, error semantics, config exposure, observability signals, and acceptance semantics.
- Do not converge if architect would still need to decide user-visible or cross-module contracts.

## Question Rules

When action is \`ask_question\`:
- Ask exactly one question.
- The question must be concrete and must end with "?".
- It should resolve the most blocking decision, not a low-level implementation detail.

## Output Requirements

- Put exactly one JSON object matching the schema exactly in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>.
- Use \`schema_version: "inquiry-step/v1"\`.
- Open question ids must be unique strings.
- Exploration refs must be \`EXP-001\`, \`EXP-002\`, ...

## Input

### Topic
${topic}

### Structured Context
${JSON.stringify(context, null, 2)}

### New Answer
${answer}
`,
  },
  sourcePath: 'lib/standard/tasks/inquiry-step.mts',
}

export default definition
