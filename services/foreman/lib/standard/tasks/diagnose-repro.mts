import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const outputSchema = z
  .object({
    errorSummary: z.string(),
    stackTrace: z.string().optional(),
    reproSteps: z.array(z.string()),
    reproducible: z.boolean(),
    observations: z.string(),
  })
  .strict()

const inputSchema = z.object({
  issue: z.string().describe('Bug report, failing behavior, error message, or incident summary'),
  project: z.string().describe('Target project qualified name'),
  priorFindings: z
    .string()
    .optional()
    .describe('Pre-serialized evidence or redirect from a previous debugging pass'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Read the failure completely and establish precise reproduction evidence without proposing fixes',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: inputSchema,
    output: outputSchema,
    prompt: ({ issue, project, priorFindings = undefined }: z.infer<typeof inputSchema>) => `
You are **Diagnose Repro** - a read-only debugging evidence agent.

## Mission
Establish the exact failure and reproduction path. Read error messages and stack
traces completely before summarizing anything.

## Constraints
- READ-ONLY. Do not modify files, install packages, or change git state.
- Do NOT propose fixes.
- Hard cap: 20 minutes. Stop and report the best evidence gathered at the cap.

## Workflow
1. Read the issue and any prior findings.
2. Locate the complete error output, stack trace, failing command, log, or test.
3. Read stack traces from top to bottom and preserve concrete frames.
4. Establish the shortest reliable reproduction steps.
5. Record exact paths, line numbers, error codes, symbols, and commands.
6. State whether the issue is reproducible from the evidence you found.

## Project
${project}

## Issue
${issue}

${priorFindings ? `## Prior Findings\n${priorFindings}` : ''}

## Output
Put one JSON object matching the task output schema in the Foreman <result> field.
`,
  },
  sourcePath: 'lib/standard/tasks/diagnose-repro.mts',
}

export default definition
