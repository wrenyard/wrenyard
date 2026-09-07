import type { ZodTypeAny } from 'zod'
import type { TaskSettingsLayer } from './protocol/methods/task.mts'

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
  /** Original requested agent runtime carried separately from the exact
   *  execution profile chosen by the daemon dispatch resolver. */
  requestedAgentRuntime?: string
  /** Per-attempt dispatch snapshot produced by the daemon resolver. */
  dispatchSnapshot?: import('./core/operations/types.mts').TaskDispatchSnapshot | null
  /** Canonical Forge failure class, when classified by the runtime. */
  failureClass?: import('./core/task/failure.mts').ForgeFailureClass | string | null
}

export interface AgentResult {
  output: string
  status: 'done' | 'failed' | 'cancelled'
  nativeSessionId?: string
  /** Concrete profile resolved by the Forge runtime during execution.
   *  Set when run_started.profile is detected; undefined for initial runs,
   *  legacy unmigrated executions, and non-Forge runtimes. */
  resolvedProfile?: string
  /** Original requested agent runtime, distinct from the exact execution profile. */
  requestedAgentRuntime?: string
  /** Per-attempt dispatch snapshot produced by the daemon resolver. */
  dispatchSnapshot?: import('./core/operations/types.mts').TaskDispatchSnapshot | null
  /** Canonical Forge failure class captured from `run_finished`, if present. */
  failureClass?: import('./core/task/failure.mts').ForgeFailureClass | string | null
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
  /** Daemon-side deterministic task dispatch resolver. Optional only for isolated
   *  legacy tests; constrained production definitions require it to resolve an
   *  exact approved plan before the first agent attempt. */
  taskDispatchResolver?: import('./core/task/dispatch-resolver.mts').TaskDispatchResolver
  /** Daemon-owned authoritative settings resolver for task runs. Optional only
   *  for isolated legacy tests; daemon bootstrap attaches the single
   *  TaskSettingsService resolver after constructing the workflow runner. */
  taskSettingsResolver?: TaskRunSettingsResolver
  /** Non-persistent invocation-layer settings carried to execution-time
   *  settings resolution. Never persisted by the daemon. */
  invocationSettings?: TaskSettingsLayer
}

/**
 * Task-run settings resolution shared between the daemon TaskSettingsService
 * (`resolveForRun`) and the execution kernel. Types are JSON-safe and
 * type-only; the daemon layer implements the resolver callback while core
 * execution only carries it. Invocation settings follow the public snake_case
 * `TaskSettingsLayer` DTO and are never persisted.
 */
export type TaskRunSettingsLayerName = 'system' | 'builtin' | 'user_global' | 'user_task' | 'invocation'

export interface TaskRunSettingsParams {
  taskName: string
  /** Builtin/project identity of the task being run. */
  kind?: 'builtin' | 'project'
  /** Project name required to isolate a stable per-task identity for project tasks. */
  project?: string
  /** TaskConfig-declared defaults (declared runtime/timeout/dispatch). */
  defaults?: {
    agentRuntime?: string
    timeoutMs?: number
    dispatch?: Record<string, unknown>
  }
  /** Optional public snake_case invocation settings layer. */
  invocation?: TaskSettingsLayer
}

export interface TaskRunSettingsResolution {
  mode: 'automatic' | 'explicit'
  /** The single exact runtime id the execution must launch ('forge/<profile>'). */
  exactAgentRuntime: string | null
  /** Resolved dispatch snapshot produced by the daemon resolver for this run. */
  dispatch: import('./core/operations/types.mts').TaskDispatchSnapshot | null
  /** Effective total task timeout after all layer merges. */
  timeoutMs: number | null
  /** Effective additional instructions, when any layer contributes them. */
  additionalInstructions?: string | null
  /** Per-field winning source layer. */
  sources: {
    selectionMode: TaskRunSettingsLayerName
    agentRuntime: TaskRunSettingsLayerName
    timeoutMs: TaskRunSettingsLayerName
    additionalInstructions: TaskRunSettingsLayerName
    automatic: Partial<Record<string, TaskRunSettingsLayerName>>
  }
}

export type TaskRunSettingsResolver = (
  params: TaskRunSettingsParams,
) => Promise<TaskRunSettingsResolution> | TaskRunSettingsResolution

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
import type { TaskDispatchResolver } from './core/task/dispatch-resolver.mts'
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
  TaskDispatchRequirements,
  GatePass,
  GateFail,
  GateContext,
  TaskGate,
} from './core/task/types.mts'

declare global {
  var defineTask: ((config: TaskConfig) => TaskDefinition) | undefined
  var agent: PrimitiveSet['agent'] | undefined
  var shell: PrimitiveSet['shell'] | undefined
  var checkpoint: CheckpointFn | undefined
  var foremanSchemas: ForemanSchemas | undefined
  var foremanInstructions: ForemanInstructions | undefined
}
