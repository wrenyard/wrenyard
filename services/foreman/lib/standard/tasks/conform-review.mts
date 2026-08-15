import { z } from 'zod'

const conformReviewIssueSchema = z
  .object({
    check_id: z.enum([
      'required_change_missing',
      'explicit_contract_violation',
      'prohibited_change_present',
      'out_of_scope_behavior_added',
    ]),
    problem: z.string().min(1),
    required_change: z.string().min(1),
    location: z
      .string()
      .regex(new RegExp('^\\S+(:\\d+)?$'))
      .describe('A changed path in the diff, optionally with a :line suffix.'),
  })
  .strict()

const reviewOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('conform'),
      status: z.literal('approved'),
      issues: z.array(conformReviewIssueSchema).max(0),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('conform'),
      status: z.literal('changes_required'),
      issues: z.array(conformReviewIssueSchema).min(1),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('conform'),
      status: z.literal('blocked'),
      issues: z.array(conformReviewIssueSchema).max(0),
      summary: z.string().min(1),
    })
    .strict(),
])

const inputSchema = z.object({
  architecture_direction: z
    .string()
    .describe('The architectural direction or design spec content to align against'),
  diff: z.string().describe('The file diff or change description to review'),
  files_context: z.string().optional().describe('Relevant source file paths or snippets for context'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Conformance review - verify changes match the intended spec, plan, or architecture direction',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    input: inputSchema,
    output: reviewOutputSchema,
    prompt: ({
      architecture_direction,
      diff,
      files_context = '',
    }: z.infer<typeof inputSchema>) => `
You are a **Conformance Reviewer** - verify that changes faithfully implement the supplied spec, plan, or architectural direction.

## Review Process
Report only verified must-fix checklist hits. Do not report severity, counts, overall assessment, optional advice, or broad quality review.

1. Read the architectural direction carefully. Extract the key required changes, interfaces, and constraints.
2. Read the diff. Understand what was actually changed.
3. For each required change, verify the diff implements it; flag missing or violated requirements.
4. Flag prohibited changes and any behavior not covered by the direction (out-of-scope).

## Review Checklist (report only verified hits)
- \`required_change_missing\`: a required change from the direction is absent from the diff.
- \`explicit_contract_violation\`: the diff contradicts an explicit interface, contract, or constraint stated in the direction.
- \`prohibited_change_present\`: the diff contains a change the direction explicitly forbids.
- \`out_of_scope_behavior_added\`: the diff adds behavior not covered by the supplied direction.

## Issue Contract
Every must-fix issue must include \`check_id\`, \`problem\`, \`required_change\`, and \`location\` (a changed path, optionally with a \`:line\` suffix). Do not include category or severity fields.

## Status Rules
- \`approved\`: the diff passes every checklist item. \`issues\` must be empty.
- \`changes_required\`: at least one verified checklist hit. \`issues\` must be non-empty.
- \`blocked\`: the supplied direction or diff is missing, conflicting, or unreviewable. \`issues\` must be empty.

## Architecture Direction
${architecture_direction}

## Diff to Review
${diff}

${files_context ? `## Additional File Context\n${files_context}` : ''}

## Output Format

Put one JSON object following this exact schema in the Foreman <result> field:

\`\`\`json
{
  "kind": "conform",
  "status": "changes_required",
  "issues": [
    {
      "check_id": "required_change_missing",
      "problem": "The direction requires the export stream key to be 'tasks', but the diff omits it.",
      "required_change": "Add the 'tasks' stream key to the export contract in the diff.",
      "location": "src/export.ts:42"
    }
  ],
  "summary": "Diff omits the required export stream key."
}
\`\`\`
`,
  },
  sourcePath: 'lib/standard/tasks/conform-review.mts',
}

export default definition
