import { z } from 'zod'
import {
  type Ref,
  type Evidence,
  EvidenceSchema,
  ProjectTargetSchema,
  QuestionSchema,
  TargetBaseSchema,
  AcceptanceCriterionSchema,
} from '../concepts.mts'
import { withExtensions } from './json-schema-extensions.mts'

/**
 * Functional Unit protocol schemas (Zod 4) — Batch B2.
 *
 * New source-of-truth for the legacy `functional-unit.schema.json` protocol.
 * Preserves every legacy required field, enum, pattern, `minLength`,
 * `additionalProperties: false`, `uniqueItems`, `if/then`, `allOf`, and
 * `not/contains` invariant. Shared-concept remaps:
 *
 *   - `ProjectRef`      -> `ProjectTarget`
 *   - `EvidenceRef`     -> `Evidence`
 *   - `ContextEntry`    -> `ctx: string`
 *   - `OpenQuestion`    -> `QuestionSchema` rich extension (+ `options`)
 *   - `CodeAnchor`      -> `Target` variant (kind/value + project/description/
 *                          confidence)
 *   - `AcceptanceCriterion` (FU) -> common Given/When/Then `AcceptanceCriterion`
 *   - `FunctionalUnitRef` -> `Ref<T>` patterned string
 *
 * Retained domain structures: `FunctionalContract` (FU), `RiskAssessment`
 * (Risk/FU), and `FunctionalUnitReviewResult` (its `allOf` conditional is a
 * required invariant).
 */

// ─── FunctionalUnitRef ─────────────────────────────────────────────

export type FunctionalUnitRef = Ref<{ id: string }>
export const FunctionalUnitRefSchema = z.string().regex(/^FU-[0-9]{3,}$/)

// ─── OpenQuestion — QuestionSchema rich extension (FU) ─────────────
//
// `ref` -> `id`, `question` -> `ask`, `blocking` kept, `options` retained.

export const OpenQuestionSchema = QuestionSchema.extend({
  options: z.array(z.string().min(1)).optional(),
})
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>

// ─── CodeAnchor — Target variant ───────────────────────────────────
//
// `kind` constrained to the legacy code-anchor enum, `path`/`symbol` folded
// into the `Target` `value`; `project`/`description`/`confidence` retained.

export const CodeAnchorSchema = TargetBaseSchema.extend({
  kind: z.enum(['file', 'symbol', 'route', 'task', 'workflow', 'module', 'unknown']),
  value: z.string().min(1),
  project: ProjectTargetSchema,
  description: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
})
export type CodeAnchor = z.infer<typeof CodeAnchorSchema>

// ─── FunctionalContract (retained domain structure, FU) ────────────

export const FunctionalContractSchema = z.object({
  kind: z.enum([
    'data_model',
    'index',
    'event_stream',
    'job',
    'api',
    'rest_route',
    'mcp_tool',
    'result_schema',
    'config',
    'ops',
    'observability',
    'workflow',
    'capability',
  ]),
  name: z.string().min(1),
  contract_shape: z.looseObject({}),
  fixed_decisions: z.array(z.string().min(1)).min(1),
  architect_boundary: z.object({
    may_decide: z.array(z.string().min(1)),
    must_not_decide: z.array(z.string().min(1)).min(1),
  }),
})
export type FunctionalContract = z.infer<typeof FunctionalContractSchema>

// ─── RiskAssessment (retained domain structure, Risk/FU) ───────────

export const RiskAssessmentSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  tags: z.array(
    z.enum([
      'cross_cutting',
      'security',
      'migration',
      'compatibility',
      'performance',
      'concurrency',
      'deployment',
      'ux',
      'external_api',
    ]),
  ).meta({ uniqueItems: true }),
  notes: z.array(z.string().min(1)),
})
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>

// ─── FunctionalUnitReviewResult (retained; allOf conditional) ──────

export const ReviewIssueSchema = z.object({
  target_ref: z.string().regex(/^(FP|FU)-[0-9]{3,}$/),
  check_id: z.enum([
    'selected_fp_uncovered',
    'fp_contract_uncovered',
    'fu_contract_shape_incomplete',
    'fu_acceptance_missing',
    'implementation_anchor_missing',
    'architect_decision_leak',
    'blocking_open_question',
    'dependency_conflict',
    'unconfirmed_scope_added',
    'fu_not_independent_batch',
  ]),
  problem: z.string().min(1),
  required_change: z.string().min(1),
})
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>

export const FunctionalUnitReviewResultSchema = z.object({
  kind: z.literal('fu'),
  status: z.enum(['approved', 'changes_required', 'blocked']),
  issues: z.array(ReviewIssueSchema),
  summary: z.string().min(1),
}).meta({
  allOf: [
    {
      if: {
        properties: { status: { enum: ['approved', 'blocked'] } },
        required: ['status'],
      },
      then: { properties: { issues: { maxItems: 0 } } },
    },
    {
      if: { properties: { status: { const: 'changes_required' } }, required: ['status'] },
      then: { properties: { issues: { minItems: 1 } } },
    },
  ],
})
export type FunctionalUnitReviewResult = z.infer<typeof FunctionalUnitReviewResultSchema>

// ─── FunctionalUnit ────────────────────────────────────────────────

export const FunctionalUnitSchema = z.object({
  ref: FunctionalUnitRefSchema,
  title: z.string().min(1).max(120),
  status: z.enum(['draft', 'needs_clarification', 'confirmed', 'rejected', 'deferred']),
  intent: z.object({
    actor: z.string().min(1),
    user_goal: z.string().min(1),
    problem: z.string().min(1),
    target_behavior: z.string().min(1),
  }),
  scope: z.object({
    project: ProjectTargetSchema,
    capability: z.string().min(1),
    surfaces: z.array(
      z.enum(['ui', 'api', 'cli', 'workflow', 'data', 'config', 'infra', 'docs', 'test']),
    ).min(1).meta({ uniqueItems: true }),
    code_anchors: z.array(CodeAnchorSchema),
    non_goals: z.array(z.string().min(1)),
  }),
  contract: FunctionalContractSchema,
  acceptance: z.array(AcceptanceCriterionSchema),
  dependencies: z.object({
    depends_on: z.array(FunctionalUnitRefSchema).meta({ uniqueItems: true }),
    blocks: z.array(FunctionalUnitRefSchema).meta({ uniqueItems: true }),
    conflicts_with: z.array(FunctionalUnitRefSchema).meta({ uniqueItems: true }),
    related: z.array(FunctionalUnitRefSchema).meta({ uniqueItems: true }),
  }),
  evidence: z.array(EvidenceSchema),
  questions: z.array(OpenQuestionSchema),
  constraints: z.array(z.string().min(1)),
  risk: RiskAssessmentSchema,
  decomposition_check: z.object({
    is_atomic: z.boolean(),
    can_be_accepted_independently: z.boolean(),
    has_clear_code_anchor: z.boolean(),
    has_clear_non_goals: z.boolean(),
    contract_complete: z.boolean(),
    ready_for_architect_implement: z.boolean(),
    unresolved_blockers: z.array(z.string().min(1)),
  }),
  trace: z.object({
    source_request: z.array(z.string().min(1)).min(1),
    decisions: z.array(z.string().min(1)),
    supersedes: z.array(FunctionalUnitRefSchema).meta({ uniqueItems: true }).optional(),
  }),
  checkpoint: z
    .object({
      status: z.enum(['pending', 'confirmed', 'rejected', 'deferred']),
      confirmed_by: z.string().min(1),
      confirmed_at: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/),
      notes: z.string(),
    })
    .optional(),
}).meta({
  if: { properties: { status: { const: 'confirmed' } }, required: ['status'] },
  then: {
    required: ['checkpoint'],
    properties: {
      scope: { properties: { code_anchors: { minItems: 1 } } },
      acceptance: { minItems: 1 },
      contract: {
        properties: {
          fixed_decisions: { minItems: 1 },
          architect_boundary: { properties: { must_not_decide: { minItems: 1 } } },
        },
      },
      decomposition_check: {
        properties: {
          is_atomic: { const: true },
          can_be_accepted_independently: { const: true },
          has_clear_code_anchor: { const: true },
          has_clear_non_goals: { const: true },
          contract_complete: { const: true },
          ready_for_architect_implement: { const: true },
          unresolved_blockers: { maxItems: 0 },
        },
      },
      questions: {
        not: {
          contains: {
            type: 'object',
            required: ['blocking'],
            properties: { blocking: { const: true } },
          },
        },
      },
      checkpoint: { properties: { status: { const: 'confirmed' } } },
    },
  },
})
export type FunctionalUnit = z.infer<typeof FunctionalUnitSchema>

// ─── FunctionalUnitSet (top) ───────────────────────────────────────

export const FunctionalUnitSetSchema = z.object({
  schema_version: z.literal('functional-unit/v1'),
  topic: z.string().min(1),
  project: ProjectTargetSchema,
  status: z.enum(['draft', 'needs_clarification', 'confirmed', 'blocked']),
  units: z.array(FunctionalUnitSchema).min(1),
  context_summary: z.object({
    decisions: z.array(z.string().min(1)),
    exploration_findings: z.array(z.string().min(1)),
    open_questions: z.array(OpenQuestionSchema),
  }),
  review: FunctionalUnitReviewResultSchema.optional(),
})
export type FunctionalUnitSet = z.infer<typeof FunctionalUnitSetSchema>

// ─── draft-07 extension fragments (restored after toJSONSchema) ────

// Unit-level: when confirmed, the unit must be fully decomposed & checkpointed.
const FU_UNIT_EXT = {} as Record<string, unknown>

// Review-result-level: approved/blocked => no issues; changes_required => ≥1 issue.
const FU_REVIEW_EXT = {} as Record<string, unknown>

/** Strip root-only keywords before inlining a sub-schema node. */
function stripRoot(node: Record<string, unknown>): Record<string, unknown> {
  delete node.$schema
  delete node.$id
  return node
}

/** Convert the FunctionalUnitSet schema to a draft-07 JSON Schema. */
export function functionalUnitSetToJSONSchema(): Record<string, unknown> {
  const json = withExtensions(FunctionalUnitSetSchema, {}) as Record<string, unknown>
  const unitJson = stripRoot(withExtensions(FunctionalUnitSchema, FU_UNIT_EXT) as Record<string, unknown>)
  ;(json.properties as Record<string, unknown>).units = {
    ...(json.properties as Record<string, unknown>).units as Record<string, unknown>,
    items: unitJson,
  }
  const reviewJson = stripRoot(
    withExtensions(FunctionalUnitReviewResultSchema, FU_REVIEW_EXT) as Record<string, unknown>,
  )
  ;(json.properties as Record<string, unknown>).review = reviewJson
  return json
}
