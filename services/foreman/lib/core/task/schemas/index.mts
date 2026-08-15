export * from './commit.mts'
export * from './review.mts'
export * from './inquiry.mts'
export * from './feature-point.mts'
export * from './functional-unit.mts'
export * from './implementation-unit.mts'
export * from './implementation-plan.mts'
export * from './implement.mts'

import { z } from 'zod'
import { conceptSchemas } from '../concepts.mts'

import {
  CommitChangeSetSchema,
  CommitRequestSchema,
  CommitNumstatRowSchema,
  CommitStatsSchema,
  CommitInfoSchema,
  CommitReportSchema,
} from './commit.mts'
import {
  ReviewKindSchema,
  ReviewStatusSchema,
  ReviewChecklistIssueBaseSchema,
} from './review.mts'
import {
  OrchestratorQuestionSchema,
  CandidateScopeSchema,
  ScopeAssessmentSchema,
  ExplorationRequestSchema,
  ExplorationPlanSchema,
  RequestIntakeResultSchema,
  InquiryStepResultSchema,
} from './inquiry.mts'
import {
  FeaturePointRefSchema,
  AcceptanceCriterionRefSchema,
  DesignOptionRefSchema,
  DecisionRefSchema,
  OpenItemSchema,
  RejectedOptionSchema,
  DesignDecisionSchema,
  DesignContractSchema,
  FeaturePointSchema,
  FeaturePointSetSchema,
} from './feature-point.mts'
import {
  ImplementationUnitRefSchema,
  SymbolRefSchema,
  RiskItemSchema,
  ImplementationScopeSchema,
  ImplementationUnitSchema,
  ImplementationUnitSetSchema,
} from './implementation-unit.mts'
import {
  PlanSourceSchema,
  EditInstructionSetSchema,
  ExecutableImplementationUnitSchema,
  FunctionalUnitExecutionNodeSchema,
  CommitStrategySchema,
  ExecutionPolicySchema,
  ImplementationPlanSchema,
} from './implementation-plan.mts'
import {
  FunctionalUnitRefSchema,
  OpenQuestionSchema,
  CodeAnchorSchema,
  FunctionalContractSchema,
  RiskAssessmentSchema,
  ReviewIssueSchema,
  FunctionalUnitReviewResultSchema,
  FunctionalUnitSchema,
  FunctionalUnitSetSchema,
} from './functional-unit.mts'
import {
  ImplementationUnitReportSchema,
  ImplementReviewAttemptSchema,
  FunctionalUnitReportSchema,
  ImplementReportSchema,
  ImplementOutputSchema,
} from './implement.mts'

/**
 * Canonical, immutable bundle of every Foreman public concept Zod schema
 * and every public domain Zod schema, for consumption by external
 * workspace task/flow definitions without imports.
 *
 * Composed by reference from the existing schema objects — no cloning or
 * serialization. Installed on `globalThis.foremanSchemas` by the daemon
 * runtime-global setup before any external task/flow module is evaluated.
 */
export const foremanSchemas = Object.freeze({
  /** Zod 4 namespace, for defining task-local Zod schemas without imports. */
  z,
  /** General Concepts layer (Target, Goal, Change, Evidence, ...). */
  concepts: conceptSchemas,
  /** Public domain schemas grouped by task domain. */
  domains: Object.freeze({
    commit: Object.freeze({
      CommitChangeSetSchema,
      CommitRequestSchema,
      CommitNumstatRowSchema,
      CommitStatsSchema,
      CommitInfoSchema,
      CommitReportSchema,
    }),
    review: Object.freeze({
      ReviewKindSchema,
      ReviewStatusSchema,
      ReviewChecklistIssueBaseSchema,
    }),
    inquiry: Object.freeze({
      OrchestratorQuestionSchema,
      CandidateScopeSchema,
      ScopeAssessmentSchema,
      ExplorationRequestSchema,
      ExplorationPlanSchema,
      RequestIntakeResultSchema,
      InquiryStepResultSchema,
    }),
    featurePoint: Object.freeze({
      FeaturePointRefSchema,
      AcceptanceCriterionRefSchema,
      DesignOptionRefSchema,
      DecisionRefSchema,
      OpenItemSchema,
      RejectedOptionSchema,
      DesignDecisionSchema,
      DesignContractSchema,
      FeaturePointSchema,
      FeaturePointSetSchema,
    }),
    implementationUnit: Object.freeze({
      ImplementationUnitRefSchema,
      SymbolRefSchema,
      RiskItemSchema,
      ImplementationScopeSchema,
      ImplementationUnitSchema,
      ImplementationUnitSetSchema,
    }),
    implementationPlan: Object.freeze({
      PlanSourceSchema,
      EditInstructionSetSchema,
      ExecutableImplementationUnitSchema,
      FunctionalUnitExecutionNodeSchema,
      CommitStrategySchema,
      ExecutionPolicySchema,
      ImplementationPlanSchema,
    }),
    functionalUnit: Object.freeze({
      FunctionalUnitRefSchema,
      OpenQuestionSchema,
      CodeAnchorSchema,
      FunctionalContractSchema,
      RiskAssessmentSchema,
      ReviewIssueSchema,
      FunctionalUnitReviewResultSchema,
      FunctionalUnitSchema,
      FunctionalUnitSetSchema,
    }),
    implement: Object.freeze({
      ImplementationUnitReportSchema,
      ImplementReviewAttemptSchema,
      FunctionalUnitReportSchema,
      ImplementReportSchema,
      ImplementOutputSchema,
    }),
  }),
})

export type ForemanSchemas = typeof foremanSchemas

/**
 * Post-conversion `uniqueItems` preservation helper.
 *
 * The legacy draft-07 schemas do not currently declare `uniqueItems`, but
 * the contract requires that the zod → draft-07 conversion pipeline be able
 * to preserve `uniqueItems` where it applies, using an explicit
 * post-conversion patch only if required. This helper sets `uniqueItems:
 * true` on the array node located at `path` within a (converted) draft-07
 * JSON Schema, so an AJV validator compiled from it rejects duplicate
 * entries. It is a no-op-safe, deterministic patch.
 *
 * @param json converted draft-07 JSON Schema (mutated in place)
 * @param path dot/array path to the target array node, e.g.
 *             `['properties', 'requirements']`
 * @returns the same `json` for chaining
 */
export function applyUniqueItemsAtPath(
  json: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let node: unknown = json
  for (const key of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return json
    node = (node as Record<string, unknown>)[key]
  }
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    ;(node as Record<string, unknown>).uniqueItems = true
  }
  return json
}
