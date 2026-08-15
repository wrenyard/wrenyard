import type { ZodType } from 'zod'
import type { AgentResult, PermissionMode } from '../../types.mts'

/**
 * Schema accepted for task input and output definitions.
 *
 * AC-5 final state: definition schemas accept ZodType only. They are
 * converted to draft-07 JSON Schema via `z.toJSONSchema(schema, { target:
 * 'draft-07' })` at compile time (see `workspace/schema-loader.mts`). The
 * legacy `Record<SchemaField>` and raw `JsonSchema` definition paths were
 * retired.
 */
export type TaskSchemaInput = ZodType

export interface TaskCapabilityConfig {
  available: readonly string[]
  select?(input: unknown): readonly string[]
}

export interface TaskConfig {
  /** Scheduling lifecycle for this definition. `legacy` definitions remain
   *  resolvable so persisted runs can recover, but are omitted from task lists
   *  and rejected when callers try to create new work. */
  scheduling?: 'active' | 'legacy'
  /** Optional human-facing task category. Validated at definition load:
   *  `id` must match `^[a-z][a-z0-9-]{0,31}$` and `displayLabel` must be a
   *  trimmed single line of 1..24 UTF-16 code units. An invalid category
   *  fails definition validation; an omitted category stays backwards
   *  compatible. The final resolved (project-overridden) definition is what
   *  flows through list/describe summaries. */
  category?: {
    id: string
    displayLabel: string
  }
  /** Preferred runtime selector: '<runtime>/<config-id>' (e.g. 'forge/codex-luna').
   *  When absent the legacy `profile` field is used as 'forge/<profile>'. */
  agentRuntime?: string
  /** Declared Forge capability packs this task can select.
   *  Capabilities are mounted when the task runs; absent means no capability
   *  gate. Generic — does not know about specific capability names. */
  capabilities?: TaskCapabilityConfig
  /** @deprecated Use `agentRuntime` instead. Retained for backward compatibility
   *  during migration; synthesized as 'forge/<profile>' when agentRuntime is absent.
   *  Optional — builtin and migrated definitions may rely solely on `agentRuntime`. */
  profile?: string
  description?: string
  instructions?: Array<string | ((input?: unknown) => string | Promise<string>)>
  input: TaskSchemaInput
  output: TaskSchemaInput
  prompt: (input: unknown) => string | Promise<string>
  gates?: {
    pre?: TaskGate[]
    post?: TaskGate[]
  }
  permission?: PermissionMode
  /** Deterministic exact file targets used to scope an `edit` permission lock.
   *  Omit for repo-wide write protection. The execution kernel resolves and
   *  bounds every returned path inside the active checkout/worktree. */
  writeTargets?: (input: unknown) => readonly string[]
  /** Max wall-clock milliseconds for this task's initial native-agent execution
   *  before it is force-timed-out. This is per agent attempt, not a cumulative
   *  task budget; structured-output resume attempts use the shorter retry
   *  timeout. */
  timeoutMs?: number
}

export interface TaskDefinition {
  __type: 'task'
  config: TaskConfig
  sourcePath: string
}

/**
 * Registered task entry, keyed internally by plain `name` (the task id) plus
 * scope metadata (`source` / `project`). There is no composite `project/id`
 * identity. `project` is set only for `source === 'project'` entries (the
 * registered project id); it is
 * undefined for builtin and workspace entries.
 */
export interface RegisteredTask {
  /** Plain task id (also the file basename minus `.task.ts`). */
  name: string
  definition: TaskDefinition
  sourcePath: string
  mtime: number
  source: 'builtin' | 'project'
  /** Registered project qualified id; only for `source === 'project'`. */
  project?: string
}

export interface TaskExecutionResult {
  task_id: string
  name: string
  project: string
  status: AgentResult['status'] | 'interrupted'
  output: unknown
  summary?: string | null
  structured: boolean
  error?: string | null
  failure_category?: string
  suggestion?: string
  error_message?: string
  agentResult?: AgentResult
  agentRuntime?: string
}

export interface TaskRunResult {
  task_run_id: string
  hint: string
}

export interface TaskListEntry {
  name: string
  project: string
  description?: string
  agentRuntime?: string
}

// ── Task gate types ─────────────────────────────────────────────────

export interface GatePass {
  ok: true
  evidence?: unknown
}

export interface GateFail {
  ok: false
  expected: string
  actual: string
  evidence?: unknown
  remediation?: string
  retryable?: boolean
}

export interface GateContext<I = unknown, O = unknown> {
  task: {
    name: string
    sourcePath: string
  }
  input: I
  output?: O  // only available in post-gates
  workDir: string
  workspaceRoot: string
  project: string
  taskId: string
  state: Record<string, unknown>  // shared pre→post bag
  shell: (cmd: string, args?: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export interface TaskGate<I = unknown, O = unknown> {
  id: string
  description?: string
  run: (ctx: GateContext<I, O>) => Promise<GatePass | GateFail> | GatePass | GateFail
  retry?: {
    maxAttempts: number
    appendReportToPrompt?: boolean
  }
}
