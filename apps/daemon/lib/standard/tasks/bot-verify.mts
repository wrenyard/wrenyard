import { renderTaskPromptTemplate, withTaskPromptTemplates } from '../../core/task/prompt-template.mts'
import { REVIEW_DISPATCH_REQUIREMENTS } from '../task-dispatch.mts'
import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

export const TASK_PROMPT_TEMPLATE_1 = { strings: [`
You are the **Request Verifier** for an autonomous dispatcher bot. Decide whether one inbox request is real work on the **current default branch** of the named project, and prepare the brief and acceptance plan a work session will need if it is.

## Request under verification
`,`

## Projects in scope
`,`

## Item classes
`,`

## Rules
- READ-ONLY. Never modify files, never run a mutating command, never commit, never push.
- Decide \`real\` only when the request is verifiable on the current default branch:
  - A defect must be reproducible by reading the code or by running a cheap, read-only check (a targeted read, a grep, a focused existing test). A defect that is already fixed, cannot be reproduced, or is only a speculation is \`not_real\`.
  - A small feature must not already exist in the code and must still be needed. A feature that is already implemented, or that no configured project owns, is \`not_real\`.
- Choose exactly one configured project, or \`park\` with a precise question when the request does not clearly belong to one.
- Choose a class from the item classes when the request clearly matches one; otherwise use \`default\`.
- When you answer \`real\`, write a \`brief\`: the verbatim request, the context you found, the observed behaviour today, the expected behaviour, and the acceptance criteria. Any session will work from this brief alone, so state file paths and exact behaviours rather than generalities.
- When you answer \`real\`, also give an \`acceptance\` plan: the required checks that prove the change works. Each check carries a \`surface\`:
  - \`daemon\`: an isolated daemon in a temp directory, real requests, numbers.
  - \`renderer\`: the Desktop window driven through the browser operation component, with screenshots.
  - \`native\`: native menus, tray, dock or dialogs, driven through the desktop operation component.
  - \`static\`: lint, typecheck or reading the code. A static check can never verify a runtime claim.
  Each check's \`recipe\` states exactly how to establish it, concretely enough that a separate run can repeat it.
- \`touchedPaths\` are the files you expect the change to touch, when you can tell.
- Use \`park\` with a \`question\` when you genuinely cannot decide (ambiguous request, missing access, two plausible projects). Do not guess.

## Investigation
- Inspect the project checkout with targeted reads and searches.
- Do not install dependencies, do not start long-running processes, and do not run browser or desktop drivers.
- Keep cheap checks cheap: prefer reading the code over running anything.

## Output Format
Put exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Shape:
{
  "decision": "real|not_real|park",
  "reason": "<why>",
  "project": "<configured project id, when real>",
  "class": "<item class, when real>",
  "brief": "<verbatim request + context + behaviour today vs expected + acceptance criteria, when real>",
  "acceptance": { "checks": [ { "id": "chk-1", "claim": "<what will be true>", "surface": "daemon|renderer|native|static", "recipe": "<how to establish it>" } ] },
  "touchedPaths": ["<path>"],
  "question": "<the precise question for the user, when parked>"
}
`], labels: ['request', 'projects', 'classes'] } as const

/**
 * Bot Verify — read-only request verifier builtin for Bot mode.
 *
 * The daemon-owned bot host runs this in the project checkout on the current
 * default branch before it dispatches anything. The task answers whether the
 * request is real work, which configured project and class it belongs to, and
 * what the work session and the later acceptance run need: a complete brief and
 * an acceptance plan whose checks name the surface each one proves.
 *
 * Permission is always readonly: it reports a decision and never edits.
 */

// ─── I/O schemas ──────────────────────────────────────────────────

export const BotVerifyCheckSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  surface: z.enum(['daemon', 'renderer', 'native', 'static']),
  recipe: z.string().min(1),
})

export const BotVerifyInputSchema = z.object({
  request: z.object({
    title: z.string().min(1),
    body: z.string().optional(),
    url: z.string().optional(),
  }),
  project: z.string().optional(),
  projects: z.array(z.object({
    id: z.string().min(1),
    description: z.string().optional(),
  })).min(1),
  classes: z.array(z.string().min(1)).min(1),
})

export const BotVerifyOutputSchema = z.object({
  decision: z.enum(['real', 'not_real', 'park']),
  reason: z.string().min(1),
  project: z.string().optional(),
  class: z.string().optional(),
  brief: z.string().optional(),
  acceptance: z.object({ checks: z.array(BotVerifyCheckSchema) }).optional(),
  touchedPaths: z.array(z.string()).optional(),
  question: z.string().optional(),
})

export type BotVerifyCheck = z.infer<typeof BotVerifyCheckSchema>
export type BotVerifyInput = z.infer<typeof BotVerifyInputSchema>
export type BotVerifyOutput = z.infer<typeof BotVerifyOutputSchema>

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Read-only request verifier for the dispatcher bot: decides whether an inbox request is real work on the current default branch, names its project and class, and returns the session brief and acceptance plan. Never edits.',
    dispatch: REVIEW_DISPATCH_REQUIREMENTS,
    instructions: [shellUsage],
    input: BotVerifyInputSchema,
    output: BotVerifyOutputSchema,
    prompt: withTaskPromptTemplates((input: unknown): string => {
      const { request, project, projects, classes } = input as BotVerifyInput
      return renderTaskPromptTemplate(TASK_PROMPT_TEMPLATE_1, [
        JSON.stringify(project === undefined ? request : { ...request, hintedProject: project }, null, 2),
        JSON.stringify(projects, null, 2),
        JSON.stringify(classes, null, 2),
      ])
    }, [TASK_PROMPT_TEMPLATE_1]),
  },
  sourcePath: 'lib/standard/tasks/bot-verify.mts',
}

export default definition
