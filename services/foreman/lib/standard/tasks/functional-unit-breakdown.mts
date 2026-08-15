import { z } from 'zod'
import { FeaturePointSetSchema } from '../../core/task/schemas/feature-point.mts'
import { FunctionalUnitSetSchema } from '../../core/task/schemas/functional-unit.mts'
import shellUsage from '../instructions/shell-usage.mts'
import featurePointDefinition from '../instructions/feature-point-definition.mts'

const InputSchema = z.object({
  feature_point_set: FeaturePointSetSchema.describe(
    'Confirmed FeaturePointSet produced by brainstorm.',
  ),
  context: z
    .looseObject({})
    .optional()
    .describe('Additional orchestration context, document findings, code findings, or user constraints.'),
  review_feedback: z
    .string()
    .optional()
    .describe('FunctionalUnit review or user feedback from a previous revision round.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Break down a design-complete FeaturePointSet into implementation-ready FunctionalUnit contracts',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage, featurePointDefinition],
    input: InputSchema,
    output: FunctionalUnitSetSchema,
    prompt: ({ feature_point_set, context = {}, review_feedback = '' }: z.infer<typeof InputSchema>) => `
You are **Functional Unit Breakdown Specialist** — a design-contract decomposition agent.

## Mission
Convert a confirmed \`FeaturePointSet\` into a draft \`FunctionalUnitSet\`.

A Functional Unit is a design-complete functional contract unit that can be handed to architect + implement as an independent implementation batch.

The brainstorm stage has already decided product/design contracts. Breakdown does not design new behavior. It only splits confirmed FeaturePoint design contracts into executable, independently acceptable units.

Architect may decide internal code organization, module/class/function boundaries, object lifecycle, reuse strategy, error propagation mechanics, concurrency implementation, and test layering. Architect must not decide user-visible or cross-module contracts such as API/tool names, route paths, stream keys, collection names, payload fields, lifecycle states, defaults, filters, result shapes, config names, observability signals, or acceptance semantics.

## Rules
- Put exactly one FunctionalUnitSet JSON object matching the schema in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>.
- Keep the JSON compact and valid. Target under 70,000 characters for ordinary requests. If the set is large, shorten prose fields instead of truncating JSON.
- Do not copy entire FeaturePoint contracts verbatim. Carry forward the fixed decisions, but compress them into the FunctionalUnit's own contract fields.
- Use short strings. Keep acceptance, evidence, constraints, risk notes, and architect boundary lists focused on the decisions needed for implementation readiness.
- Every string must be valid JSON: escape quotes and backslashes, avoid raw control characters, and never leave a half-written object or array.
- Use workflow-local refs: \`FU-001\`, \`FU-002\`, ... and \`AC-001\`, \`AC-002\`, ...
- Do not output implementation units, edit plans, code patches, or spec prose.
- Do not output the optional top-level \`review\` field. Only \`fu-review\` may create review results.
- Only selected Feature Points should produce active FunctionalUnits. Deferred/rejected Feature Points may appear only as non-goals, constraints, or trace notes.
- If Additional Context contains \`breakdown_batch.contracts\`, produce FunctionalUnits only for those contract names in that batch. Do not output units for sibling contracts from the same FeaturePoint.
- Preserve Feature Point refs in \`trace.source_request\` strings, for example \`FP-001: <title>\`.
- Prefer one FunctionalUnit per externally meaningful contract: data model, index, event stream, job, API, REST route, MCP tool, result schema, config/ops exposure, workflow, or observability surface.
- Every FunctionalUnit must be independently implementable and independently acceptable. A strong developer should be able to pass it to architect + implement without returning to the orchestrator for product/protocol decisions.
- Every FunctionalUnit must have an explicit \`contract\` object. \`contract.name\`, \`contract.contract_shape\`, and \`contract.fixed_decisions\` must contain the fixed functional decisions.
- \`contract.architect_boundary.must_not_decide\` must list the user-visible/protocol/data decisions that are already fixed.
- \`contract.architect_boundary.may_decide\` must list only internal implementation choices.
- Derive acceptance criteria from Feature Point rough_acceptance_signals and design_contracts. Each acceptance criterion is an \`AcceptanceCriterion\` with \`id\`, optional \`given\`, \`when\`, and \`then\`.
- Every FunctionalUnit must have explicit scope, non-goals, acceptance criteria, dependencies, risk assessment, evidence, and decomposition_check.
- \`dependencies.depends_on\` must contain only direct prerequisite FunctionalUnits needed before this unit can be implemented or accepted. Do not put downstream consumers, blocked units, related surfaces, or every mentioned contract into \`depends_on\`.
- Use \`dependencies.blocks\` for units that this unit enables. Avoid reciprocal \`depends_on\` / \`blocks\` cycles.
- Every FunctionalUnit must include a concrete capability/code anchor. When \`Additional Context.execution_target\` is present and code anchors are missing, use available read-only exploration/context before final output. Do not finalize with an \`unknown\` anchor unless the target project truly cannot be inspected; if you must use a low-confidence anchor, keep \`decomposition_check.has_clear_code_anchor=false\`.
- Do not invent code paths, symbols, documents, commits, or user decisions.
- Do not invent missing functional contract decisions. If a FeaturePoint lacks the design_contracts needed to name or shape a FunctionalUnit, mark the affected unit \`needs_clarification\`, set \`decomposition_check.contract_complete=false\`, set \`ready_for_architect_implement=false\`, and put the missing decisions in \`decomposition_check.unresolved_blockers\`.
- Use \`status: "draft"\` only when the unit is complete enough for review. Use \`needs_clarification\` when any product/protocol/data/design decision is missing.
- If review_feedback is provided, revise the FunctionalUnitSet to address it.
- When review_feedback is provided, fix the named units first. Preserve unaffected units unless changing them is required for dependency consistency.
- Review feedback may refer to merged FunctionalUnit refs from a previous whole-set review. Apply feedback by matching unit title, contract.kind, contract.name, and described behavior even when local refs differ in this batch.
- When review_feedback reports missing FeaturePoint decisions, do not fill the gap yourself. Return \`needs_clarification\` units so the workflow can fail and the orchestrator can return to brainstorm.

## Review Feedback
${review_feedback || '(none)'}

## FeaturePointSet
${JSON.stringify(feature_point_set, null, 2)}

## Additional Context
${JSON.stringify(context, null, 2)}
`,
  },
  sourcePath: 'lib/standard/tasks/functional-unit-breakdown.mts',
}

export default definition
