import { z } from 'zod'
import { AcceptanceCriterionSchema } from '../../core/task/concepts.mts'
import shellUsage from '../instructions/shell-usage.mts'

/**
 * Implement — strict structured single-slice implementation builtin.
 *
 * One task/session owns a continuous vertical slice: inspect the current
 * project instructions and code, plan locally, implement, run focused and
 * proportionate regression checks, diagnose/fix only its own introduced
 * failures, perform one diff self-review/correction, then return concise
 * facts. No phase-node cold starts, no subagents, no background work.
 *
 * The I/O contract is intentionally small and strict to reduce structured
 * retry risk: input binds `objective`, optional `context`, `scope`,
 * `constraints`, `verification_commands`, and at least one shared
 * `AcceptanceCriterion`; output is a compact `status`/`summary` envelope
 * with bounded `changes`, `verification`, and `remaining_issues` arrays.
 */

// ─── I/O schemas ──────────────────────────────────────────────────

const ImplementChangeSchema = z.object({
  path: z.string().min(1).max(500),
  summary: z.string().min(1).max(500),
})

const ImplementVerificationSchema = z.object({
  command: z.string().min(1).max(500),
  status: z.enum(['passed', 'failed', 'not_run']),
  summary: z.string().max(500),
})

export const ImplementInputSchema = z.object({
  objective: z.string().min(1).max(2000),
  context: z.string().max(4000).optional(),
  scope: z.array(z.string().min(1).max(300)).min(1).max(50).optional(),
  constraints: z.array(z.string().min(1).max(500)).min(1).max(50).optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1).max(20),
  verification_commands: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
})

export const ImplementOutputSchema = z.object({
  status: z.enum(['completed', 'blocked', 'needs_attention']),
  summary: z.string().min(1).max(2000),
  changes: z.array(ImplementChangeSchema).max(200),
  verification: z.array(ImplementVerificationSchema).max(50),
  remaining_issues: z.array(z.string().max(500)).max(50),
}).strict()

export type ImplementInput = z.infer<typeof ImplementInputSchema>
export type ImplementOutput = z.infer<typeof ImplementOutputSchema>

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'LEGACY RECOVERY ONLY. New work must compose atomic edit and test tasks in a TaskGraph; this merged implementation task remains resolvable only for persisted runs.',
    scheduling: 'legacy',
    agentRuntime: 'forge/general',
    permission: 'yolo',
    timeoutMs: 1_800_000,
    instructions: [shellUsage],
    input: ImplementInputSchema,
    output: ImplementOutputSchema,
    prompt: (input: unknown): string => {
      const {
        objective,
        context,
        scope,
        constraints,
        acceptance_criteria,
        verification_commands,
      } = input as ImplementInput
      return `
You are an **Implementer**. Own one vertical slice from first inspection through verified completion in a single continuous session. Do not cold-start per phase; keep the whole slice in context and finish it.

## Hard Boundary
- Work only inside the current project worktree. Preserve unrelated worktree changes — never revert, stage, or commit anything you did not touch.
- NEVER commit, push, deploy, start subagents, or launch background agent work.
- Do not import, copy, or assume any workspace-specific content beyond what is given below and what you inspect in the current project.

## Objective
${objective}

${context && context.trim() ? `## Context\n${context}\n` : ''}
${scope && scope.length > 0 ? `## Scope\n${scope.map((item) => `- ${item}`).join('\n')}\n` : ''}
${constraints && constraints.length > 0 ? `## Constraints\n${constraints.map((item) => `- ${item}`).join('\n')}\n` : ''}

## Acceptance Criteria
${acceptance_criteria.map((criterion) => `- [${criterion.id}] when: ${criterion.when} then: ${criterion.then}${criterion.given ? ` given: ${criterion.given}` : ''}`).join('\n')}

${verification_commands && verification_commands.length > 0 ? `## Verification Commands\n${verification_commands.map((cmd) => `- \`${cmd}\``).join('\n')}\n` : ''}

## Workflow (one continuous slice)
1. Inspect the current project instructions and code relevant to the objective (targeted reads, not broad scans).
2. Plan locally — a short concrete plan you will execute and self-check.
3. Implement the smallest changes that satisfy the acceptance criteria.
4. Run focused and proportionate regression checks (the verification commands when provided, plus targeted checks for the code you touched). Do not run full-suite noise you cannot interpret.
5. Diagnose and fix any failures you introduced. Do not chase unrelated pre-existing failures.
6. Perform one diff self-review, correct anything wrong, then return concise facts.

## Output Contract
- \`completed\` requires that every acceptance criterion is met with concrete evidence (verification \`passed\` or a stated inspected reason) and no known blocker. Without that, use \`blocked\` (stopped by an unresolvable blocker) or \`needs_attention\` (incomplete or partially verified), and put the remaining issues in \`remaining_issues\`.
- \`changes\`: one entry per file you changed, with a one-line \`path\` and \`summary\`.
- \`verification\`: one entry per check you ran (or deliberately skipped, \`not_run\`), with the exact \`command\`, \`status\`, and a one-line \`summary\`.
- Keep every field small and factual. Do not pad arrays.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "status": "completed|blocked|needs_attention",
  "summary": "<concise outcome>",
  "changes": [ { "path": "src/x.ts", "summary": "what changed" } ],
  "verification": [ { "command": "npm test", "status": "passed|failed|not_run", "summary": "result" } ],
  "remaining_issues": [ "<anything still open>" ]
}
`
    },
  },
  sourcePath: 'lib/standard/tasks/implement.mts',
}

export default definition
