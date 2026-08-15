import { z } from 'zod'
import specDocument from '../instructions/spec-document.mts'
import { FeaturePointSetSchema } from '../../core/task/schemas/feature-point.mts'
import { FunctionalUnitSetSchema } from '../../core/task/schemas/functional-unit.mts'

const specReviewIssueSchema = z.object({
  check_id: z.enum([
    'required_section_missing',
    'canonical_fp_fu_map_missing',
    'confirmed_fp_missing',
    'confirmed_fu_missing',
    'fp_fu_parent_mismatch',
    'contract_record_mismatch',
    'unconfirmed_scope_added',
    'supersede_decision_record_missing',
  ]),
  problem: z.string().min(1),
  required_change: z.string().min(1),
  location: z.string().min(1),
})

const specReviewResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('spec').describe('Review kind.'),
      status: z.literal('approved'),
      issues: z
        .array(specReviewIssueSchema)
        .max(0)
        .describe('Must-fix checklist hits; each includes a non-empty location string.'),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('spec').describe('Review kind.'),
      status: z.literal('changes_required'),
      issues: z
        .array(specReviewIssueSchema)
        .min(1)
        .describe('Must-fix checklist hits; each includes a non-empty location string.'),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('spec').describe('Review kind.'),
      status: z.literal('blocked'),
      issues: z
        .array(specReviewIssueSchema)
        .max(0)
        .describe('Must-fix checklist hits; each includes a non-empty location string.'),
      summary: z.string().min(1),
    })
    .strict(),
])

const InputSchema = z.object({
  spec_content: z.string().min(1).describe('The full spec document content to review'),
  full_context: z.string().min(1).describe('Complete brainstorm context for reference'),
  feature_point_set: FeaturePointSetSchema.optional().describe(
    'Optional confirmed FeaturePointSet that the spec must represent in the FP/FU structure.',
  ),
  functional_unit_set: FunctionalUnitSetSchema.optional().describe(
    'Optional confirmed FunctionalUnitSet that the spec must cover exactly.',
  ),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Spec review — check document format, canonical FP/FU structure, and coverage of confirmed FeaturePoints/FunctionalUnits',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    input: InputSchema,
    output: specReviewResultSchema,
    prompt: ({ spec_content, full_context, feature_point_set = undefined, functional_unit_set = undefined }: z.infer<typeof InputSchema>) => `
You are **Spec Reviewer**.

## Mission
Check the spec document format, canonical FP/FU structure, and coverage of the confirmed FeaturePointSet / FunctionalUnitSet. Report only verified must-fix checklist hits. Do not report severity, suggestions, edge-case advice, ambiguity critique, over-engineering opinions, or optional improvements.

FeaturePoint synthesis and FunctionalUnit decomposition are handled upstream by brainstorm and breakdown. Do not invent new requirements here. Your job is to check whether the spec faithfully documents the confirmed FP/FU set and follows the workspace spec format.

${specDocument}

## Review Checklist (report only verified hits)
- \`required_section_missing\`: the spec is missing a required section defined by the spec format.
- \`canonical_fp_fu_map_missing\`: the spec lacks the required canonical FP/FU map section (\`FeaturePoint 与 FunctionalUnit 清单\` or equivalent), or puts FunctionalUnits outside their parent FeaturePoint.
- \`confirmed_fp_missing\`: a confirmed FeaturePoint from the supplied FeaturePointSet is not represented in the FP/FU map as a user-perceptible capability.
- \`confirmed_fu_missing\`: a confirmed FunctionalUnit from the supplied FunctionalUnitSet is not covered by the spec.
- \`fp_fu_parent_mismatch\`: a FunctionalUnit appears under the wrong parent FeaturePoint, or is split/merged/renamed without an explicit decision record.
- \`contract_record_mismatch\`: the spec changes a FunctionalUnit contract name, field, default, state, error semantic, route/tool/stream/config identifier, or result shape versus the supplied FunctionalUnitSet.
- \`unconfirmed_scope_added\`: the spec introduces behavior not present in the FunctionalUnitSet.
- \`supersede_decision_record_missing\`: the spec merges, splits, renames, or supersedes confirmed FP/FU structure without an explicit decision record naming the affected refs and rationale.

## Issue Contract
Every must-fix issue must include \`check_id\`, \`problem\`, \`required_change\`, and a non-empty \`location\` (where in the spec). Do not include category or severity fields.

## Status Rules
- \`approved\`: the spec passes every checklist item. \`issues\` must be empty.
- \`changes_required\`: at least one verified checklist hit the spec author can fix. \`issues\` must be non-empty.
- \`blocked\`: the spec is missing, conflicting, or unreviewable because the required upstream input (FeaturePointSet or FunctionalUnitSet) is absent or unusable. \`issues\` must be empty.

## Input

### Spec Content
${spec_content}

### Full Context
${full_context}

### FeaturePointSet
${feature_point_set ? JSON.stringify(feature_point_set, null, 2) : '(none provided)'}

### FunctionalUnitSet
${functional_unit_set ? JSON.stringify(functional_unit_set, null, 2) : '(none provided)'}

## Output Format
Put exactly one JSON object matching this schema in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>.

\`\`\`json
{
  "kind": "spec",
  "status": "changes_required",
  "issues": [
    {
      "check_id": "confirmed_fu_missing",
      "problem": "A confirmed FunctionalUnit from the supplied FunctionalUnitSet is not covered by the spec.",
      "required_change": "Add the missing FunctionalUnit to the canonical FP/FU map under its parent FeaturePoint.",
      "location": "FeaturePoint 与 FunctionalUnit 清单"
    }
  ],
  "summary": "The spec is missing coverage for one confirmed FunctionalUnit."
}
\`\`\`
`,
  },
  sourcePath: 'lib/standard/tasks/spec-review.mts',
}

export default definition
