import { z } from 'zod'
import { ChangeSchema } from '../../core/task/concepts.mts'
import shellUsage from '../instructions/shell-usage.mts'
import { EditOutputSchema } from './edit.mts'

/**
 * Prepare Fix — Verification Repair Planner builtin (as-is migration of
 * `prepare-fix.task.ts`).
 *
 * Analyzes failed verification evidence and produces precise edit
 * instructions only when the failure is credible and maps to concrete file
 * edits. It does NOT edit files itself; the emitted `patches` are execution
 * `Change` records directly consumable by the `edit` task.
 *
 * The legacy runtime-global behavior (`foremanSchemas` / `foremanInstructions`)
 * is replaced here by static imports of the canonical Zod concepts and the
 * shared `shellUsage` instruction, matching the other builtin tasks.
 */

const PrepareFixEditReportSchema = z.union([
  EditOutputSchema,
  z.looseObject({}),
])

export const PrepareFixInputSchema = z.object({
  implementation_context: z
    .looseObject({})
    .describe(
      'Current implement workflow context: FeaturePoint, FunctionalUnit node, ImplementationUnits, edit reports, and allowed edit scope.',
    ),
  test_report: z
    .looseObject({})
    .describe('Verification report output from the generic test task.'),
  edit_report: PrepareFixEditReportSchema
    .optional()
    .describe('Most recent edit output, when a single edit report is most relevant.'),
  edit_reports: z
    .array(PrepareFixEditReportSchema)
    .optional()
    .describe('All edit reports produced for the current FunctionalUnit so far.'),
  attempt: z
    .number()
    .optional()
    .describe('Current correction attempt number, starting from 1.'),
})
export type PrepareFixInput = z.infer<typeof PrepareFixInputSchema>

export const PrepareFixOutputSchema = z.object({
  status: z.enum([
    'edit_required',
    'invalid_test',
    'environment_blocked',
    'no_code_change_needed',
    'failed',
  ]).describe(
    'edit_required only when the verification failure is credible and maps to precise file edits.',
  ),
  analysis: z.string().describe('Reasoning about whether the test result is credible and what caused it.'),
  patches: z
    .array(ChangeSchema)
    .describe('Precise Change records, directly consumable by the edit task. Non-empty only when status=edit_required.'),
  confidence: z.enum(['high', 'medium', 'low']),
})
export type PrepareFixOutput = z.infer<typeof PrepareFixOutputSchema>

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Analyze failed verification evidence and produce precise edit instructions only when the failure is credible and code repair is required.',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: PrepareFixInputSchema,
    output: PrepareFixOutputSchema,
    prompt: (input: unknown): string => {
      const {
        implementation_context,
        test_report,
        edit_report = {},
        edit_reports = [],
        attempt = 1,
      } = input as Record<string, any>
      return `
You are a **Verification Repair Planner**. You do not edit files. Your job is to decide whether failed verification evidence should become precise edit instructions.

## Implementation Context
${JSON.stringify(implementation_context, null, 2)}

## Verification Report
${JSON.stringify(test_report, null, 2)}

## Latest Edit Report
${JSON.stringify(edit_report, null, 2)}

## All Edit Reports
${JSON.stringify(edit_reports, null, 2)}

Attempt: ${attempt}

## Decision Rules
- First assess whether the verification result is credible. Test runners can be wrong.
- If the failure is due to an invalid test, wrong command, missing dependency, credential, remote service, or unsupported environment, do not produce patches.
- Produce \`edit_required\` only when you can map the failure to concrete implementation changes in files allowed by the FunctionalUnit/IU edit scope.
- \`patches\` must be directly consumable by the edit task: each patch is a \`Change\` record with \`target\` (e.g. \`{ "kind": "file", "value": "<relative/path>" }\`), \`action\`, \`instruction\`, and \`expected\`.
- Use precise instructions: name functions, methods, parameters, return behavior, config keys, or code to remove.
- Do not use low-confidence edits as a guess. If confidence is low, choose \`failed\`, \`invalid_test\`, or \`environment_blocked\` as appropriate.

## Output Format
Put one JSON object matching this schema in the Foreman <result> field:

${jsonBlock(`{
  "status": "edit_required",
  "analysis": "Why the failed verification is credible and what code must change.",
  "patches": [
    {
      "target": { "kind": "file", "value": "relative/path/to/file" },
      "action": "update",
      "instruction": "Precise repair instruction for this file.",
      "expected": "The failing behavior no longer occurs and the expected behavior is observed."
    }
  ],
  "confidence": "high"
}`)}
`
    },
  },
  sourcePath: 'lib/standard/tasks/prepare-fix.mts',
}

export default definition

function jsonFence(): string {
  return '```json'
}

function jsonBlock(body: string): string {
  return `${jsonFence()}\n${body}\n${'```'}`
}
