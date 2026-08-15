import { z } from 'zod'
import { ImplementationPlanSchema } from '../../core/task/schemas/implementation-plan.mts'
import { FunctionalUnitSetSchema } from '../../core/task/schemas/functional-unit.mts'
import shellUsage from '../instructions/shell-usage.mts'

const planReviewIssueSchema = z.object({
  check_id: z.enum([
    'feature_point_mismatch',
    'functional_unit_missing',
    'implementation_unit_missing',
    'trace_invalid',
    'required_context_missing',
    'edit_instruction_missing',
    'verification_request_missing',
    'dependency_order_invalid',
    'fu_commit_boundary_missing',
    'unconfirmed_scope_added',
  ]),
  problem: z.string().min(1),
  required_change: z.string().min(1),
  refs: z
    .array(z.string().regex(/^(FP|FU|IU)-[0-9]{3,}$/))
    .min(1)
    .meta({ uniqueItems: true })
    .describe('Affected FP/FU/IU refs.'),
})

const planReviewResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('plan').describe('Review kind.'),
      status: z.literal('approved'),
      issues: z
        .array(planReviewIssueSchema)
        .max(0)
        .describe('Must-fix checklist hits; each includes a non-empty unique refs array.'),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('plan').describe('Review kind.'),
      status: z.literal('changes_required'),
      issues: z
        .array(planReviewIssueSchema)
        .min(1)
        .describe('Must-fix checklist hits; each includes a non-empty unique refs array.'),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('plan').describe('Review kind.'),
      status: z.literal('blocked'),
      issues: z
        .array(planReviewIssueSchema)
        .max(0)
        .describe('Must-fix checklist hits; each includes a non-empty unique refs array.'),
      summary: z.string().min(1),
    })
    .strict(),
])

const InputSchema = z.object({
  implementation_plan: ImplementationPlanSchema.describe(
    'Structured ImplementationPlan to review.',
  ),
  functional_unit_set: FunctionalUnitSetSchema.optional().describe(
    'Optional confirmed FunctionalUnitSet. When provided, review exact FU coverage.',
  ),
  context: z
    .string()
    .optional()
    .describe('Optional orchestration context, known constraints, or scope notes.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Implementation plan review — verify one-FP/FU-node plan coverage, edit/test traceability, and implement workflow readiness',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: InputSchema,
    output: planReviewResultSchema,
    prompt: ({ implementation_plan, functional_unit_set = undefined, context = '' }: z.infer<typeof InputSchema>) => `
You are **Implementation Plan Reviewer** — a contract gate between architect output and implement workflow execution.

## Mission
Review one structured \`ImplementationPlan\` for execution readiness. Report only verified must-fix checklist hits. Do not report coverage summaries, optional recommendations, generalized ambiguity/sequencing findings, or severity.

This is not a code review, not an architecture review, and not a spec review. Your job is to decide whether the plan is a faithful, traceable, executable package for exactly one FeaturePoint.

## Review Checklist (report only verified hits)
- \`feature_point_mismatch\`: the plan does not implement exactly one FeaturePoint, or \`source.feature_point_ref\` does not match \`feature_point.ref\`.
- \`functional_unit_missing\`: a confirmed FunctionalUnit for this FeaturePoint is absent from \`functional_units[]\` (when FunctionalUnitSet is provided and context does not defer it).
- \`implementation_unit_missing\`: a FunctionalUnit node lacks at least one executable ImplementationUnit, or an executable ImplementationUnit lacks status=ready.
- \`trace_invalid\`: an \`edit\` or \`verification\` does not trace to the ImplementationUnit and parent FunctionalUnit, or an IU ref is invalid/undeclared in this plan.
- \`required_context_missing\`: the plan depends on context (decisions, docs, code) that is absent and not supplied, so implement cannot proceed.
- \`edit_instruction_missing\`: an executable ImplementationUnit lacks an \`edit\` record directly consumable by the workspace edit task (each edit is a Change with \`target\`, \`action\`, \`instruction\`, \`expected\`).
- \`verification_request_missing\`: a FunctionalUnit node lacks FU-level \`verification\` (AcceptanceCriterion records) consumable by the workspace test task.
- \`dependency_order_invalid\`: \`depends_on\` references a ref outside the same FunctionalUnit node, or creates a cycle.
- \`fu_commit_boundary_missing\`: commit strategy is not \`commit_per_functional_unit\`.
- \`unconfirmed_scope_added\`: the plan introduces behavior outside the included FP/FU/IU contracts, or moves end-to-end acceptance, deployment, push, or user validation into implement.

## Issue Contract
Every must-fix issue must include \`check_id\`, \`problem\`, \`required_change\`, and \`refs\` (a non-empty unique array of affected FP/FU/IU refs). Do not include category or severity fields.

## Status Rules
- \`approved\`: the plan passes every checklist item. \`issues\` must be empty.
- \`changes_required\`: at least one verified checklist hit the orchestrator can fix from the provided FP/FU/IU context. \`issues\` must be non-empty.
- \`blocked\`: the plan cannot be repaired because required upstream FU/IU evidence or user/product input is missing. \`issues\` must be empty.

## ImplementationPlan
${JSON.stringify(implementation_plan, null, 2)}

## FunctionalUnitSet
${functional_unit_set ? JSON.stringify(functional_unit_set, null, 2) : '(not provided)'}

${context ? `## Context\n${context}` : ''}

## Output Format
Put exactly one JSON object matching this schema in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>.

\`\`\`json
{
  "kind": "plan",
  "status": "changes_required",
  "issues": [
    {
      "check_id": "implementation_unit_missing",
      "problem": "A FunctionalUnit node lacks an executable ImplementationUnit.",
      "required_change": "Add an executable ImplementationUnit with status=ready to the node.",
      "refs": ["FU-001", "IU-001"]
    }
  ],
  "summary": "The plan is missing executable ImplementationUnits for one FunctionalUnit node."
}
\`\`\`
`,
  },
  sourcePath: 'lib/standard/tasks/plan-review.mts',
}

export default definition
