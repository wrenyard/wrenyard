import { z } from 'zod'
import { TargetBaseSchema, type TargetBase } from '../concepts.mts'

/**
 * MarkdownTarget — domain Target for documentation context exploration.
 *
 * Extends the open `TargetBase` with documentation-specific metadata
 * (`title`, `category`, `freshness`). It is intentionally *not* registered
 * with the closed `CoreTarget` union: per D29, domain subtypes only need
 * to satisfy `TargetBase`, and the open `Target` / `TargetSchema` accept
 * any `kind`. `TargetSchema.parse` therefore accepts a `MarkdownTarget`
 * instance without modification to `TargetSchema` (verified in the D3
 * test suite).
 */

export const MarkdownTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('markdown'),
  /** Document title when available. */
  title: z.string().optional(),
  /** Best-fit document category. */
  category: z
    .enum([
      'spec',
      'plan',
      'handoff',
      'report',
      'architecture',
      'design',
      'embedding',
      'api',
      'ssot',
      'readme',
      'agents',
      'instructions',
      'other',
    ])
    .optional(),
  /** Date or recency signal from filename/frontmatter/git history, or "unknown". */
  freshness: z.string().optional(),
})

export type MarkdownTarget = z.infer<typeof MarkdownTargetSchema>

// Compile-time guarantee that MarkdownTarget satisfies the open TargetBase
// contract (D29): any domain subtype is assignable to TargetBase.
const _markdownSatisfiesTargetBase: TargetBase = {} as MarkdownTarget
void _markdownSatisfiesTargetBase
