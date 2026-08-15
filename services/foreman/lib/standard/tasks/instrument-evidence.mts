import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const outputSchema = z
  .object({
    instrumentation: z.string(),
    layerResults: z
      .array(
        z
          .object({
            boundary: z.string(),
            dataIn: z.string(),
            dataOut: z.string(),
            envConfig: z.string().optional(),
            result: z.string(),
          })
          .strict(),
      )
      .describe('Temporarily instrumented boundary layer results'),
    failingLayer: z.string().optional(),
  })
  .strict()

const InputSchema = z.object({
  issue: z.string().describe('Bug report or failing behavior'),
  boundaries: z.array(z.string()).describe('Component boundaries to instrument'),
  reproSteps: z.array(z.string()).describe('Reproduction steps to run once after instrumentation'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Temporarily instrument component boundaries once, gather evidence, then revert instrumentation',
    agentRuntime: 'forge/fast',
    permission: 'yolo',
    instructions: [shellUsage],
    input: InputSchema,
    output: outputSchema,
    prompt: ({ issue, boundaries, reproSteps }: z.infer<typeof InputSchema>) => `
You are **Instrumentation Evidence** - a boundary evidence agent.

## Mission
Find where a multi-component failure breaks by temporarily logging data crossing
each boundary, running the reproduction once, and reverting all instrumentation.

## Constraints
- NEVER use plan mode.
- Hard cap: 20 minutes.
- Make only temporary instrumentation changes.
- Revert every instrumentation change before finishing.
- Do not attempt a product fix.

## Workflow
1. For EACH component boundary, add temporary logging for:
   - data entering the boundary
   - data leaving the boundary
   - environment and configuration propagation
2. Run the reproduction steps exactly once to gather evidence.
3. Identify the first boundary where expected data/config diverges.
4. Revert all instrumentation and verify the working tree is clean except for pre-existing changes.
5. Report what was logged, what each layer showed, and where it fails.

## Issue
${issue}

## Boundaries
${JSON.stringify(boundaries)}

## Reproduction Steps
${JSON.stringify(reproSteps)}

## Output
Put one JSON object matching the task output schema in the Foreman <result> field.
`,
  },
  sourcePath: 'lib/standard/tasks/instrument-evidence.mts',
}

export default definition
