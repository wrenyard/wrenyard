import { z } from 'zod'
import {
  TargetSchema,
  ChangeSchema,
  AcceptanceCriterionSchema,
} from '../../core/task/concepts.mts'
import shellUsage from '../instructions/shell-usage.mts'

// Evidence carries id / source (Target) / observation, mirroring the Foreman
// `Evidence` concept, plus the investigation-specific `kind` / `supports` /
// `confidence` fields used by the debugging report.
const evidenceSchema = z.object({
  id: z.string().describe('Evidence id.'),
  kind: z.enum(['command', 'test', 'file', 'log', 'config', 'runtime', 'history', 'other']),
  source: TargetSchema.describe('Command, file path, log source, or other concrete evidence source.'),
  observation: z.string().min(1).describe('What was observed.'),
  supports: z.string().min(1).describe('Which claim this evidence supports or weakens.'),
  confidence: z.enum(['high', 'medium', 'low']),
})

const locationSchema = z.object({
  path: z.string().min(1).describe('Relative file path or concrete component identifier.'),
  symbol: z
    .string()
    .optional()
    .describe('Function, class, method, config key, route, or other symbol when known.'),
  line_range: z
    .tuple([z.number(), z.number()])
    .describe('Approximate 1-based line range when known.'),
  reason: z.string().min(1).describe('Why this location is relevant to the root cause or repair.'),
})

// Verification briefs/results are `AcceptanceCriterion` records:
// { id, given?, when, then }.
const verificationItemSchema = AcceptanceCriterionSchema

const outputSchema = z.object({
  status: z
    .enum(['root_cause_confirmed', 'likely_root_cause', 'inconclusive', 'blocked'])
    .describe(
      'root_cause_confirmed requires direct evidence. likely_root_cause is allowed only when evidence is strong but not fully reproduced.',
    ),
  executive_summary: z.string().min(1).describe('Concise answer for the orchestrator.'),
  investigation_report: z.object({
    problem: z.string().min(1),
    reproduction: z.string().min(1).describe('What reproduced, failed to reproduce, or blocked reproduction.'),
    commands_run: z.array(z.string()).describe('Commands or test/repro actions attempted, including notable outputs in brief.'),
    key_findings: z.array(z.string()).describe('Concrete findings, ordered from strongest to weakest.'),
    unresolved_gaps: z
      .array(z.string())
      .describe('Facts that could not be verified inside the time or environment budget.'),
  }),
  root_cause: z.object({
    summary: z.string().min(1).describe('Root cause summary, or "Unknown" when inconclusive/blocked.'),
    mechanism: z.string().min(1).describe('How the failure happens, step by step.'),
    locations: z.array(locationSchema).describe('Concrete code/config locations implicated by the evidence.'),
    alternatives_ruled_out: z
      .array(z.string())
      .describe('Plausible causes checked and why they are less likely.'),
  }),
  evidence: z.array(evidenceSchema).describe('Evidence supporting the root cause analysis.'),
  edit_steps: z
    .array(ChangeSchema)
    .describe(
      'Direct edit task input as Change records. Empty unless the investigation can recommend concrete file-level edits.',
    ),
  verify_steps: z
    .array(verificationItemSchema)
    .describe(
      'Direct test task verification input (AcceptanceCriterion records). Include the smallest post-edit checks needed to prove the fix.',
    ),
  confidence: z.enum(['high', 'medium', 'low']),
  risks: z
    .array(z.string())
    .optional()
    .describe('Risks, side effects, or cautions for the follow-up edit/verify work.'),
})

const InputSchema = z.object({
  problem_description: z.string().min(1).describe('Problem, failing behavior, incident summary, error message, or bug report.'),
  context: z.string().optional().describe('Relevant background, prior findings, logs, file paths, constraints, or user notes.'),
  expected_behavior: z.string().optional().describe('Expected result or acceptance criteria when known.'),
  actual_behavior: z.string().optional().describe('Observed failure or incorrect behavior when known.'),
  reproduction_steps: z.array(z.string()).optional().describe('Optional reproduction steps supplied by the user.'),
  artifacts: z
    .array(z.string())
    .optional()
    .describe('Optional log paths, screenshots, URLs, traces, branches, commits, or commands to inspect.'),
  scope: z.string().optional().describe('Optional subsystem, module, file set, project area, or worktree focus.'),
  constraints: z
    .array(z.string())
    .optional()
    .describe('Constraints such as no network, no dependency changes, no DB migration, or must preserve API.'),
  verification_hints: z
    .array(verificationItemSchema)
    .optional()
    .describe('Optional verification briefs (AcceptanceCriterion records) to prioritize during investigation and reuse for follow-up testing.'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Mini systematic debugging investigation. Read-only in behavior, but yolo permission allows repro commands and tests; outputs root cause plus edit/test schemas.',
    agentRuntime: 'forge/ultra',
    permission: 'yolo',
    instructions: [shellUsage],
    input: InputSchema,
    output: outputSchema,
    prompt: ({
      problem_description,
      context = '',
      expected_behavior = '',
      actual_behavior = '',
      reproduction_steps = [],
      artifacts = [],
      scope = '',
      constraints = [],
      verification_hints = [],
    }: z.infer<typeof InputSchema>) => `
You are **Investigate**, a mini systematic debugging agent.

## Mission
Investigate one concrete bug or failure, establish the strongest root-cause analysis you can, and return a directly actionable report for the orchestrator. You do not fix the bug. Your output must give the next agent exact edit-task and test-task inputs when the evidence supports them.

## Permission Reality
You are launched with YOLO permission so you can run local commands, repro commands, and tests. Despite that permission, this task is READ-ONLY in behavior.

## Hard Boundaries
- Do not edit source files, docs, configs, tests, generated files, lockfiles, or git state.
- Do not run git add, commit, push, stash, checkout, reset, clean, rebase, merge, or branch-changing commands.
- Do not install packages, run migrations, change services, deploy, or write credentials.
- Tests/repro commands are allowed. If they create ordinary ignored caches, build outputs, or logs, report that fact.
- If a repro command is destructive or likely to mutate important state, do not run it; report it as blocked.
- Hard cap: 20 minutes. At the cap, stop and output the best supported findings.

## Investigation Method
1. Normalize the bug report: expected vs actual, scope, constraints, and reproduction signal.
2. Inspect the smallest relevant docs, code, configs, tests, logs, and recent local evidence needed to understand the failure.
3. Reproduce when safe. Prefer the narrowest command or test. Capture exact failure snippets.
4. Trace the failing value, state transition, request, config, or control flow back to its source.
5. Compare working and broken paths. Rule out plausible alternatives with evidence.
6. Decide one of:
   - root_cause_confirmed: direct evidence identifies the mechanism.
   - likely_root_cause: strong evidence but reproduction or one critical fact is incomplete.
   - inconclusive: evidence is insufficient.
   - blocked: environment, credentials, missing services, destructive repro, or tooling prevents a meaningful verdict.
7. Produce follow-up steps:
   - edit_steps must be exact input for workspace/edit: each is a Change record with \`target\` (e.g. \`{ "kind": "file", "value": "<relative/path>" }\`), \`action\`, \`instruction\`, and \`expected\`.
   - verify_steps must be exact input for workspace/test: each is an AcceptanceCriterion with \`id\`, \`when\`, and \`then\`.
   - Leave edit_steps empty when edits would be guesswork.

## Precision Rules
- Prefer concrete file paths, symbols, config keys, commands, and error text.
- Do not invent paths or line numbers.
- Keep edit instructions minimal and tied to the root cause.
- Include tests or verification that prove the stated expected behavior, not just that the command exits.
- If the issue is caused by user error, environment, bad test setup, or external service state, say so and do not fabricate code edits.

## Problem
${problem_description}

${context ? `## Context\n${context}` : ''}
${expected_behavior ? `## Expected Behavior\n${expected_behavior}` : ''}
${actual_behavior ? `## Actual Behavior\n${actual_behavior}` : ''}
${Array.isArray(reproduction_steps) && reproduction_steps.length > 0 ? `## Reproduction Steps\n${JSON.stringify(reproduction_steps, null, 2)}` : ''}
${Array.isArray(artifacts) && artifacts.length > 0 ? `## Artifacts\n${JSON.stringify(artifacts, null, 2)}` : ''}
${scope ? `## Scope\n${scope}` : ''}
${Array.isArray(constraints) && constraints.length > 0 ? `## Constraints\n${JSON.stringify(constraints, null, 2)}` : ''}
${Array.isArray(verification_hints) && verification_hints.length > 0 ? `## Verification Hints\n${JSON.stringify(verification_hints, null, 2)}` : ''}

## Output Format
Put exactly one JSON object matching this schema in the Foreman <result> field. Do not include prose outside the JSON block.

\`\`\`json
{
  "status": "root_cause_confirmed",
  "executive_summary": "Concise root-cause answer and recommended next action.",
  "investigation_report": {
    "problem": "Normalized bug statement.",
    "reproduction": "What reproduced, did not reproduce, or blocked reproduction.",
    "commands_run": ["command or action -> observed result"],
    "key_findings": ["strongest finding first"],
    "unresolved_gaps": []
  },
  "root_cause": {
    "summary": "Confirmed or likely root cause.",
    "mechanism": "Step-by-step explanation of how the failure occurs.",
    "locations": [
      {
        "path": "relative/path/to/file",
        "symbol": "functionOrConfigKey",
        "line_range": [10, 20],
        "reason": "Why this location matters."
      }
    ],
    "alternatives_ruled_out": ["Alternative cause and evidence against it."]
  },
  "evidence": [
    {
      "id": "EV-001",
      "kind": "test",
      "source": { "kind": "command", "value": "command or file path" },
      "observation": "Observed failure or behavior.",
      "supports": "Claim supported by this evidence.",
      "confidence": "high"
    }
  ],
  "edit_steps": [
    {
      "target": { "kind": "file", "value": "relative/path/to/file" },
      "action": "update",
      "instruction": "Precise follow-up edit instruction for workspace/edit.",
      "expected": "The failing behavior no longer occurs and the expected behavior is observed."
    }
  ],
  "verify_steps": [
    {
      "id": "AC-001",
      "when": "Run the focused regression scenario.",
      "then": "The former failure no longer occurs and the expected behavior is observed."
    }
  ],
  "confidence": "high",
  "risks": []
}
\`\`\`
`,
  },
  sourcePath: 'lib/standard/tasks/investigate.mts',
}

export default definition
