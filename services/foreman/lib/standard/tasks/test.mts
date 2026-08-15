import { z } from 'zod'
import type { TaskCapabilityConfig } from '../../core/task/types.mts'
import {
  AcceptanceCriterionSchema,
  AssessmentSchema,
  EvidenceSchema,
  type AcceptanceCriterion,
  type Assessment,
  type Evidence,
} from '../../core/task/concepts.mts'
import shellUsage from '../instructions/shell-usage.mts'

/**
 * Test — generic verification runner builtin.
 *
 * Redesigned I/O (Batch D1): input is an object with `acceptance_criteria`
 * array plus an optional `capability` selector. Output is a pair of pooled
 * `Evidence[]` plus one `Assessment[]` entry per criterion.
 *
 * The generic verification behavior is preserved: the runner interprets
 * each criterion, chooses a reasonable verification action, and reports
 * evidence without proposing code edits.
 *
 * Capability guidance (browser-use / computer-use) is injected into the
 * prompt when the corresponding capability is selected via TaskConfig.
 */

// ─── I/O schemas ──────────────────────────────────────────────────

const CapabilityEnum = z.enum(['browser-use', 'computer-use']).optional()

export const TestInputSchema = z.object({
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1),
  verification_commands: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
  capability: CapabilityEnum,
})

export const TestOutputSchema = z.object({
  evidences: z.array(EvidenceSchema),
  assessments: z.array(AssessmentSchema),
})

export type TestInput = {
  acceptance_criteria: AcceptanceCriterion[]
  verification_commands?: string[]
  capability?: 'browser-use' | 'computer-use'
}

export type TestOutput = {
  evidences: Evidence[]
  assessments: Assessment[]
}

// ─── Capability config ────────────────────────────────────────────

export const testCapabilityConfig: TaskCapabilityConfig = {
  available: ['browser-use', 'computer-use'],
  select(input: unknown): readonly string[] {
    const data = input as TestInput | undefined
    if (!data?.capability) return []
    return [data.capability]
  },
}

// ─── Prompt builders ──────────────────────────────────────────────

function buildGenericPrompt(criteria: AcceptanceCriterion[], commands?: string[]): string {
  return `
You are a **Verification Runner**. Verify the requested behavior and report evidence and assessments. Do not edit files and do not propose code patches.

## Acceptance Criteria
${JSON.stringify(criteria, null, 2)}

${commands?.length ? `## Verification Commands\n${commands.map((command) => `- \`${command}\``).join('\n')}\n` : ''}

## Rules
- Treat each criterion independently. Do not collapse or skip criteria.
- A criterion is a Given/When/Then fact to establish: evaluate its \`then\` against the observed behavior under its \`when\` (and \`given\` context).
- When verification commands are supplied, run them first and do not inspect project files unless a command fails or leaves a criterion unresolved.
- Without supplied commands, use one targeted discovery pass over scripts, manifests, or nearby test files, then execute the smallest relevant check.
- You may correct commands, run a smaller focused check, or run a broader surrounding check when justified.
- Keep attempts bounded: no more than three materially different attempts per criterion unless a fast retry is clearly required.
- Mark \`blocked\` for missing credentials, unavailable remote services, unavailable browser/runtime tooling, or environment problems that prevent a meaningful verdict.
- Mark \`not_supported\` when the requested verification needs a project-specialized task or external human/visual judgment that this generic task cannot perform.
- Do not output suggested edits. Implementation repair is handled by a separate task.

## Workflow
1. For each criterion, gather observations as pooled \`evidences\` (id, source target, observation).
2. For each criterion, emit one \`assessment\` with the matching \`criterion_id\`, a \`status\` of \`passed\` | \`failed\` | \`blocked\` | \`not_supported\`, the supporting \`evidences\` ids, and an optional \`reason\`.
3. Keep \`evidences\` pooled (shared across assessments) and reference them by id.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "evidences": [ { "id": "ev-1", "source": { "kind": "command", "value": "npm test" }, "observation": "..." } ],
  "assessments": [ { "criterion_id": "<id>", "status": "passed|failed|blocked|not_supported", "evidences": ["ev-1"], "reason": "<optional>" } ]
}
`
}

function buildBrowserPrompt(criteria: AcceptanceCriterion[]): string {
  return `
You are a **Verification Runner** with **browser capabilities**. Use the Playwright MCP tool for all page-level interactions, state inspection, navigation, and screenshots.

## Acceptance Criteria
${JSON.stringify(criteria, null, 2)}

## Rules
- Use Playwright MCP for every browser interaction: page navigation, element interaction, DOM state inspection, and screenshots.
- Rely on observed page state (DOM text, element visibility, screenshot analysis) to determine pass/fail.
- Mark \`blocked\` for missing credentials, unavailable remote services, unavailable browser tooling, or environment problems that prevent a meaningful verdict.
- Mark \`not_supported\` when the criterion cannot be verified through automated browser interaction.
- Do not edit files and do not propose code patches.

## Workflow
1. For each criterion, navigate to the relevant page(s) and gather observations as pooled \`evidences\`.
2. For each criterion, emit one \`assessment\` with the matching \`criterion_id\`, a \`status\`, the supporting \`evidences\` ids, and an optional \`reason\`.
3. Keep \`evidences\` pooled and reference them by id.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field.

Shape:
{
  "evidences": [ { "id": "ev-1", "source": { "kind": "screenshot", "value": "dashboard-loaded" }, "observation": "..." } ],
  "assessments": [ { "criterion_id": "<id>", "status": "passed|failed|blocked|not_supported", "evidences": ["ev-1"], "reason": "<optional>" } ]
}
`
}

function buildComputerPrompt(criteria: AcceptanceCriterion[]): string {
  return `
You are a **Verification Runner** with **desktop application capabilities**. Use the Cua Driver MCP tool for app state, semantic element actions, and screenshots.

## Acceptance Criteria
${JSON.stringify(criteria, null, 2)}

## Rules
- Use Cua Driver MCP for application state inspection, semantic element interaction, and screenshots.
- Screenshots are the primary evidence source for desktop app verification.
- If an operation requires OS-level permissions and the agent cannot satisfy them, mark the criterion as \`blocked\` with a clear explanation of which permission was missing.
- Rely on observed app state (window content, element labels, screenshot analysis) to determine pass/fail.
- Mark \`not_supported\` when the criterion cannot be verified through Cua Driver interaction.
- Do not edit files and do not propose code patches.

## Workflow
1. For each criterion, interact with the desktop application and gather observations as pooled \`evidences\`.
2. For each criterion, emit one \`assessment\` with the matching \`criterion_id\`, a \`status\`, the supporting \`evidences\` ids, and an optional \`reason\`.
3. Keep \`evidences\` pooled and reference them by id.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field.

Shape:
{
  "evidences": [ { "id": "ev-1", "source": { "kind": "screenshot", "value": "app-window-loaded" }, "observation": "..." } ],
  "assessments": [ { "criterion_id": "<id>", "status": "passed|failed|blocked|not_supported", "evidences": ["ev-1"], "reason": "<optional>" } ]
}
`
}

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Generic verification runner. Interprets acceptance criteria, chooses reasonable verification actions, and reports evidence and assessments without proposing code edits. Supports browser and desktop-app verification via capability packs.',
    agentRuntime: 'forge/fast',
    permission: 'yolo',
    capabilities: testCapabilityConfig,
    instructions: [shellUsage],
    input: TestInputSchema,
    output: TestOutputSchema,
    prompt: (input: unknown): string => {
      const data = input as TestInput
      const criteria = data.acceptance_criteria
      switch (data.capability) {
        case 'browser-use':
          return buildBrowserPrompt(criteria)
        case 'computer-use':
          return buildComputerPrompt(criteria)
        default:
          return buildGenericPrompt(criteria, data.verification_commands)
      }
    },
  },
  sourcePath: 'lib/standard/tasks/test.mts',
}

export default definition
