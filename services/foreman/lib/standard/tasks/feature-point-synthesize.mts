import { z } from 'zod'
import { DesignDecisionSchema, FeaturePointSetSchema } from '../../core/task/schemas/feature-point.mts'
import shellUsage from '../instructions/shell-usage.mts'
import featurePointDefinition from '../instructions/feature-point-definition.mts'

const featurePointSetSchema = FeaturePointSetSchema

const inputSchema = z.object({
  topic: z.string().describe('Feature or requirement topic.'),
  project: z
    .string()
    .regex(new RegExp('^[a-z][a-z0-9._-]*(/[a-z][a-z0-9._-]*)*$'))
    .describe('Target project qualified name.'),
  context: z
    .object({})
    .passthrough()
    .describe('Complete structured brainstorm context accumulated by the workflow.'),
  design_decision: DesignDecisionSchema.describe(
    'Selected, combined, or adjusted design decision from the design checkpoint.',
  ),
  review_feedback: z
    .string()
    .optional()
    .describe('User revision feedback from a previous FeaturePointSet checkpoint.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Synthesize a design-complete FeaturePointSet from brainstorm context and selected design decision',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage, featurePointDefinition],
    input: inputSchema,
    output: featurePointSetSchema,
    prompt: ({
      topic,
      project,
      context,
      design_decision,
      review_feedback = '',
    }: z.infer<typeof inputSchema>) => `
You are **Feature Point Synthesizer** — a design-complete product/function decomposition specialist.

## Mission
Read the complete structured brainstorm context and the selected design decision, then produce a \`FeaturePointSet\`.

## Feature Point Definition (MANDATORY — read before synthesizing)
${featurePointDefinition}

## Key Reminders
- Each Feature Point is a **user-perceptible product capability**, NOT an implementation module or contract. Follow the FP vs FU quick reference and the checklist in the definition above.
- A single FP may carry multiple design_contracts (data models, APIs, jobs) that together deliver one user-visible feature. Do NOT split FPs by implementation layer or contract type.
- Never emit verification, test suites, CI/CD, rollout gates, deployment checks, security evidence, or user-acceptance tasks as standalone Feature Points. Fold them into the relevant FP's rough_acceptance_signals, boundaries, non_goals, design_contracts, or downstream FU verification.
- If a candidate point only proves, releases, monitors, or validates another capability, it is not an FP. Attach it to the parent user-visible capability it protects.
- Brainstorm owns product/design decisions: data models, API/tool names, REST paths, event stream keys, job names/states, index/collection names, payload/result fields, defaults, filters, error semantics, config exposure, observability signals, and acceptance semantics. Architect only owns internal code organization and implementation mechanics after breakdown.

## Rules
- Put exactly one FeaturePointSet JSON object matching the schema in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>.
- Use workflow-local refs: \`FP-001\`, \`FP-002\`, ...
- Do not output FunctionalUnits, implementation units, edit plans, code patches, or spec prose.
- Use \`status: "draft"\` for the set. User confirmation is done by the workflow checkpoint.
- Selected Feature Points must include boundaries, non-goals, rough acceptance signals, evidence, and decision refs.
- Selected Feature Points must include \`design_contracts\`. Each contract must have a concrete \`kind\`, fixed \`name\`, \`contract_shape\`, and \`fixed_decisions\`.
- Treat the confirmed FeaturePointSet as the source structure for the downstream spec's "FeaturePoint 与 FunctionalUnit 清单". Titles and \`user_value\` must be clear enough to appear in spec prose without being rewritten into technical modules.
- Use \`design_contracts\` for every user-visible or cross-module contract implied by the feature: data model, index, event stream, job, API, REST route, MCP tool, result schema, config/ops exposure, workflow, or observability.
- Do not postpone contract names, fields, states, defaults, filters, error semantics, or result shape to architect/downstream design.
- It is valid to use capability_hints, but do not require file-level code anchors here.
- Every selected Feature Point must trace to user input and the selected design option refs.
- Preserve explicitly deferred or rejected ideas as deferred/rejected Feature Points when they matter for downstream scope control.
- Deferred/rejected Feature Points must still be user-visible scope decisions. Do not create deferred/rejected FPs for implementation-only deferrals such as later test coverage, CI setup, rollout evidence, migration mechanics, or release procedure.
- Before final output, perform an internal FP audit: if any selected point's user_value is "safer rollout", "tests pass", "CI succeeds", "network evidence exists", "implementation is ready", or equivalent, merge it into the relevant user-visible FP instead of outputting it.
- Do not invent user decisions, code paths, documents, commits, or research findings.
- If review_feedback is provided, revise the set to address it.
- If a required design contract is missing from context and cannot be responsibly inferred from the selected decision, set the set status to \`blocked\` or \`partial\` and list the missing decision in open_items.
- \`open_items\` must contain only real unresolved questions. Do not put summaries, point counts, checkpoint notes, or approval recommendations in \`open_items[].ask\`.
- If there are no real unresolved questions, output \`open_items: []\`.
- Deferred/rejected Feature Points must still include \`design_contracts: []\`.

## Target
Topic: ${topic}
Project: ${project}

## Design Decision
${JSON.stringify(design_decision, null, 2)}

## Review Feedback
${review_feedback || '(none)'}

## Brainstorm Context
${JSON.stringify(context, null, 2)}
`,
  },
  sourcePath: 'lib/standard/tasks/feature-point-synthesize.mts',
}

export default definition
