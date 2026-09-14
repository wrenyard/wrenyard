/**
 * Files written into a freshly created Wrenyard workspace directory.
 *
 * The template is intentionally generic and public: it must not embed private
 * host paths, account names, device names, internal addresses, or copied text
 * from any private workspace. It only describes how to work with Wrenyard.
 */
export const WORKSPACE_TEMPLATE_FILES: Record<string, string> = {
  'workspace.wrws': `${JSON.stringify({ version: 1 }, null, 2)}\n`,
  'AGENTS.md': `# Agent Workspace

This directory is a Wrenyard workspace. The desktop app treats the presence of
\`workspace.wrws\` as metadata about this directory; it is not required in order
to select an existing directory as a workspace.

Read \`instructions/tasks.md\` before dispatch and \`instructions/documents.md\` before writing documents. Keep business source in registered checkouts; maintain workspace instructions here. Follow the user's authorization for publishing, deletion, and messages.

## Working with Wrenyard

- Use \`wrenyard project list\` and \`wrenyard project describe <project>\` to
  identify the exact project before starting work.
- Describe a task before running it, then run it with a bounded outcome,
  explicit targets, and the relevant context.
- Retain the original execution path through the terminal; do not replace it.
- Verify results after a task completes.

## Avoid

- Arbitrary tool-count or task-count gates.
- Prescribed fixed workflows.
- Retrying commands that were denied.

## Read-only inspection

Prefer native Read/Grep/Glob tools. When shell access is required for
read-only inspection, use \`git --no-optional-locks\` and avoid writes.
`,
  'instructions/tasks.md': `# Tasks

Use \`wrenyard task describe <task> -p <project>\` for the authoritative schema, then \`wrenyard task run <task> -p <project> '<input-json>'\`. Consult command help for worktree and per-run settings.

One task produces a bounded, independently verifiable result. Pass only necessary facts, exact targets and acceptance checks. Investigate missing facts before asking an editor to implement. Independent tasks may run concurrently; wait for prerequisite results before dependent work. Do not impose arbitrary task counts or tool-call ratios. Keep the original run until terminal; inspect actual results because done does not mean tests passed. Preserve partial changes after failure and complete only remaining work.

Built-in tasks are explore, edit, test, code-review, commit, librarian and oracle. Use TaskGraph only when graph semantics are needed. Project .task.ts files export defineTask(...); inspect current schemas before authoring.

Task dispatch settings may optionally declare \`intelligenceMin\`, \`intelligenceExpected\`, and
\`thinking\`. There is no maximum intelligence; choose the smallest level that
fits the work. Thinking accepts low, medium, high, xhigh and max; omission uses the highest supported level. Unconfigured intelligence recommends mid with no minimum. Image/search requirements belong to task definitions.

Routing uses one total score from price, TPS, quota and intelligence; optional global weights in Desktop settings also apply to routing tests. TPS pairs response output tokens with generation time, excluding tool waits. Never invent missing speed samples.

When documenting a task, describe the current CLI usage for the relevant
command after running \`describe\`, and do not invent syntax that the CLI does
not support.
`,
  'instructions/documents.md': `# Documents

Workspace documents follow a generic spec / plan / report format.

- **Spec** — what is being built and why.
- **Plan** — how it will be built and in what order.
- **Report** — what was done, what was verified, and what remains.

Do not include private paths, accounts, devices, or internal addresses, and do
not copy private workspace text into documents.
`,
};
