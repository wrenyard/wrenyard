import { z } from 'zod'

/**
 * General Concepts Layer for Foreman tasks.
 *
 * Each concept is defined simultaneously as a runtime-validatable zod
 * schema and a compile-time TypeScript type (via `z.infer`). The two are
 * derived from a single source of truth, eliminating the divergence risk
 * between hand-written TS types and hand-written JSON Schema (D22).
 *
 * See `docs/specs/2026-07-12-foreman-standard-library-and-concepts-design.md`
 * (Core Concept 1) for the design rationale and per-concept field-naming
 * conventions.
 *
 * Layering:
 *   - Execution-layer concepts: Target, Goal, Constraint,
 *     AcceptanceCriterion, Change, Evidence, Assessment.
 *   - Design / cognitive layer: Decision, Finding, Question, Candidate.
 *
 * Target is *open* (D29): `TargetSchema` accepts any `kind: string`. Domain
 * subtypes (MarkdownTarget / GitCommitTarget / ...) only need to satisfy
 * `TargetBase` — they are not required to register with `CoreTarget`. The
 * closed `CoreTargetSchema` discriminated union is exported for IDE hints
 * and developer convenience, but does not constrain `Target`.
 */

// ─── Ref<T> ─────────────────────────────────────────────────────────
//
// `Ref<T>` is a semantic marker for "the id of T". It compiles to plain
// `string` (no runtime cost) but expresses referencing intent in type
// signatures — `evidences: Ref<Evidence>[]` reads better than `string[]`
// and prevents accidental cross-wiring with unrelated id arrays (D16).

export type Ref<T extends { id: string }> = string

// ─── Target (open, per D29) ─────────────────────────────────────────

/**
 * Open Target base schema. Any `kind` is accepted; domain subtypes
 * (MarkdownTarget, GitCommitTarget, ...) extend this contract without
 * registering with the global union.
 */
export const TargetBaseSchema = z.object({
  kind: z.string(),
  value: z.string(),
})

export type TargetBase = z.infer<typeof TargetBaseSchema>

/**
 * `Target` is the open contract (`TargetBase`). Use this in any schema
 * that wants to accept arbitrary domain target subtypes (D29).
 */
export const TargetSchema = TargetBaseSchema
export type Target = TargetBase

// ─── CoreTarget: closed discriminated union of known kinds ──────────
//
// `CoreTargetSchema` lists the universally-known `kind` values for IDE
// hints and developer convenience. It does **not** constrain `Target` —
// domain kinds (e.g. `'markdown'`, `'git_commit'`) live in
// `lib/core/task/targets/` and are only consumed by their domain task.

export const FileTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('file'),
  /** Filesystem path. */
  value: z.string(),
  line_range: z.tuple([z.number(), z.number()]).optional(),
})
export type FileTarget = z.infer<typeof FileTargetSchema>

export const SymbolTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('symbol'),
  /** Symbol name (function / class / identifier). */
  value: z.string(),
})
export type SymbolTarget = z.infer<typeof SymbolTargetSchema>

export const CommandTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('command'),
  /** Command string. */
  value: z.string(),
})
export type CommandTarget = z.infer<typeof CommandTargetSchema>

export const UrlTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('url'),
  /** URL. */
  value: z.string(),
})
export type UrlTarget = z.infer<typeof UrlTargetSchema>

export const ProjectTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('project'),
  /** Qualified project name (e.g. 'ure/service', 'cjgame/survive'). */
  value: z.string(),
})
export type ProjectTarget = z.infer<typeof ProjectTargetSchema>

export const ArtifactTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('artifact'),
  value: z.string(),
})
export type ArtifactTarget = z.infer<typeof ArtifactTargetSchema>

export const OtherTargetSchema = TargetBaseSchema.extend({
  kind: z.literal('other'),
  value: z.string(),
})
export type OtherTarget = z.infer<typeof OtherTargetSchema>

/**
 * Closed discriminated union of universally-known Target kinds.
 *
 * Provided for IDE completion and developer hints. Domain code that
 * accepts arbitrary domain Targets should use `Target` (open) instead.
 */
export const CoreTargetSchema = z.discriminatedUnion('kind', [
  FileTargetSchema,
  SymbolTargetSchema,
  CommandTargetSchema,
  UrlTargetSchema,
  ProjectTargetSchema,
  ArtifactTargetSchema,
  OtherTargetSchema,
])
export type CoreTarget = z.infer<typeof CoreTargetSchema>

// ─── Goal ───────────────────────────────────────────────────────────
//
// Describes the desired end-state. Only the outcome — never the path.

export const GoalSchema = z.object({
  /** Final result description. */
  outcome: z.string(),
})
export type Goal = z.infer<typeof GoalSchema>

// ─── AcceptanceCriterion ────────────────────────────────────────────
//
// Lightweight Given/When/Then fact-establishment criterion (D11).

export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  given: z.string().optional(),
  when: z.string(),
  then: z.string(),
})
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

// ─── Decision ───────────────────────────────────────────────────────
//
// Design-layer concept. Execution tasks reach back to decisions via
// optional `decisions: Ref<Decision>[]` fields (e.g. on Constraint).

export const DecisionSchema = z.object({
  id: z.string(),
  /** Selected direction. */
  choice: z.string(),
  rationale: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
})
export type Decision = z.infer<typeof DecisionSchema>

// ─── Constraint ────────────────────────────────────────────────────

export const ConstraintSchema = z.object({
  /** Rule statement. */
  rule: z.string(),
  /** Back-references to Decisions this rule derives from. */
  decisions: z.array(z.string()).optional(),
})
export type Constraint = z.infer<typeof ConstraintSchema>

// ─── Change ────────────────────────────────────────────────────────
//
// Splits instruction (what to do) from expected (the resulting state)
// so the executor cannot lose sight of the target state (D12).

export const ChangeSchema = z.object({
  target: TargetSchema,
  action: z.enum(['create', 'update', 'remove']),
  /** Execution instruction. */
  instruction: z.string(),
  /** Expected post-action state. */
  expected: z.string(),
})
export type Change = z.infer<typeof ChangeSchema>

// ─── Evidence ──────────────────────────────────────────────────────
//
// Generic over the embedded Target type so domain tasks can narrow
// `source` to a domain Target subtype (D30). The default
// `EvidenceSchema` / `Evidence` use the open `Target` and accept any
// domain subtype.

export interface Evidence<TTarget extends TargetBase = Target> {
  id: string
  source: TTarget
  /** Observed fact. */
  observation: string
}

export const EvidenceSchema = z.object({
  id: z.string(),
  source: TargetSchema,
  observation: z.string(),
})
export type EvidenceDefault = z.infer<typeof EvidenceSchema>

/**
 * Build a narrowed Evidence zod schema by overriding `source` with a
 * domain Target subtype schema (D30). Used by domain tasks that need
 * compile-time guarantees about the embedded Target shape.
 *
 * Example:
 *   const MarkdownEvidenceSchema = evidenceWith(MarkdownTargetSchema)
 */
export function evidenceWith<TTargetSchema extends z.ZodType<TargetBase>>(
  targetSchema: TTargetSchema,
) {
  return EvidenceSchema.extend({ source: targetSchema })
}

// ─── Finding ───────────────────────────────────────────────────────
//
// Conclusion derived from exploration or investigation. Carries
// references into the surrounding Evidence pool via `Ref<Evidence>[]`.

export interface Finding<TTarget extends TargetBase = Target> {
  id: string
  /** Investigation conclusion. */
  conclusion: string
  targets?: TTarget[]
  /** References to Evidence ids in the surrounding pool. */
  evidences: Ref<Evidence>[]
  confidence: 'high' | 'medium' | 'low'
}

export const FindingSchema = z.object({
  id: z.string(),
  conclusion: z.string(),
  targets: z.array(TargetSchema).optional(),
  evidences: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
})
export type FindingDefault = z.infer<typeof FindingSchema>

/**
 * Build a narrowed Finding zod schema by overriding `targets` with a
 * domain Target subtype schema (D30).
 *
 * Example:
 *   const MarkdownFindingSchema = findingWith(MarkdownTargetSchema)
 */
export function findingWith<TTargetSchema extends z.ZodType<TargetBase>>(
  targetSchema: TTargetSchema,
) {
  return FindingSchema.extend({ targets: z.array(targetSchema) })
}

// ─── Assessment ────────────────────────────────────────────────────
//
// Conclusion about an AcceptanceCriterion based on evidence. Includes
// `not_supported` to flag criteria that cannot be evaluated in the
// current environment (D29 Oracle scope; per spec
// "verification.schema.json → 全部退役" row).

export const AssessmentSchema = z.object({
  criterion_id: z.string(),
  status: z.enum(['passed', 'failed', 'blocked', 'not_supported']),
  evidences: z.array(z.string()),
  reason: z.string().optional(),
})
export type Assessment = z.infer<typeof AssessmentSchema>

// ─── Question ──────────────────────────────────────────────────────

export const QuestionSchema = z.object({
  id: z.string(),
  /** The question text. */
  ask: z.string(),
  blocking: z.boolean(),
})
export type Question = z.infer<typeof QuestionSchema>

// ─── Candidate ─────────────────────────────────────────────────────

export const CandidateSchema = z.object({
  id: z.string(),
  kind: z.enum(['option', 'hypothesis', 'scope']),
  /** Candidate proposal. */
  proposal: z.string(),
})
export type Candidate = z.infer<typeof CandidateSchema>

// ─── Aggregate re-exports ───────────────────────────────────────────

export const conceptSchemas = {
  Target: TargetSchema,
  TargetBase: TargetBaseSchema,
  CoreTarget: CoreTargetSchema,
  FileTarget: FileTargetSchema,
  SymbolTarget: SymbolTargetSchema,
  CommandTarget: CommandTargetSchema,
  UrlTarget: UrlTargetSchema,
  ProjectTarget: ProjectTargetSchema,
  ArtifactTarget: ArtifactTargetSchema,
  OtherTarget: OtherTargetSchema,
  Goal: GoalSchema,
  AcceptanceCriterion: AcceptanceCriterionSchema,
  Decision: DecisionSchema,
  Constraint: ConstraintSchema,
  Change: ChangeSchema,
  Evidence: EvidenceSchema,
  Finding: FindingSchema,
  Assessment: AssessmentSchema,
  Question: QuestionSchema,
  Candidate: CandidateSchema,
} as const
