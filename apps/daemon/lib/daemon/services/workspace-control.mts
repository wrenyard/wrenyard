import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  WorkspaceInitializeResult,
  WorkspaceInspectResult,
} from '../../protocol/registry.mts'

/**
 * Remote-safe workspace control.
 *
 * These operations run on the daemon host, so an active remote workspace is
 * inspected and initialized without the client ever stat'ing or creating a
 * remote path locally. `initialize` creates the directory and its template
 * files on the daemon host only; the daemon still owns the authoritative
 * `workspace.root` write (through its idle-only `workspace.switch`), so this
 * module never touches the config itself.
 *
 * The template mirror is the same public, host-neutral template the Desktop
 * uses for local onboarding, so a workspace created on a remote host is
 * identical to one created locally.
 */

/** Files written into a freshly created Wrenyard workspace directory. */
const WORKSPACE_TEMPLATE_FILES: Record<string, string> = {
  'workspace.wrws': `${JSON.stringify({ version: 1 }, null, 2)}\n`,
  'AGENTS.md': `# Agent Workspace

This directory is a Wrenyard workspace. The desktop app treats the presence of
\`workspace.wrws\` as metadata about this directory; it is not required in order
to select an existing directory as a workspace.

Read \`instructions/tasks.md\` before dispatch, \`instructions/documents.md\` before writing documents, and \`instructions/memory.md\` before saving memories. Keep business source in registered checkouts; maintain workspace instructions here. Follow the user's authorization for publishing, deletion, and messages.

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

Default to automatic routing; do not pick a model, provider or runtime based on coordinator preference. Only explicit user requirements (including existing explicit user settings), or a confirmed routing/orchestration tool fault requiring a temporary explicit runtime, justify an exception. Explain fault evidence and the temporary choice, then return to automatic routing after recovery. No candidates, task failure or long duration alone do not establish a tool fault; inspect constraints and errors without bypassing task requirements. If Wrenyard itself is unavailable, repair it before further dispatch rather than switching orchestration tools.

One task produces a bounded, independently verifiable result. Pass only necessary facts, exact targets and acceptance checks. Investigate missing facts before asking an editor to implement. Actively split work into independently verifiable tasks and dispatch independent tasks concurrently instead of waiting for each in sequence. Continue independent coordinator work while tasks run. Wait for prerequisite results before dependent work, and serialize overlapping writes. Split independent investigations, non-conflicting implementation and independent checks when this reduces total elapsed time; merge work when dispatch, repeated context and integration cost outweigh parallelism. Do not impose arbitrary task counts or tool-call ratios. Keep the original run until terminal; inspect actual results because done does not mean tests passed. Preserve partial changes after failure and complete only remaining work.

Built-in tasks are explore, edit, test, code-review, commit, librarian and oracle. Use TaskGraph only when graph semantics are needed. Project .task.ts files export defineTask(...); inspect current schemas before authoring.

A project task file may extend the same-id definition below it (an ancestor project, then the built-in) instead of replacing it: \`edit.task.ts\` declares \`extends: 'edit'\`. The extending file keeps the base input, output, prompt and writeTargets, and may only add instructions, promptAppend, dispatch, displayName, description and category. instructions and promptAppend are appended after the base; dispatch overrides per field, except that requiredCapabilities is the union of both layers and intelligenceMin is the higher of the two. A file without extends is a complete replacement and must declare input, output and prompt.

Task dispatch settings declare a required \`expectedReasoningEffort\` and may also
set \`intelligenceMin\` and \`intelligenceExpected\`. The expected reasoning effort
accepts none, low, medium, high, xhigh or max; it resolves to the nearest level
the resolved route supports at or above the request, else to the highest
supported level. There is no maximum intelligence; choose the smallest level
that fits the work. Unconfigured intelligence recommends mid with no minimum.
A definition that extends another inherits its dispatch settings — including
\`expectedReasoningEffort\` — unless it overrides them. Image/search requirements
belong to task definitions.

Routing uses one total score from price, TPS, quota and intelligence; optional global weights in Desktop settings also apply to routing tests. TPS pairs response output tokens with generation time, excluding tool waits. Never invent missing speed samples.

When documenting a task, describe the current CLI usage for the relevant
command after running \`describe\`, and do not invent syntax that the CLI does
not support.
`,
  'instructions/documents.md': `# Documents

Workspace documents use three kinds: spec, report and handoff.

- **Spec** — what is being built and why, including implementation and acceptance.
- **Report** — what was done, what was verified, and what remains.
- **Handoff** — the current state and what the next person needs to continue.

Do not include private paths, accounts, devices, or internal addresses, and do
not copy private workspace text into documents.
`,
  'instructions/memory.md': `# Memory

Durable workspace memories live in \`memories/*.md\`, one file per fact, with \`memories/INDEX.md\` holding one line per memory: the link text from the frontmatter \`name\`, then the frontmatter \`description\`.

Each file starts with YAML frontmatter:

- \`name\` — the stable kebab-case identity of the fact; updates match it.
- \`description\` — one short line saying when this memory applies. Write it as guidance for deciding whether to load the file, not as a summary of its body.
- \`metadata.type\` — \`user\`, \`feedback\`, \`project\` or \`reference\`.

Save only durable user preferences, confirmed project decisions and verified facts. Keep the description accurate when a memory changes, and keep the index in sync with the files.
`,
}

const PINNED_MESSAGE = '当前工作区由 WRENYARD_WORKSPACE 或 --work-dir 管理，无法在 App 内修改'

export interface WorkspaceControlOptions {
  /** The daemon's authoritative workspace root, read live so a switch is seen. */
  currentRoot: () => string
  /** True when WRENYARD_WORKSPACE / --work-dir pins the root (not editable). */
  isPinned: () => boolean
  /** True once a shutdown has been requested. */
  isShuttingDown: () => boolean
  /** True while a workspace hot switch holds the daemon gate. */
  isSwitching: () => boolean
}

export interface WorkspaceControl {
  /** Inspect a workspace root on the daemon host, or the daemon's own root. */
  inspect(root?: string): Promise<WorkspaceInspectResult>
  /** Initialize a new workspace directory on the daemon host. */
  initialize(root: string): Promise<WorkspaceInitializeResult>
}

export function createWorkspaceControl(options: WorkspaceControlOptions): WorkspaceControl {
  return {
    async inspect(root?: string): Promise<WorkspaceInspectResult> {
      const readOnly = options.isPinned()
      const requested = typeof root === 'string' && root.trim() ? root.trim() : options.currentRoot()
      if (!requested) {
        return {
          ok: false,
          outcome: 'missing',
          root: '',
          exists: false,
          readOnly,
          message: '尚未配置工作区根目录',
        }
      }
      // Lexical identity first (the identity the switch and the ledger use);
      // `realpath` only proves the directory exists on the daemon host.
      const lexical = resolve(requested)
      try {
        const canonical = await realpath(lexical)
        if (!(await stat(canonical)).isDirectory()) {
          return {
            ok: false,
            outcome: 'invalid',
            root: lexical,
            exists: false,
            readOnly,
            message: `工作区路径不是目录：${lexical}`,
          }
        }
        return { ok: true, outcome: 'configured', root: lexical, exists: true, readOnly }
      } catch {
        return {
          ok: false,
          outcome: 'invalid',
          root: lexical,
          exists: false,
          readOnly,
          message: `工作区目录不存在：${lexical}`,
        }
      }
    },

    async initialize(root: string): Promise<WorkspaceInitializeResult> {
      if (options.isShuttingDown()) {
        return { ok: false, outcome: 'unavailable', message: 'Daemon 正在关闭，无法初始化工作区' }
      }
      if (options.isSwitching()) {
        return { ok: false, outcome: 'busy', message: '工作区正在切换，请稍后重试' }
      }
      if (options.isPinned()) {
        return { ok: false, outcome: 'invalid', message: PINNED_MESSAGE }
      }
      const requested = typeof root === 'string' ? root.trim() : ''
      if (!requested) {
        return { ok: false, outcome: 'invalid', message: '请输入工作区路径' }
      }

      const target = resolve(requested)
      const createdFiles: string[] = []
      const createdDirs: string[] = []
      let directoryExists = false
      try {
        directoryExists = (await stat(target)).isDirectory()
      } catch {
        directoryExists = false
      }
      // Only a new (or existing empty) directory may be created; a nonempty
      // destination is refused so an existing workspace is never overwritten.
      if (directoryExists && (await readdir(target)).length > 0) {
        return {
          ok: false,
          outcome: 'exists',
          root: target,
          message: `目录不是空的，请选择已有工作区：${target}`,
        }
      }

      try {
        if (!directoryExists) {
          await mkdir(target, { recursive: true })
          createdDirs.push(target)
        }
        for (const [relative, contents] of Object.entries(WORKSPACE_TEMPLATE_FILES)) {
          const filePath = join(target, relative)
          const parent = dirname(filePath)
          if (parent !== target && !existsSync(parent)) createdDirs.push(parent)
          await mkdir(parent, { recursive: true })
          // Exclusive create: never overwrite a file that appeared meanwhile.
          await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' })
          createdFiles.push(filePath)
        }
        return { ok: true, outcome: 'initialized', root: await realpath(target) }
      } catch (error) {
        // On any failure remove only the exact files and empty directories this
        // invocation created.
        for (const filePath of createdFiles.reverse()) {
          await rm(filePath, { force: true })
        }
        for (const dir of createdDirs.reverse()) {
          if (dir === target) continue
          try {
            await rmdir(dir)
          } catch {
            // Leave non-empty directories in place.
          }
        }
        if (createdDirs.includes(target)) {
          try {
            await rmdir(target)
          } catch {
            // Leave the directory when other content appeared meanwhile.
          }
        }
        return {
          ok: false,
          outcome: 'error',
          message: `初始化工作区失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
