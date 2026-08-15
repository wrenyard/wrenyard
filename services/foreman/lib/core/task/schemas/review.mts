import { z } from 'zod'

/**
 * Review protocol schemas (Zod 4).
 *
 * New source-of-truth for the legacy `review.schema.json` protocol. The
 * review structures remain domain-specific: every legacy required field,
 * `minLength`, and `additionalProperties: false` behavior is preserved.
 *
 * `ReviewKind` and `ReviewStatus` are kept as standalone shared
 * vocabularies (defined but not referenced by `ReviewChecklistIssueBase`
 * in the legacy schema); they are exported so the domain vocabulary is
 * not lost.
 */

// ─── ReviewKind ────────────────────────────────────────────────────

export const ReviewKindSchema = z.enum(['code', 'conform', 'plan', 'spec', 'fu', 'fp'])
export type ReviewKind = z.infer<typeof ReviewKindSchema>

// ─── ReviewStatus ──────────────────────────────────────────────────

export const ReviewStatusSchema = z.enum(['approved', 'changes_required', 'blocked', 'failed'])
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>

// ─── ReviewChecklistIssueBase ──────────────────────────────────────
//
// Root of the review protocol. Required: check_id, problem,
// required_change. All non-empty strings; no extra properties.

export const ReviewChecklistIssueBaseSchema = z.object({
  check_id: z.string().min(1),
  problem: z.string().min(1),
  required_change: z.string().min(1),
})
export type ReviewChecklistIssueBase = z.infer<typeof ReviewChecklistIssueBaseSchema>

/** Convert the review checklist issue schema to a draft-07 JSON Schema. */
export function reviewChecklistIssueBaseToJSONSchema(): Record<string, unknown> {
  return z.toJSONSchema(ReviewChecklistIssueBaseSchema, { target: 'draft-07' }) as Record<string, unknown>
}
