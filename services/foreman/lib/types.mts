import type { ZodTypeAny } from 'zod'

export type JsonSchema = boolean | Record<string, unknown>

export type PermissionMode = 'readonly' | 'edit' | 'yolo'

export interface AgentOpts {
  workingDirectory?: string
  timeoutMs?: number
  resume?: string
  permission: PermissionMode
  taskId?: string
  capabilities?: readonly string[]
  /** Canonical exact file paths used only for Foreman's edit-lock admission. */
  writePaths?: readonly string[]
}

export interface AgentResult {
  output: string
  status: 'done' | 'failed' | 'cancelled'
  nativeSessionId?: string
  /** Concrete profile resolved by the Forge runtime during execution.
   *  Set when run_started.profile is detected; undefined for initial runs,
   *  legacy unmigrated executions, and non-Forge runtimes. */
  resolvedProfile?: string
}

export interface ShellOpts {
  cwd?: string
  timeout?: number
  env?: NodeJS.ProcessEnv
}

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Canonical native LLM request protocols Foreman can forward directly. */
export type LlmNativeProtocol = 'openai' | 'anthropic'

/**
 * Broadened LLM input. Existing callers pass a prompt string; callers may
 * instead pass a native OpenAI/Anthropic request-body object (with the
 * matching `protocol` option) to forward the body unchanged.
 */
export type LlmInput = string | Record<string, unknown>

export interface LlmOpts {
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  maxRetries?: number
  retryBackoffMs?: number
  /** Native protocol selection; only meaningful for a native request-body input. */
  protocol?: LlmNativeProtocol
}

export type CheckpointFn = (opts: {
  id: string
  output: Record<string, unknown>
  expectedSchema: ZodTypeAny | Record<string, unknown>
}) => Promise<Record<string, unknown>>

export interface SchemaField extends Record<string, unknown> {
  required?: boolean
}

export interface ResolvedTarget {
  definition: TaskDefinition
  type: 'task'
  name: string
  /** Registered project qualified id; only for `source === 'project'`. */
  project?: string
  source: 'builtin' | 'project'
  sourcePath: string
}

export interface PrimitiveSet {
  agent: (agentRuntime: string, prompt: string, opts?: AgentOpts) => Promise<AgentResult>
  shell: (command: string, opts?: ShellOpts) => Promise<ShellResult>
  llm: (input: LlmInput, opts?: LlmOpts) => Promise<string | unknown>
  checkpoint: CheckpointFn
}

export interface ExecutionOptions {
  workspaceRoot: string
  currentProject?: string
  /** Internal execution target project selected by the caller before resolving a
   *  workspace task definition.
   */
  executionProject?: string
  workingDirectory?: string
  /** Foreman-managed worktree id when execution is bound to a managed worktree. */
  worktreeId?: string
  primitives?: Partial<PrimitiveSet>
  workflowId?: string
  taskId?: string
  /** Internal: allow rerunning an interrupted persisted task with the same task id. */
  resumeInterruptedTask?: boolean
  /** MCP connection id that triggered the run (for cc-channel session targeting) */
  connectingId?: string
  /** Bounded JSON-safe context inherited from a direct run or TaskGraph. */
  taskContext?: import('./core/task/context.mts').TaskContext
}

// ── Task-domain types re-export shim ─────────────────────────────────
//
// The task-domain types (TaskConfig / TaskDefinition / RegisteredTask /
// TaskExecutionResult / TaskRunResult / TaskListEntry / TaskGate / GatePass /
// GateFail / GateContext) now live in `lib/core/task/types.mts` as the
// single source of truth (Core Concept 7). They are re-exported here so the
// 14 existing files importing from `lib/types.mts` do not need to change
// their import paths. New code should import directly from
// `lib/core/task/types.mts` (or `lib/core/task/concepts.mts` for the
// General Concepts layer).
//
// `import type` brings the types into local module scope so the
// `declare global` block below can reference `TaskConfig` / `TaskDefinition`
// without resolving to undefined names.

import type {
  TaskConfig,
  TaskDefinition,
} from './core/task/types.mts'
import type { ForemanSchemas } from './core/task/schemas/index.mts'
import type { ForemanInstructions } from './standard/instructions/index.mts'

export type {
  TaskSchemaInput,
  TaskConfig,
  TaskDefinition,
  RegisteredTask,
  TaskExecutionResult,
  TaskRunResult,
  TaskListEntry,
  GatePass,
  GateFail,
  GateContext,
  TaskGate,
} from './core/task/types.mts'

declare global {
  var defineTask: ((config: TaskConfig) => TaskDefinition) | undefined
  var agent: PrimitiveSet['agent'] | undefined
  var shell: PrimitiveSet['shell'] | undefined
  var llm: PrimitiveSet['llm'] | undefined
  var checkpoint: CheckpointFn | undefined
  var foremanSchemas: ForemanSchemas | undefined
  var foremanInstructions: ForemanInstructions | undefined
}
