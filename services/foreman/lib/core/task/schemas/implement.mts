import { z } from 'zod'
import {
  type Ref,
  AssessmentSchema,
  EvidenceSchema,
} from '../concepts.mts'
import {
  type FeaturePointRef,
  FeaturePointRefSchema,
} from './feature-point.mts'
import {
  type FunctionalUnitRef,
  FunctionalUnitRefSchema,
} from './functional-unit.mts'
import {
  type ImplementationUnitRef,
  ImplementationUnitRefSchema,
} from './implementation-unit.mts'
import { CommitInfoSchema } from './commit.mts'
import { withExtensions } from './json-schema-extensions.mts'

/**
 * Implement protocol schemas (Zod 4).
 *
 * New source-of-truth for the legacy `implement.schema.json` protocol.
 * Preserves every legacy required field, enum, pattern, `additionalProperties:
 * false`, and nested-array invariant. Shared-concept remaps (fixed Batch
 * mapping):
 *
 *   - `FeaturePointRef`       -> `Ref<T>` patterned string   `^FP-[0-9]{3,}$`
 *   - `FunctionalUnitRef`     -> `Ref<T>` patterned string   `^FU-[0-9]{3,}$`
 *   - `ImplementationUnitRef` -> `Ref<T>` patterned string   `^IU-[0-9]{3,}$`
 *   - `VerificationResult`    -> common `AssessmentSchema`    { criterion_id,
 *                               status, evidences, reason } plus the referenced
 *                               `Evidence` pool carried by the FunctionalUnitReport
 *   - `CommitInfo`            -> reused verbatim from `commit.mts`
 *                               (hash `^[0-9a-f]{7,40}$`, message, stats)
 *
 * Retained implement-domain structures: `ImplementOutput`, `ImplementReport`,
 * `FunctionalUnitReport`, `ImplementationUnitReport`, and
 * `ImplementReviewAttempt`. The review `issues` array keeps the legacy
 * `additionalProperties: true` open-object items (zod has no native
 * open-object array item, restored via `withExtensions`).
 */

// ─── Legacy *Ref remaps (Ref<T> patterned strings) ─────────────────

export type { FeaturePointRef }
export { FeaturePointRefSchema }
export type { FunctionalUnitRef }
export { FunctionalUnitRefSchema }
export type { ImplementationUnitRef }
export { ImplementationUnitRefSchema }

// ─── ImplementationUnitReport (retained domain structure) ──────────

export const ImplementationUnitReportSchema = z.object({
  ref: ImplementationUnitRefSchema,
  title: z.string(),
  status: z.enum(['completed', 'failed']),
})
export type ImplementationUnitReport = z.infer<typeof ImplementationUnitReportSchema>

// ─── ImplementReviewAttempt (retained domain structure) ────────────
//
// `issues` items are open objects (`additionalProperties: true`) carrying
// arbitrary review observations; the legacy `true` is restored on the
// converted node (see `REVIEW_EXT` below).

export const ImplementReviewAttemptSchema = z.object({
  issues: z.array(z.looseObject({}).meta({ additionalProperties: true })),
  status: z.enum(['approved', 'failed']),
})
export type ImplementReviewAttempt = z.infer<typeof ImplementReviewAttemptSchema>

// ─── FunctionalUnitReport (retained domain structure) ─────────────
//
// `verification_results` -> common `AssessmentSchema` (replaces the legacy
// `VerificationResult`); the referenced `Evidence` pool is carried in
// `evidence` so assessments can resolve their `evidences` refs.

export const FunctionalUnitReportSchema = z.object({
  ref: FunctionalUnitRefSchema,
  title: z.string(),
  status: z.enum(['completed', 'failed']),
  implementation_units: z.array(ImplementationUnitReportSchema),
  verification_results: z.array(AssessmentSchema),
  evidence: z.array(EvidenceSchema),
  review: z.array(ImplementReviewAttemptSchema),
  commits: z.array(CommitInfoSchema),
  change_summary: z.string(),
})
export type FunctionalUnitReport = z.infer<typeof FunctionalUnitReportSchema>

// ─── ImplementReport (retained domain structure) ──────────────────

export const ImplementReportSchema = z.object({
  status: z.enum(['completed', 'failed']),
  feature_point_ref: FeaturePointRefSchema,
  functional_units: z.array(FunctionalUnitReportSchema),
})
export type ImplementReport = z.infer<typeof ImplementReportSchema>

// ─── ImplementOutput (top) ────────────────────────────────────────

export const ImplementOutputSchema = z.object({
  report: ImplementReportSchema,
})
export type ImplementOutput = z.infer<typeof ImplementOutputSchema>

// ─── draft-07 extension fragments (restored after toJSONSchema) ────

// Review `issues` items keep the legacy `additionalProperties: true` (open
// object) — zod has no native open-object array item.
const REVIEW_EXT = {
  properties: {
    issues: { items: { additionalProperties: true } },
  },
} as Record<string, unknown>

/** Strip root-only keywords before inlining a sub-schema node. */
function stripRoot(node: Record<string, unknown>): Record<string, unknown> {
  delete node.$schema
  delete node.$id
  return node
}

/**
 * Convert the ImplementOutput schema to a self-contained draft-07 JSON Schema.
 *
 * All FP/FU/IU snapshots, the `AssessmentSchema`/`EvidenceSchema` pair, and
 * `CommitInfo` are inlined from their Zod sources. The only draft-07 construct
 * zod cannot express natively here — `additionalProperties: true` on the
 * review `issues` items — is restored from `ImplementReviewAttemptSchema`.
 */
export function implementToJSONSchema(): Record<string, unknown> {
  const json = withExtensions(ImplementOutputSchema, {}) as Record<string, unknown>

  // Restore `additionalProperties: true` on the review attempt `issues` items.
  const reviewJson = stripRoot(
    withExtensions(ImplementReviewAttemptSchema, REVIEW_EXT) as Record<string, unknown>,
  )
  const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
  const fuArray = (report.properties as Record<string, unknown>)
    .functional_units as Record<string, unknown>
  const fuNode = fuArray.items as Record<string, unknown>
  const reviewArray = (fuNode.properties as Record<string, unknown>)
    .review as Record<string, unknown>
  reviewArray.items = reviewJson

  return json
}
