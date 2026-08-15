import { z } from 'zod'
import { FeaturePointSetSchema } from '../../core/task/schemas/feature-point.mts'
import shellUsage from '../instructions/shell-usage.mts'
import featurePointDefinition from '../instructions/feature-point-definition.mts'

const featurePointSetSchema = FeaturePointSetSchema

const featurePointReviewIssueSchema = z
  .object({
    point_ref: z
      .string()
      .regex(new RegExp('^FP-[0-9]{3,}$'))
      .optional(),
    contract_name: z.string().min(1).optional(),
    check_id: z.enum([
      'selected_fp_missing_contract',
      'contract_shape_incomplete',
      'architect_decision_leak',
      'blocking_open_question',
      'source_requirement_uncovered',
      'unconfirmed_scope_added',
      'feature_point_not_user_visible',
      'acceptance_signal_not_observable',
    ]),
    problem: z.string().min(1),
    required_change: z.string().min(1),
  })
  .strict()

const featurePointReviewResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('fp'),
      status: z.literal('approved'),
      issues: z.array(featurePointReviewIssueSchema).max(0),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fp'),
      status: z.literal('changes_required'),
      issues: z.array(featurePointReviewIssueSchema).min(1),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fp'),
      status: z.literal('blocked'),
      issues: z.array(featurePointReviewIssueSchema).max(0),
      summary: z.string().min(1),
    })
    .strict(),
])

const inputSchema = z.object({
  feature_point_set: featurePointSetSchema.describe('Draft FeaturePointSet produced by brainstorm.'),
  context: z
    .object({})
    .passthrough()
    .optional()
    .describe('Complete structured brainstorm context.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Review FeaturePointSet design-contract completeness before user confirmation and breakdown',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage, featurePointDefinition],
    input: inputSchema,
    output: featurePointReviewResultSchema,
    prompt: ({ feature_point_set, context = {} }: z.infer<typeof inputSchema>) => `
You are **Feature Point Readiness Reviewer**.

## Mission
Review whether this FeaturePointSet is design-complete enough for breakdown. Report only verified must-fix checklist hits. Do not report severity, optional polish, nits, generic category opinions, evidence-quality ratings, or suggestions.

Brainstorm owns product and design contracts. Breakdown must only split already-decided contracts into FunctionalUnits. If breakdown would need to invent API/tool names, route paths, stream keys, collection names, payload fields, lifecycle states, defaults, filters, result shapes, config names, observability signals, status objects, or acceptance semantics, this FeaturePointSet is not ready.

## Review Checklist (report only verified hits)
- \`selected_fp_missing_contract\`: a selected FeaturePoint has no concrete design_contracts for a user-visible or cross-module behavior it implies.
- \`contract_shape_incomplete\`: a design_contract exists but omits required names, fields, states, defaults, errors, filters, route/tool/stream/config identifiers, or result semantics.
- \`architect_decision_leak\`: a FeaturePoint leaves product/protocol/data/config/API/tool decisions for architect or implementation.
- \`blocking_open_question\`: a required user/product decision is still open and blocks breakdown.
- \`source_requirement_uncovered\`: a selected FeaturePoint does not trace to any supplied user requirement, doc, code, commit, research, or runtime evidence.
- \`unconfirmed_scope_added\`: a FeaturePoint adds behavior not backed by the source requirements or brainstorm context.
- \`feature_point_not_user_visible\`: a selected point is really a Functional Unit, implementation module, verification/CI/rollout/deployment/security-evidence task, or acceptance logistics, not a user-perceptible product capability.
- \`acceptance_signal_not_observable\`: a FeaturePoint lacks acceptance signals that can become concrete FunctionalUnit acceptance criteria.

## Status Rules
- \`approved\`: every selected FeaturePoint passes every checklist item. \`issues\` must be empty.
- \`changes_required\`: at least one verified checklist hit the FeaturePoint synthesizer can fix from existing brainstorm context. \`issues\` must be non-empty.
- \`blocked\`: a missing decision requires user/orchestrator input or more exploration. \`issues\` must be empty.

This is not FunctionalUnit review, architecture review, or implementation planning.

## FeaturePointSet
${JSON.stringify(feature_point_set, null, 2)}

## Brainstorm Context
${JSON.stringify(context, null, 2)}

## Output Example
\`\`\`json
{
  "kind": "fp",
  "status": "changes_required",
  "issues": [
    {
      "point_ref": "FP-001",
      "contract_name": "create_export_task",
      "check_id": "contract_shape_incomplete",
      "problem": "The export tool contract omits the stream key, payload fields, and lifecycle states required for mechanical breakdown.",
      "required_change": "Fix the design_contract for create_export_task to specify the stream key, payload fields, and lifecycle states before breakdown."
    }
  ],
  "summary": "FP-001 is missing concrete contract shape details required for mechanical breakdown."
}
\`\`\`
`,
  },
  sourcePath: 'lib/standard/tasks/fp-review.mts',
}

export default definition
