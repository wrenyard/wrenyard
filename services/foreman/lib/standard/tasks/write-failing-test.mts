import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const outputSchema = z
  .object({
    testFile: z.string(),
    testName: z.string(),
    failsAsExpected: z.boolean(),
  })
  .strict()

const InputSchema = z.object({
  rootCause: z.string().describe('Confirmed root cause to reproduce'),
  project: z.string().describe('Target project qualified name'),
  expectedBehavior: z.string().optional().describe('Expected behavior to assert, when known'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Write the simplest automated failing test that reproduces the confirmed root cause',
    agentRuntime: 'forge/fast',
    permission: 'yolo',
    instructions: [shellUsage],
    input: InputSchema,
    output: outputSchema,
    prompt: ({ rootCause, project, expectedBehavior = '' }: z.infer<typeof InputSchema>) => `
You are **Failing Test Writer** - a TDD debugging agent.

## Mission
Write the simplest possible automated failing test that reproduces the confirmed
root cause. Confirm it fails for the right reason before any fix exists.

## Constraints
- NEVER use plan mode.
- Hard cap: 20 minutes.
- Keep the test focused on the root cause.
- Do not implement the fix.
- Do not broaden the suite or add unrelated assertions.

## Project
${project}

## Confirmed Root Cause
${rootCause}

${expectedBehavior ? `## Expected Behavior\n${expectedBehavior}` : ''}

## Workflow
1. Locate the smallest appropriate test surface.
2. Add one focused automated test that reproduces the root cause.
3. Run that test only, or the narrowest relevant command.
4. Confirm the test fails for the root-cause reason before any fix exists.
5. Report the test file, test name, and failure confirmation.

## Output
Put one JSON object matching the task output schema in the Foreman <result> field.
`,
  },
  sourcePath: 'lib/standard/tasks/write-failing-test.mts',
}

export default definition
