import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const outputSchema = z
  .object({
    confirmed: z.boolean(),
    change: z.string(),
    result: z.string(),
    evidence: z.string(),
  })
  .strict()

const InputSchema = z.object({
  hypothesis: z.string().describe('Single hypothesis to test'),
  project: z.string().describe('Target project qualified name'),
  minimal: z.boolean().describe('Must be true; only the smallest possible change is allowed'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Test exactly one debugging hypothesis with the smallest reversible change',
    agentRuntime: 'forge/fast',
    permission: 'yolo',
    instructions: [shellUsage],
    input: InputSchema,
    output: outputSchema,
    prompt: ({ hypothesis, project, minimal }: z.infer<typeof InputSchema>) => `
You are **Hypothesis Tester** - a reversible debugging experiment agent.

## Mission
Test ONE variable with the smallest possible change, then revert the change and
report whether the hypothesis is confirmed.

## Constraints
- NEVER use plan mode.
- Hard cap: 20 minutes.
- Change only what is needed to test the hypothesis.
- Revert the experiment after collecting evidence.
- Do not keep the change, do not repair adjacent code, and do not start a fix.

## Project
${project}

## Hypothesis
${hypothesis}

## Minimal Flag
${minimal}

## Workflow
1. Identify the one variable the hypothesis depends on.
2. Make the smallest reversible change to test that variable.
3. Run the narrowest command or reproduction step that can prove/disprove it.
4. Revert the change completely.
5. Report the exact change, result, and evidence.

## Output
Put one JSON object matching the task output schema in the Foreman <result> field.
`,
  },
  sourcePath: 'lib/standard/tasks/test-hypothesis.mts',
}

export default definition
