import {
  CommitReportSchema,
  CommitRequestSchema,
  type CommitRequest,
} from '../../core/task/schemas/commit.mts'
import type { GateContext, GateFail, GatePass } from '../../core/task/types.mts'
import commitRules from '../instructions/commit-rules.mts'
import shellUsage from '../instructions/shell-usage.mts'

/** Re-export the `CommitRequest` TS type so downstream tests can import it
 *  from this module without reaching into the commit domain schemas. */
export type { CommitRequest }

// ─── Push-detection gates ─────────────────────────────────────────────
//
// The commit agent must never push. These pre/post gates hard-fail whenever
// the remote-tracking ref for the attached branch advanced while the agent
// ran (which is what a `git push` would do). Local HEAD advancing is
// expected and allowed; only the `refs/remotes/origin/<branch>` ref is
// compared. A pre-gate `null` tracking SHA is a captured state: if the
// origin tracking ref appears by post-gate time (a first push), the gate
// fails. Detection is skipped only when no attached branch was captured
// (detached HEAD / not a repo).

/** Shell-quote a single argument for POSIX sh. Git refnames cannot contain
 *  spaces or shell metacharacters (check-ref-format), but may contain a
 *  literal single quote, which is escaped here. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Resolve the short attached branch name, or null when detached/none. */
async function currentBranch(ctx: GateContext): Promise<string | null> {
  const res = await ctx.shell('git symbolic-ref --short -q HEAD')
  const branch = res.stdout.trim()
  return res.exitCode === 0 && branch ? branch : null
}

/** Resolve the full object SHA of a ref, or null when it does not exist. */
async function resolveRef(ctx: GateContext, ref: string): Promise<string | null> {
  const res = await ctx.shell(`git rev-parse --verify --quiet ${sq(ref)}`)
  const sha = res.stdout.trim()
  return res.exitCode === 0 && sha ? sha : null
}

const originTrackingRef = (branch: string): string => `refs/remotes/origin/${branch}`

export const captureOriginTrackingGate = {
  id: 'capture-origin-tracking',
  description: 'Record the remote-tracking SHA for the attached branch before the commit agent runs.',
  run: async (ctx: GateContext): Promise<GatePass | GateFail> => {
    const branch = await currentBranch(ctx)
    if (!branch) {
      // Detached HEAD or not a git repo — no tracking ref to compare.
      ctx.state.originTrackingSha = null
      ctx.state.branch = null
      return { ok: true, evidence: { tracked: false, reason: 'no attached branch' } }
    }
    const sha = await resolveRef(ctx, originTrackingRef(branch))
    ctx.state.branch = branch
    ctx.state.originTrackingSha = sha
    return { ok: true, evidence: { branch, originTrackingSha: sha } }
  },
}

export const originTrackingUnchangedGate = {
  id: 'origin-tracking-unchanged',
  description: 'Fail if the remote-tracking ref for the attached branch advanced (agent pushed).',
  run: async (ctx: GateContext): Promise<GatePass | GateFail> => {
    const recorded = ctx.state.originTrackingSha
    const branch = ctx.state.branch
    if (typeof branch !== 'string') {
      // No attached branch was captured at pre — nothing to detect.
      return { ok: true }
    }
    const ref = originTrackingRef(branch)
    const current = await resolveRef(ctx, ref)
    if (current === recorded) {
      return { ok: true }
    }
    return {
      ok: false,
      expected: recorded === null ? `${ref} absent at pre-gate` : `${ref} unchanged at ${recorded}`,
      actual: current ? `${ref} now ${current}` : `${ref} no longer exists`,
      remediation:
        'The commit task is commit-only and must never push. Outbound push happens only via `wrenyard project push <project>` — ' +
        'use that for any push. Local HEAD advancing is expected; reconcile the remote-tracking ref before retrying the commit.',
    }
  },
}

/**
 * Commit — structured git commit builtin.
 *
 * Uses the commit domain Zod schemas (`CommitRequestSchema` /
 * `CommitReportSchema`) from `lib/core/task/schemas/commit.mts` and the
 * migrated commit instructions. The agent stages only declared file
 * changes and creates verified local commits with matching Author/Committer
 * identities. It NEVER pushes — outbound push happens only via
 * `wrenyard project push <project>`.
 */

// ─── Task definition (TaskDefinition object literal) ──────────────

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Structured git commit agent. Stages only declared file changes and creates verified local commits. NEVER pushes — outbound push happens only via `wrenyard project push <project>`.',
    agentRuntime: 'forge/fast',
    permission: 'yolo',
    instructions: [commitRules, shellUsage],
    input: CommitRequestSchema,
    output: CommitReportSchema,
    gates: {
      pre: [captureOriginTrackingGate],
      post: [originTrackingUnchangedGate],
    },
    prompt: (input: unknown): string => {
      const { changes_to_commit, atomic_commit = true } = input as CommitRequest
      return `
You are a **Structured Commit Agent**. Stage only the declared changes, create verified git commits, and output machine-readable commit metadata.

## Hard Boundary
- Only stage paths listed in \`changes_to_commit\`.
- Never stage unrelated files or unrelated hunks.
- NEVER run \`git push\` under any circumstances.
- Push is out of scope for this agent. Outbound push happens only via \`wrenyard project push <project>\`.
- If no commit is created, stop with an error instead of outputting JSON.

## Commit Request
changes_to_commit:
${JSON.stringify(changes_to_commit, null, 2)}

atomic_commit: ${String(atomic_commit)}
commit_message: derive from staged changes and repository history

## Pre-flight (MANDATORY)
Before ANY commit, run these in parallel:
1. \`git log -10 --format="%H%x09%an <%ae>%x09%cn <%ce>%x09%s"\` -> inspect nearby Author/Committer identities
2. \`git log -10 --pretty=format:"%s"\` -> detect commit message style
3. \`git status --short\` -> see what changed
4. \`git rev-parse --show-toplevel\` and \`git branch --show-current\` -> confirm repository root and branch
5. \`git rev-parse HEAD\` -> record before_head

## Author/Committer Consistency (CRITICAL)
- Author and Committer MUST match on every new commit.
- Do NOT hard-code an identity. Use nearby repository history.
- Select identity from step 1 using nearest-neighbor order:
  1. Prefer the most recent commit where Author exactly equals Committer.
  2. If none of the last 10 commits match, use the most recent Committer identity from those 10 commits.
  3. If there are no commits, use \`git config user.name\` and \`git config user.email\`.
- Use the selected name/email for BOTH \`GIT_AUTHOR_*\` and \`GIT_COMMITTER_*\`.
- NEVER use \`git commit --author=...\` by itself; it changes Author only and can leave Committer different.

PowerShell commit pattern:
\`\`\`powershell
$env:GIT_AUTHOR_NAME = $name
$env:GIT_AUTHOR_EMAIL = $email
$env:GIT_COMMITTER_NAME = $name
$env:GIT_COMMITTER_EMAIL = $email
git commit -m "<message matching detected style>"
\`\`\`

Bash commit pattern:
\`\`\`bash
GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" git commit -m "<message matching detected style>"
\`\`\`

## Style Detection
- Detect dominant style from step 2: semantic (\`feat:\`), plain, or short
- Match the detected style - do NOT impose your own

## Staging Rules
- For each path whose value is exactly \`all\`, stage the complete file with \`git add -- <path>\`.
- For each path whose value describes a subset of changes, stage only that subset using an appropriate partial staging workflow, then verify with \`git diff --staged -- <path>\`.
- After staging, run \`git diff --cached --name-only\`. Every staged path MUST be present in \`changes_to_commit\`; if any other path is staged, unstage it and re-check.
- Do not use broad commands like \`git add .\`, \`git add -A\`, or \`git commit -a\`.

## Commit Grouping
If \`atomic_commit\` is true:
- Split by directory/module and concern.
- 3+ files -> SHOULD be 2+ commits when separable.
- 5+ files -> SHOULD be 3+ commits when separable.
- Each commit should be independently revertable.

If \`atomic_commit\` is false:
- Create exactly one commit containing all declared staged changes.

## Execution Steps
1. \`git diff --stat\` for summary
2. \`git diff\` to read actual changes
3. Stage only declared changes
4. Plan commit group(s) according to \`atomic_commit\`
5. For each group:
   - \`git add <specific files>\`
   - \`git diff --cached --stat\`
   - Set \`GIT_AUTHOR_NAME\`, \`GIT_AUTHOR_EMAIL\`, \`GIT_COMMITTER_NAME\`, and \`GIT_COMMITTER_EMAIL\` to the same selected identity
   - \`git commit -m "<message matching detected style>"\`
   - Verify with \`git log -1 --format="%an <%ae>%x09%cn <%ce>"\`; if Author and Committer differ, amend immediately with the selected identity
6. Capture new commits with \`git rev-list --reverse <before_head>..HEAD\`. This list MUST be non-empty.
7. For every new commit:
   - message: \`git log -1 --format=%s <hash>\`
   - raw_shortstat: \`git show --shortstat --format= <hash>\`
   - raw_numstat rows: \`git show --numstat --format= <hash>\`
   - added_lines/deleted_lines: sum numeric numstat columns; treat binary \`-\` as 0.
   - edited_lines: sum \`Math.min(added, deleted)\` over numeric numstat rows.
8. Output JSON matching the schema exactly. Do not push — the commit agent never runs \`git push\`.

## Output Format
Put exactly one JSON object in the Foreman <result> field. Do not include Markdown, prose, comments, or code fences inside <result>.

Example shape:
{
  "commits": [
    {
      "hash": "abcdef1",
      "message": "fix: example message",
      "stats": {
        "files_changed": 1,
        "added_lines": 10,
        "deleted_lines": 2,
        "edited_lines": 2,
        "raw_shortstat": "1 file changed, 10 insertions(+), 2 deletions(-)",
        "raw_numstat": [
          { "file": "src/example.ts", "added": 10, "deleted": 2, "raw": "10\\t2\\tsrc/example.ts" }
        ]
      }
    }
  ]
}
`
    },
  },
  sourcePath: 'lib/standard/tasks/commit.mts',

}

export default definition
