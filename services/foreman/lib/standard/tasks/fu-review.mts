import { z } from 'zod'
import {
  FunctionalUnitSetSchema,
  FunctionalUnitReviewResultSchema,
} from '../../core/task/schemas/functional-unit.mts'
import shellUsage from '../instructions/shell-usage.mts'

const inputSchema = z.object({
  functional_unit_set: FunctionalUnitSetSchema.describe('FunctionalUnitSet to review.'),
  context: z
    .looseObject({})
    .optional()
    .describe('Complete structured brainstorm context used to produce the unit set.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Review FunctionalUnitSet contract completeness and implementation-batch readiness before user confirmation',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: inputSchema,
    output: FunctionalUnitReviewResultSchema,
    prompt: ({ functional_unit_set, context = {} }: z.infer<typeof inputSchema>) => `
You are **Functional Unit Reviewer** — a requirements decomposition gate for the FunctionalUnitSet.

## Mission
Review the FunctionalUnitSet before it is shown to the user checkpoint. Report only verified must-fix checklist hits. Do not report generalized critique, optional quality improvements, severity, category opinions, or suggestions.

This is not architecture review and not implementation planning. Review whether each FunctionalUnit is a design-complete functional contract unit that can be handed directly to architect + implement without more product/protocol/data decisions.

Architect may decide internal code organization, module/class/function boundaries, object lifecycle, reuse strategy, error propagation mechanics, concurrency implementation, and test layering. Architect must not decide API/tool names, route paths, stream keys, collection names, payload fields, lifecycle states, defaults, filters, result shapes, config names, observability signals, or acceptance semantics — those are product decisions fixed upstream.

## Review Checklist (report only verified hits)
- \`selected_fp_uncovered\`: a selected FeaturePoint from the source set is not represented by any FunctionalUnit.
- \`fp_contract_uncovered\`: a FeaturePoint design_contract is not covered by any FunctionalUnit contract.
- \`fu_contract_shape_incomplete\`: a FunctionalUnit contract exists but omits required names, fields, states, defaults, errors, filters, route/tool/stream/config identifiers, or result semantics.
- \`fu_acceptance_missing\`: a FunctionalUnit lacks observable acceptance criteria.
- \`implementation_anchor_missing\`: a FunctionalUnit has no credible project/module/code anchor.
- \`architect_decision_leak\`: a FunctionalUnit leaves product/protocol/data/config/API/tool decisions for architect or implementation.
- \`blocking_open_question\`: a required user/product decision is still open and blocks confirmation.
- \`dependency_conflict\`: a dependency, ordering, or conflict relation is inconsistent.
- \`unconfirmed_scope_added\`: a FunctionalUnit adds behavior not backed by the FeaturePoints or brainstorm context.
- \`fu_not_independent_batch\`: a FunctionalUnit is not a single independently implementable batch or hides multiple independent behavior changes.

## Issue Contract
Every must-fix issue must include \`target_ref\` (a \`FP-\` or \`FU-\` ref), \`check_id\`, \`problem\`, and \`required_change\`. Do not include severity, category, or suggestion fields.

## Status Rules
- \`approved\`: every FunctionalUnit passes every checklist item. \`issues\` must be empty.
- \`changes_required\`: at least one verified checklist hit the breakdown agent can repair from existing FeaturePoint design_contracts and context. \`issues\` must be non-empty.
- \`blocked\`: the FunctionalUnitSet is missing, conflicting, or unreviewable because required upstream input (FeaturePointSet, decisions, or context) is absent. \`issues\` must be empty.

## FunctionalUnitSet
${JSON.stringify(functional_unit_set, null, 2)}

## Brainstorm Context
${JSON.stringify(context, null, 2)}

## Output Example
\`\`\`json
{
  "kind": "fu",
  "status": "changes_required",
  "issues": [
    {
      "target_ref": "FU-001",
      "check_id": "fu_contract_shape_incomplete",
      "problem": "A FunctionalUnit contract omits required names, fields, states, defaults, errors, filters, route/tool/stream/config identifiers, or result semantics.",
      "required_change": "Add the missing contract names, fields, states, defaults, errors, filters, identifiers, and result semantics to the FunctionalUnit contract."
    }
  ],
  "summary": "The FunctionalUnitSet has contract-shape gaps that must be fixed before confirmation."
}
\`\`\`
`,
  },
  sourcePath: 'lib/standard/tasks/fu-review.mts',
}

export default definition
