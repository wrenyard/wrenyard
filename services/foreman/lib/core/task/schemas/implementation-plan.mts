import { z } from 'zod'
import {
  type Ref,
  ProjectTargetSchema,
  AcceptanceCriterionSchema,
  ChangeSchema,
} from '../concepts.mts'
import {
  FeaturePointSchema,
  type FeaturePointRef,
  FeaturePointRefSchema,
} from './feature-point.mts'
import {
  FunctionalUnitSchema,
  type FunctionalUnitRef,
  FunctionalUnitRefSchema,
} from './functional-unit.mts'
import {
  ImplementationUnitSchema,
  type ImplementationUnitRef,
  ImplementationUnitRefSchema,
} from './implementation-unit.mts'
import { withExtensions } from './json-schema-extensions.mts'

/**
 * Implementation Plan protocol schemas (Zod 4).
 *
 * New source-of-truth for the legacy `implementation-plan.schema.json`
 * protocol. Preserves every legacy required field, enum, pattern,
 * `minLength`, `minItems`, `additionalProperties: false`, and
 * `uniqueItems` invariant. Shared-concept remaps (fixed Batch mapping):
 *
 *   - `ProjectName`          -> `ProjectTarget`              { kind, value }
 *   - `FeaturePointRef`      -> `Ref<T>` patterned string    `^FP-[0-9]{3,}$`
 *   - `FunctionalUnitRef`    -> `Ref<T>` patterned string    `^FU-[0-9]{3,}$`
 *   - `ImplementationUnitRef`-> `Ref<T>` patterned string    `^IU-[0-9]{3,}$`
 *   - `VerificationItem`     -> common `AcceptanceCriterion` { id, when, then }
 *   - `EditInstructionSet` / `EditFileInstruction`
 *                           -> `ChangeSchema` arrays
 *                              (`edit` becomes `z.array(ChangeSchema).min(1)`)
 *
 * Retained plan-domain structures: `PlanSource`, `ImplementationPlan`,
 * `FunctionalUnitExecutionNode`, `ExecutableImplementationUnit`,
 * `CommitStrategy`, and `ExecutionPolicy`. The embedded `feature_point`,
 * `functional_unit`, and `implementation_unit` snapshots reuse the agreed
 * B1/B2 Zod schemas (so their (re)mapped shapes flow through unchanged).
 *
 * The legacy `depends_on.uniqueItems: true` invariant is restored after
 * `z.toJSONSchema` via `withExtensions` (zod has no native `uniqueItems`).
 */

// ─── Legacy *Ref remaps (Ref<T> patterned strings) ─────────────────

export type { FeaturePointRef }
export { FeaturePointRefSchema }
export type { FunctionalUnitRef }
export { FunctionalUnitRefSchema }
export type { ImplementationUnitRef }
export { ImplementationUnitRefSchema }

// ─── PlanSource (retained plan-domain structure) ───────────────────

export const PlanSourceSchema = z.object({
  spec_path: z.string().min(1),
  feature_point_ref: FeaturePointRefSchema,
  feature_point_set_ref: z.string().min(1).optional(),
  functional_unit_set_ref: z.string().min(1),
  architect_run_refs: z.array(z.string().min(1)).optional(),
})
export type PlanSource = z.infer<typeof PlanSourceSchema>

// ─── EditInstructionSet — mapped to ChangeSchema array ─────────────
//
// Legacy `EditInstructionSet` { schema_version, files:[EditFileInstruction] }
// and `EditFileInstruction` { path, action, instruction, ... } collapse into
// a flat list of execution-layer `Change` records: each edit instruction
// becomes a `Change` { target, action, instruction, expected }.

export const EditInstructionSetSchema = z.array(ChangeSchema).min(1)
export type EditInstructionSet = z.infer<typeof EditInstructionSetSchema>

// ─── ExecutableImplementationUnit (retained plan-domain structure) ─

export const ExecutableImplementationUnitSchema = z.object({
  implementation_unit: ImplementationUnitSchema,
  edit: EditInstructionSetSchema,
  depends_on: z.array(ImplementationUnitRefSchema).meta({ uniqueItems: true }),
})
export type ExecutableImplementationUnit = z.infer<typeof ExecutableImplementationUnitSchema>

// ─── FunctionalUnitExecutionNode (retained plan-domain structure) ──

export const FunctionalUnitExecutionNodeSchema = z.object({
  functional_unit: FunctionalUnitSchema,
  implementation_units: z.array(ExecutableImplementationUnitSchema).min(1),
  verification: z.array(AcceptanceCriterionSchema).min(1),
  review_focus: z.array(z.string().min(1)).optional(),
})
export type FunctionalUnitExecutionNode = z.infer<typeof FunctionalUnitExecutionNodeSchema>

// ─── CommitStrategy (retained plan-domain structure) ───────────────

export const CommitStrategySchema = z.object({
  mode: z.enum(['commit_per_functional_unit']),
  message_hint: z.string().min(1),
})
export type CommitStrategy = z.infer<typeof CommitStrategySchema>

// ─── ExecutionPolicy (retained plan-domain structure) ──────────────

export const ExecutionPolicySchema = z.object({
  repair_rounds: z.number().int().min(0).max(2).optional(),
})
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>

// ─── ImplementationPlan (top, retained plan-domain structure) ──────

export const ImplementationPlanSchema = z.object({
  schema_version: z.literal('implementation-plan/v1'),
  status: z.enum(['draft', 'reviewed', 'approved']),
  topic: z.string().min(1),
  project: ProjectTargetSchema,
  source: PlanSourceSchema,
  feature_point: FeaturePointSchema,
  functional_units: z.array(FunctionalUnitExecutionNodeSchema).min(1),
  commit_strategy: CommitStrategySchema,
  execution_policy: ExecutionPolicySchema.optional(),
  notes: z.array(z.string().min(1)).optional(),
})
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>

// ─── draft-07 extension fragments (restored after toJSONSchema) ────

// Executable-unit-level: `depends_on` keeps `uniqueItems: true` (zod has no
// native `uniqueItems`, restored at the base level).
const PLAN_EXEC_UNIT_EXT = {
  properties: {
    depends_on: { uniqueItems: true },
  },
} as Record<string, unknown>

/** Strip root-only keywords before inlining a sub-schema node. */
function stripRoot(node: Record<string, unknown>): Record<string, unknown> {
  delete node.$schema
  delete node.$id
  return node
}

/**
 * Convert the ImplementationPlan schema to a self-contained draft-07 JSON
 * Schema.
 *
 * `feature_point` / `functional_unit` / `implementation_unit` snapshots are
 * inlined from the B1/B2 Zod schemas; `depends_on.uniqueItems` is restored on
 * the executable-unit node (zod cannot express `uniqueItems` natively).
 */
export function implementationPlanToJSONSchema(): Record<string, unknown> {
  const json = withExtensions(ImplementationPlanSchema, {}) as Record<string, unknown>

  // Executable unit node (with depends_on.uniqueItems restored).
  const execUnitJson = stripRoot(
    withExtensions(ExecutableImplementationUnitSchema, PLAN_EXEC_UNIT_EXT) as Record<string, unknown>,
  )

  // FunctionalUnit execution node, wiring the restored executable-unit items.
  const fuNodeJson = stripRoot(
    withExtensions(FunctionalUnitExecutionNodeSchema, {}) as Record<string, unknown>,
  )
  ;(fuNodeJson.properties as Record<string, unknown>).implementation_units = {
    ...(fuNodeJson.properties as Record<string, unknown>).implementation_units as Record<string, unknown>,
    items: execUnitJson,
  }

  // Wire the functional-unit execution node into functional_units.items.
  ;(json.properties as Record<string, unknown>).functional_units = {
    ...(json.properties as Record<string, unknown>).functional_units as Record<string, unknown>,
    items: fuNodeJson,
  }

  return json
}
