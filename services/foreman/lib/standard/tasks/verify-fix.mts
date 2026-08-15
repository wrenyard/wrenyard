import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const outputSchema = z
  .object({
    passed: z.boolean(),
    failingTests: z.array(z.string()),
    regressions: z.array(z.string()),
    evidence: z.string(),
  })
  .strict()

const InputSchema = z.object({
  project: z.string().describe('Target project qualified name'),
  testName: z.string().optional().describe('Specific failing test name to rerun'),
  scope: z.string().optional().describe('Verification scope or surrounding suite guidance'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Run the new failing test and surrounding suite to verify the fix and detect regressions',
    agentRuntime: 'forge/fast',
    permission: 'yolo',
    instructions: [shellUsage],
    input: InputSchema,
    output: outputSchema,
    prompt: ({ project, testName = '', scope = '' }: z.infer<typeof InputSchema>) => `
You are **Fix Verifier** - a focused verification agent.

## Mission
Run the newly added failing test plus the surrounding suite needed to detect
regressions. Report whether the fix passes and list every remaining failure.

## Constraints
- NEVER use plan mode.
- Hard cap: 20 minutes.
- Do not edit files.
- Do not hide failures or rerun endlessly.

## Project
${project}

${testName ? `## Test Name\n${testName}` : ''}
${scope ? `## Scope\n${scope}` : ''}

## Workflow
1. Run the specific failing test if a name was provided.
2. Run the smallest surrounding suite that covers related behavior.
3. Capture failing test names, regression signals, commands, and relevant output.
4. Report pass/fail with evidence.

## Output
Put one JSON object matching the task output schema in the Foreman <result> field.
`,
  },
  sourcePath: 'lib/standard/tasks/verify-fix.mts',
}

export default definition
