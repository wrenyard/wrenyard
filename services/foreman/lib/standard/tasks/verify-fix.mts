import { renderTaskPromptTemplate, withTaskPromptTemplates } from '../../core/task/prompt-template.mts'
import { FREQUENT_DISPATCH_REQUIREMENTS } from '../task-dispatch.mts'
import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

export const TASK_PROMPT_TEMPLATE_1 = { strings: [`
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
`,
`

`,
`
`,
`

## Workflow
1. Run the specific failing test if a name was provided.
2. Run the smallest surrounding suite that covers related behavior.
3. Capture failing test names, regression signals, commands, and relevant output.
4. Report pass/fail with evidence.

## Output
Put one JSON object matching the task output schema in the Foreman <result> field.
`], labels: ["project","运行时填入任务输入","运行时填入任务输入"] } as const


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
    dispatch: FREQUENT_DISPATCH_REQUIREMENTS,
    permission: 'yolo',
    instructions: [shellUsage],
    input: InputSchema,
    output: outputSchema,
    prompt: withTaskPromptTemplates(({ project, testName = '', scope = '' }: z.infer<typeof InputSchema>) => renderTaskPromptTemplate(TASK_PROMPT_TEMPLATE_1, [project,
testName ? `## Test Name\n${testName}` : '',
scope ? `## Scope\n${scope}` : '']), [TASK_PROMPT_TEMPLATE_1]),
  },
  sourcePath: 'lib/standard/tasks/verify-fix.mts',
}

export default definition
