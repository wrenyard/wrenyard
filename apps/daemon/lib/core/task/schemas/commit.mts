import { z } from 'zod'

/**
 * Commit protocol schemas (Zod 4).
 *
 * These are the new source-of-truth for the legacy
 * `commit.schema.json` protocol. Every legacy required field, enum,
 * pattern, `minLength`, `minimum`, and `additionalProperties: false`
 * behavior is preserved.
 *
 * `CommitChangeSet` is a `record<string, string>` whose values are
 * staging-scope strings (`minLength: 1`). The legacy draft-07 schema
 * required `minProperties: 1` on this record. Zod has no `minProperties`
 * primitive, so it is restored after JSON-Schema conversion via
 * `patchCommitJsonSchema` (see below) — an explicit post-conversion
 * patch, exactly as the contract allows.
 */

// ─── CommitChangeSet ───────────────────────────────────────────────
//
// Map of relative file path -> staging scope. Every value is a non-empty
// string describing what to stage from that file.

export const CommitChangeSetSchema = z.record(z.string(), z.string().min(1))
export type CommitChangeSet = z.infer<typeof CommitChangeSetSchema>

// ─── CommitRequest ─────────────────────────────────────────────────

export const CommitRequestSchema = z.object({
  changes_to_commit: CommitChangeSetSchema,
  // Legacy `commit.schema.json` marks `atomic_commit` as *optional* (absent
  // from `required`) with a documented default `true`. Zod 4 emits a
  // `.default()` field into `required` during JSON-Schema conversion, which
  // would diverge from the legacy required-field invariant — so it stays
  // `.optional()` and the default is applied at the call site.
  //
  // `need_push` was removed: the commit agent is commit-only and must never
  // push. Outbound push happens solely via `wrenyard project push <project>`.
  atomic_commit: z.boolean().optional(),
})
export type CommitRequest = z.infer<typeof CommitRequestSchema>

// ─── CommitNumstatRow ──────────────────────────────────────────────

export const CommitNumstatRowSchema = z.object({
  file: z.string().min(1),
  added: z.number().int().min(0),
  deleted: z.number().int().min(0),
  raw: z.string(),
})
export type CommitNumstatRow = z.infer<typeof CommitNumstatRowSchema>

// ─── CommitStats ───────────────────────────────────────────────────

export const CommitStatsSchema = z.object({
  files_changed: z.number().int().min(0),
  added_lines: z.number().int().min(0),
  deleted_lines: z.number().int().min(0),
  edited_lines: z.number().int().min(0),
  raw_shortstat: z.string(),
  raw_numstat: z.array(CommitNumstatRowSchema),
})
export type CommitStats = z.infer<typeof CommitStatsSchema>

// ─── CommitInfo ────────────────────────────────────────────────────

export const CommitInfoSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{7,40}$/),
  message: z.string().min(1),
  stats: CommitStatsSchema,
})
export type CommitInfo = z.infer<typeof CommitInfoSchema>

// ─── CommitReport ──────────────────────────────────────────────────

export const CommitReportSchema = z.object({
  commits: z.array(CommitInfoSchema).min(1),
  // `pushed` was removed: the commit agent never pushes, so a push flag would
  // always be false and conveys nothing. Outbound push happens only via
  // `wrenyard project push <project>`.
})
export type CommitReport = z.infer<typeof CommitReportSchema>

// ─── Post-conversion patch: preserve CommitChangeSet.minProperties ─
//
// Zod 4's `z.toJSONSchema(..., { target: 'draft-07' })` emits
// `propertyNames: { type: 'string' }` for records (harmless, but not in
// the legacy schema) and has no way to emit `minProperties`. This patch
// removes the synthetic `propertyNames` and restores `minProperties: 1`
// on the inlined `CommitChangeSet` object so the converted draft-07
// matches the legacy `commit.schema.json#/definitions/CommitChangeSet`
// exactly.

function isCommitChangeSetNode(node: unknown): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  const rec = node as Record<string, unknown>
  if (rec.type !== 'object') return false
  const ap = rec.additionalProperties
  if (!ap || typeof ap !== 'object' || Array.isArray(ap)) return false
  const apRec = ap as Record<string, unknown>
  return apRec.type === 'string' && apRec.minLength === 1
}

function applyMinPropertiesToNode(node: Record<string, unknown>): void {
  node.minProperties = 1
  delete node.propertyNames
}

/**
 * Patch a draft-07 JSON Schema produced from the commit schemas so that
 * `CommitChangeSet.minProperties` (and the literal `additionalProperties`
 * behavior) is preserved. Accepts either the full `CommitRequest` JSON
 * (the changeset is inlined under `properties.changes_to_commit`) or a
 * standalone `CommitChangeSet` JSON (the root node itself).
 */
export function patchCommitJsonSchema(json: Record<string, unknown>): Record<string, unknown> {
  if (isCommitChangeSetNode(json)) {
    applyMinPropertiesToNode(json)
    return json
  }
  const props = json.properties as Record<string, unknown> | undefined
  if (props && isCommitChangeSetNode(props.changes_to_commit)) {
    applyMinPropertiesToNode(props.changes_to_commit as Record<string, unknown>)
  }
  return json
}

/** Convert the commit request schema to a patched draft-07 JSON Schema. */
export function commitRequestToJSONSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(CommitRequestSchema, { target: 'draft-07' }) as Record<string, unknown>
  return patchCommitJsonSchema(json)
}
