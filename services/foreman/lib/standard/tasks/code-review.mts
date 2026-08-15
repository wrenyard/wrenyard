import { z } from 'zod'
import {
  AcceptanceCriterionSchema,
  AssessmentSchema,
  ChangeSchema,
  ConstraintSchema,
  evidenceWith,
  EvidenceSchema,
  FileTargetSchema,
  findingWith,
  FindingSchema,
  GoalSchema,
  TargetSchema,
  type AcceptanceCriterion,
  type Assessment,
  type Change,
  type Constraint,
  type Evidence,
  type FileTarget,
  type Finding,
  type Goal,
  type Target,
  type TargetBase,
} from '../../core/task/concepts.mts'
import shellUsage from '../instructions/shell-usage.mts'

/**
 * Code Review — blocking-only quality reviewer builtin (Batch D2).
 *
 * Redesigned I/O (D2 fixed contract): input is a `goal`, the `targets` to
 * review, `constraints`, `acceptance_criteria` to assess, the proposed
 * `changes`, and optional pre-collected `evidences`. Output is
 * `assessments` (one per acceptance criterion), `findings` (blocking
 * issues), `required_changes` (as `Change[]`, file-targeted), and a pooled
 * `evidences` set — all aligned to the common concepts.
 *
 * The original role is preserved: a READ-ONLY code quality reviewer that
 * inspects changes and reports only must-fix, blocking issues, emitting
 * repair instructions when needed. Review issues remain blocking-only:
 * an empty `findings`/`required_changes` pair together with all
 * `assessments` `passed` means the review is approved.
 *
 * I/O references the canonical concepts directly. `CodeReviewInputSchema`
 * accepts the open `Target`; the output narrows `evidence`/`finding`/
 * `change` `target` to `FileTarget` (exact-path-only repair, matching the
 * legacy `required_edits[].path`). `CodeReviewChangeSchema` narrows
 * `required_changes` targets to `FileTarget`.
 */

// ─── Domain narrowing: required changes bind to exact file paths ───

export const CodeReviewChangeSchema = ChangeSchema.extend({
  target: FileTargetSchema,
})

// ─── Direct I/O schemas (canonical concept references) ───────────
//
// Code review is file-targeted (findings/evidences point at exact file
// paths, often with `line_range`), so the output narrows the embedded
// `Target` to `FileTarget` to preserve `line_range` metadata.

export const CodeReviewInputSchema = z.object({
  goal: GoalSchema,
  targets: z.array(TargetSchema),
  constraints: z.array(ConstraintSchema),
  acceptance_criteria: z.array(AcceptanceCriterionSchema),
  changes: z.array(ChangeSchema),
  evidences: z.array(EvidenceSchema).optional(),
})

export const CodeReviewOutputSchema = z.union([
  // Approved branch: empty findings + empty required_changes + passed-only assessments
  z.object({
    assessments: z.array(AssessmentSchema.extend({ status: z.literal('passed') })),
    findings: z.array(findingWith(FileTargetSchema)).max(0),
    required_changes: z.array(CodeReviewChangeSchema).max(0),
    evidences: z.array(evidenceWith(FileTargetSchema)),
  }),
  // Blocking branch: at least one finding + at least one required_change
  z.object({
    assessments: z.array(AssessmentSchema),
    findings: z.array(findingWith(FileTargetSchema)).min(1),
    required_changes: z.array(CodeReviewChangeSchema).min(1),
    evidences: z.array(evidenceWith(FileTargetSchema)),
  }),
])

// ─── Generic TS types (mirror z.infer of the with-factories) ──────

export type CodeReviewInput<TTarget extends TargetBase = Target> = {
  goal: Goal
  targets: TTarget[]
  constraints: Constraint[]
  acceptance_criteria: AcceptanceCriterion[]
  changes: Change[]
  evidences?: Evidence[]
}

export type CodeReviewOutput<TTarget extends TargetBase = FileTarget> = {
  assessments: Assessment[]
  findings: Finding<TTarget>[]
  required_changes: Change[]
  evidences: Evidence<TTarget>[]
}

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Code quality reviewer - inspects current changes, reports only blocking must-fix issues, and emits file-targeted repair changes when needed. Read-only; never edits.',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: CodeReviewInputSchema,
    output: CodeReviewOutputSchema,
    prompt: (input: unknown): string => {
      const {
        goal,
        targets,
        constraints,
        acceptance_criteria,
        changes,
        evidences,
      } = input as CodeReviewInput
      return `
You are a **Code Quality Reviewer**. Review the current implementation changes and produce repair instructions only for issues that must be fixed.

## Review Source
Use the supplied changes and targets below. Inspect them with read-only commands (git diff, targeted reads). Do not modify files.

## Goal
${goal.outcome}

## Targets to review
${JSON.stringify(targets, null, 2)}

## Proposed changes under review
${JSON.stringify(changes, null, 2)}

${constraints && constraints.length > 0 ? `## Constraints\n${JSON.stringify(constraints, null, 2)}\n` : ''}
${acceptance_criteria && acceptance_criteria.length > 0 ? `## Acceptance Criteria\n${JSON.stringify(acceptance_criteria, null, 2)}\n` : ''}
${evidences && evidences.length > 0 ? `## Pre-collected evidences\n${JSON.stringify(evidences, null, 2)}\n` : ''}
## Review Checklist (report only verified must-fix, blocking hits)
- \`definite_correctness_bug\`: a logic error, null/undefined misuse, or wrong state transition that will cause incorrect behavior.
- \`required_contract_not_implemented\`: a required contract from the change set or acceptance criteria is not implemented.
- \`build_or_type_failure\`: the change breaks the build or type-check.
- \`unsafe_error_handling\`: a required error path swallows failures, loses context, or is otherwise unsafe.
- \`security_boundary_violation\`: input validation, path traversal, injection, or secret-handling violation at a security boundary.

Do not report style, pattern, performance, testing, or optional polish items. Review issues are BLOCKING-ONLY.
## Required Changes Contract
- If the review is approved, both \`findings\` and \`required_changes\` MUST be empty, and every \`assessment\` MUST be \`passed\`.
- If any blocking issue exists, both \`findings\` and \`required_changes\` MUST be non-empty. A failed review without edits is not allowed.
- Each \`required_change\` is a \`Change\` bound to an exact file \`target\` (with optional \`line_range\`), an \`action\` of create|update|remove, an \`instruction\`, and an \`expected\` post-action state. Never nest edits inside \`findings\`.

## Workflow
1. Assess each acceptance criterion; emit one \`assessment\` per criterion with \`status\` of \`passed\` | \`failed\` | \`blocked\` | \`not_supported\`, supporting \`evidences\` ids, and an optional \`reason\`.
2. For every verified blocking issue, emit a \`finding\` (id, conclusion, targets pointing at the file with line_range, evidences, confidence) and a matching \`required_change\` (Change) bound to the same file.
3. As you observe facts, record them as pooled \`evidences\` (id, source target, observation) and reference them by id.
4. Missing, conflicting, or unreviewable inputs are a task execution failure, not a review result.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "assessments": [ { "criterion_id": "ac-1", "status": "passed|failed|blocked|not_supported", "evidences": ["ev-1"], "reason": "<optional>" } ],
  "findings": [ { "id": "f-1", "conclusion": "definite_correctness_bug: ...", "targets": [ { "kind": "file", "value": "src/batch.ts", "line_range": [40, 58] } ], "evidences": ["ev-1"], "confidence": "high" } ],
  "required_changes": [ { "target": { "kind": "file", "value": "src/batch.ts" }, "action": "update", "instruction": "Change the loop end bound to be inclusive.", "expected": "Final item is processed." } ],
  "evidences": [ { "id": "ev-1", "source": { "kind": "file", "value": "src/batch.ts" }, "observation": "Loop end bound is exclusive." } ]
}
`
    },
  },
  sourcePath: 'lib/standard/tasks/code-review.mts',
}

export default definition
