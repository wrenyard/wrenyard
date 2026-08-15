import { z } from 'zod'
import { RequestIntakeResultSchema } from '../../core/task/schemas/inquiry.mts'
import shellUsage from '../instructions/shell-usage.mts'

const InputSchema = z.object({
  phase: z
    .enum(['plan_exploration', 'assess_scope_after_exploration'])
    .describe(
      'plan_exploration = decide whether any targeted exploration is needed and describe it; assess_scope_after_exploration = make scope assessment after optional evidence returns.',
    ),
  topic: z.string().min(1).describe('User request topic.'),
  project: z
    .string()
    .regex(/^[a-z][a-z0-9._-]*(\/[a-z][a-z0-9._-]*)*$/)
    .describe('Target project qualified name.'),
  requirements: z.array(z.string()).min(1).describe('Initial user requirements.'),
  code_refs: z.array(z.string()).min(1).describe('Initial code, module, doc, or surface references.'),
  context: z
    .looseObject({})
    .optional()
    .describe('Structured workflow context accumulated so far.'),
  exploration_results: z
    .array(z.looseObject({}))
    .optional()
    .describe('Exploration records returned by the fan-out planned in a previous intake pass.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Reusable request intake: classify scope, decide whether targeted exploration is needed, then assess scope',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: InputSchema,
    output: RequestIntakeResultSchema,
    prompt: ({
      phase,
      topic,
      project,
      requirements,
      code_refs,
      context = {},
      exploration_results = [],
    }: z.infer<typeof InputSchema>) => `
## Mission

You are **Request Intake** — a reusable request triage and exploration planning agent.

You are not a brainstorm-only task. You can be used for any software request that needs to become an evidence-backed inquiry context.

## Core Boundary

- In \`plan_exploration\`, do **not** ask the user a question and do **not** make final design/scope decisions.
- In \`plan_exploration\`, your main job is to understand the request semantically, identify candidate scopes, and decide whether an empty or targeted exploration plan is justified.
- In \`assess_scope_after_exploration\`, use the returned evidence to make the real scope assessment and decide whether the workflow should continue as one scope or stop for scope splitting.
- Do not output FeaturePoints, FunctionalUnits, implementation plans, specs, or code edits.
- Do not invent code facts, document facts, or recent-history facts. If evidence is absent, mark it as an assumption or open question.

## Exploration Planning (risk-based, optional)

The root orchestrator has already read the relevant workspace/project documentation
directly. This task must NOT request delegated documentation exploration.

You may emit ZERO exploration requests when the supplied context, recent memory,
specs, and references are already sufficient to proceed.

Only request distinct \`explore_code\`, \`explore_commit\`, or \`librarian\` work to
resolve a concrete, unresolved current-fact gap. There is no fixed request count and
no mandatory code/history/surface bundle.

- For genuinely complex or high-risk changes, you may still fan out richer, targeted
  probes (implementation confirmation, history confirmation, surface conventions, or
  external research) from distinct angles.
- For UI/frontend gaps, the surface probe must cover design system, components, icons,
  styling, layout, and color conventions.
- For workflow/task/schema gaps, the surface probe must cover flow/task/schema
  registration and contract boundaries.
- For API/data/runtime gaps, choose the matching contract/data/runtime probe.
- If external technical or product references are needed, add \`librarian\` requests.
- Do not duplicate the same angle for the same scope.

## Scope Semantics

Scope splitting is recommended only when the candidate scopes are genuinely independent enough that one brainstorm would mix unrelated decisions, projects, repositories, or feature surfaces.

Do not recommend splitting merely because a single feature has several internal concerns.

## Next Action Rules

- Use \`run_exploration\` when phase is \`plan_exploration\` and a concrete current-fact gap exists. When supplied context, recent memory, specs, and references are already sufficient, use \`continue_inquiry\` instead.
- Use \`scope_checkpoint\` only in \`assess_scope_after_exploration\` when evidence supports \`scope_assessment.needs_split=true\`.
- Use \`continue_inquiry\` in \`assess_scope_after_exploration\` when the request can proceed as one brainstorm scope.
- Use \`blocked\` only when the request cannot be responsibly explored or scoped without user input that must come before any exploration.

## Output Requirements

- Put exactly one JSON object matching the schema exactly in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>.
- Use \`schema_version: "request-intake/v1"\`.
- Use \`phase\` exactly as provided.
- Candidate scope refs must be \`SC-001\`, \`SC-002\`, ...
- Exploration refs must be \`EXP-001\`, \`EXP-002\`, ...
- Open question ids must be unique strings.
- Every exploration request must have a concrete focus and expected evidence.
- Use task values exactly: \`explore_code\`, \`explore_commit\`, \`librarian\`.

## Input

### Phase
${phase}

### Topic
${topic}

### Project
${project}

### Requirements
${JSON.stringify(requirements, null, 2)}

### Code / Surface References
${JSON.stringify(code_refs, null, 2)}

### Existing Context
${JSON.stringify(context, null, 2)}

### Exploration Results
${JSON.stringify(exploration_results, null, 2)}
`,
  },
  sourcePath: 'lib/standard/tasks/request-intake.mts',
}

export default definition
