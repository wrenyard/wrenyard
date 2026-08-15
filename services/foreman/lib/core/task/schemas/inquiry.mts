import { z } from 'zod'
import {
  CandidateSchema,
  type Candidate,
  DecisionSchema,
  type Decision,
  ProjectTargetSchema,
  type ProjectTarget,
  QuestionSchema,
  type Question,
  type Ref,
} from '../concepts.mts'

/**
 * Inquiry protocol schemas (Zod 4).
 *
 * New source-of-truth for the legacy `inquiry.schema.json` protocol. The
 * domain-specific structures (ScopeAssessment, ExplorationPlan,
 * ExplorationRequest, RequestIntakeResult, InquiryStepResult) preserve
 * every legacy required field, enum, pattern, `minLength`, `minItems`,
 * and `additionalProperties: false` behavior.
 *
 * Shared-concept remaps (deleted, not redefined — the legacy
 * `shared.schema.json` is no longer referenced):
 *   - `ProjectRef`  -> `ProjectTarget`  (object { kind: 'project', value })
 *   - `QuestionRef` -> `Ref<Question>`  (plain id string; legacy `^Q-…`
 *                       pattern is intentionally dropped)
 *   - `EvidenceRef` / `ContextEntry` are not referenced by any legacy
 *     inquiry/commit/review schema, so they simply do not appear here.
 *
 * New concepts extending the core concept layer:
 *   - `OrchestratorQuestion` extends `QuestionSchema` with optional
 *     `owner` and `resolution_hint` (the legacy `OpenQuestion`).
 *   - `CandidateScope` extends `CandidateSchema` with `kind: 'scope'` and
 *     the legacy scope fields.
 *   - `decisions` becomes an array of `DecisionSchema`.
 */

// ─── OrchestratorQuestion ──────────────────────────────────────────
//
// Replaces the legacy `OpenQuestion`. `QuestionSchema` supplies
// `id` (= `Ref<Question>`), `ask`, `blocking`. Owner/resolution_hint are
// optional per the contract.

export const OrchestratorQuestionSchema = QuestionSchema.extend({
  owner: z.enum(['user', 'exploration', 'orchestrator']).optional(),
  resolution_hint: z.string().min(1).optional(),
})
export type OrchestratorQuestion = z.infer<typeof OrchestratorQuestionSchema>

// ─── CandidateScope ────────────────────────────────────────────────
//
// Extends `CandidateSchema` ({ id, kind, proposal }) with `kind` pinned to
// the literal `'scope'` plus the legacy scope fields. `project` uses the
// `ProjectTarget` concept (replacing legacy `ProjectRef`).

export const CandidateScopeSchema = CandidateSchema.extend({
  kind: z.literal('scope'),
  ref: z.string().regex(/^SC-[0-9]{3,}$/),
  title: z.string().min(1),
  project: ProjectTargetSchema,
  summary: z.string().min(1),
  independence: z.enum(['single', 'likely_independent', 'uncertain']),
  reason: z.string().min(1),
  requirements: z.array(z.string().min(1)).min(1),
  likely_surfaces: z.array(z.string().min(1)),
})
export type CandidateScope = z.infer<typeof CandidateScopeSchema>

// ─── ScopeAssessment ───────────────────────────────────────────────

export const ScopeAssessmentSchema = z.object({
  readiness: z.enum(['preliminary', 'after_exploration']),
  needs_split: z.boolean(),
  reason: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  independent_scope_count: z.number().min(1),
  suggested_sub_topics: z.array(z.string().min(1)),
  recommended_action: z.enum([
    'run_exploration',
    'ask_scope_question',
    'scope_checkpoint',
    'continue_as_single_scope',
    'blocked',
  ]),
})
export type ScopeAssessment = z.infer<typeof ScopeAssessmentSchema>

// ─── ExplorationRequest ────────────────────────────────────────────

export const ExplorationRequestSchema = z.object({
  ref: z.string().regex(/^EXP-[0-9]{3,}$/),
  task: z.enum(['explore_code', 'explore_commit', 'librarian']),
  scope_ref: z.string().regex(/^SC-[0-9]{3,}$/),
  focus: z.string().min(1),
  reason: z.string().min(1),
  expected_evidence: z.array(z.string().min(1)).min(1),
  requirements: z.array(z.string().min(1)),
  sources: z.string().min(1),
  priority: z.enum(['baseline', 'surface', 'history', 'external', 'follow_up']),
})
export type ExplorationRequest = z.infer<typeof ExplorationRequestSchema>

// ─── ExplorationPlan ───────────────────────────────────────────────

export const ExplorationPlanSchema = z.object({
  strategy: z.string().min(1),
  coverage: z.object({
    doc_baseline: z.boolean(),
    code_baseline: z.boolean(),
    history_baseline: z.boolean(),
    surface_probe: z.boolean(),
    external_research: z.boolean(),
  }),
  requests: z.array(ExplorationRequestSchema),
})
export type ExplorationPlan = z.infer<typeof ExplorationPlanSchema>

// ─── RequestIntakeResult ───────────────────────────────────────────

export const RequestIntakeResultSchema = z.object({
  schema_version: z.literal('request-intake/v1'),
  phase: z.enum(['plan_exploration', 'assess_scope_after_exploration']),
  understanding: z.string().min(1),
  candidate_scopes: z.array(CandidateScopeSchema).min(1),
  scope_assessment: ScopeAssessmentSchema,
  exploration_plan: ExplorationPlanSchema,
  open_questions: z.array(OrchestratorQuestionSchema),
  assumptions: z.array(z.string().min(1)),
  decisions: z.array(DecisionSchema),
  next_action: z.enum(['run_exploration', 'scope_checkpoint', 'continue_inquiry', 'blocked']),
  blocked_reason: z.string().min(1).optional(),
})
export type RequestIntakeResult = z.infer<typeof RequestIntakeResultSchema>

// ─── InquiryStepResult ─────────────────────────────────────────────

export const InquiryStepResultSchema = z.object({
  schema_version: z.literal('inquiry-step/v1'),
  action: z.enum(['ask_question', 'run_exploration', 'converged', 'blocked']),
  question: z.string().min(1).optional(),
  exploration_requests: z.array(ExplorationRequestSchema).optional(),
  scope_assessment: ScopeAssessmentSchema.optional(),
  understanding_update: z.string().min(1).optional(),
  open_questions: z.array(OrchestratorQuestionSchema),
  assumptions: z.array(z.string().min(1)),
  decisions: z.array(DecisionSchema),
  blocked_reason: z.string().min(1).optional(),
})
export type InquiryStepResult = z.infer<typeof InquiryStepResultSchema>

/** Convert a given inquiry schema to a draft-07 JSON Schema. */
export function inquiryToJSONSchema(
  schema:
    | typeof RequestIntakeResultSchema
    | typeof InquiryStepResultSchema
    | typeof CandidateScopeSchema
    | typeof ScopeAssessmentSchema
    | typeof ExplorationPlanSchema
    | typeof ExplorationRequestSchema
    | typeof OrchestratorQuestionSchema,
): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>
}
