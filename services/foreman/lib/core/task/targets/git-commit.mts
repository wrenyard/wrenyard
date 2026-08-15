import { z } from 'zod'
import { TargetBaseSchema, type TargetBase } from '../concepts.mts'

/**
 * GitCommitTarget — domain Target for git history exploration.
 *
 * Extends the open `TargetBase` with commit-specific metadata
 * (`hash`, `date`, `theme`). Like `MarkdownTarget`, it is *not* registered
 * with the closed `CoreTarget` union — it only needs to satisfy
 * `TargetBase` (D29), so the open `Target` / `TargetSchema` accept it
 * without any change to `TargetSchema` (verified in the D3 test suite).
 */

export const GitCommitTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('git_commit'),
  /** Commit hash (or ref / range, e.g. `HEAD~20..HEAD`). */
  hash: z.string(),
  /** ISO 8601 date when available. */
  date: z.string().optional(),
  /** Change theme category. */
  theme: z.string().optional(),
})

export type GitCommitTarget = z.infer<typeof GitCommitTargetSchema>

// Compile-time guarantee that GitCommitTarget satisfies the open TargetBase
// contract (D29): any domain subtype is assignable to TargetBase.
const _gitCommitSatisfiesTargetBase: TargetBase = {} as GitCommitTarget
void _gitCommitSatisfiesTargetBase
