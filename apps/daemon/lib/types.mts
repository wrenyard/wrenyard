import type { ZodTypeAny } from 'zod'
import type { TaskSettingsLayer } from './protocol/methods/task.mts'
import type {
  Admission as GatewayRouteAdmission,
  RouteGuard as GatewayRouteGuard,
  RouteStatus,
} from '@wrenyard/gateway'

/**
 * Optional daemon-owned native-task route-state port. The daemon binds it to
 * the single shared Gateway circuit; isolated/legacy callers omit it and then
 * never touch route health. Identities are the route's provider on its own plus
 * its bare model key: any client suffix is stripped before the health key is
 * built, so a native fault never keys by client.
 */
export interface TaskRouteStateHooks {
  /** Admit/check one exact route before launching a model attempt. */
  admit: (provider: string, model: string, mode?: 'native' | 'gateway') => GatewayRouteAdmission
  /** Report a schema-validated delivery; it clears the faults observed at admission. */
  success: (provider: string, model: string, guard?: GatewayRouteGuard) => void
  /** Report a route-local fault for a launched attempt that failed terminally,
   *  with the classified fault. The payload is
   *  either the structured-output delivery failure or the upstream error the
   *  failed execution reported; an upstream error without a status records no
   *  fault. */
  fault: (
    provider: string,
    model: string,
    guard: GatewayRouteGuard | undefined,
    fault: TaskRouteFault,
  ) => RouteStatus | undefined
}

export type JsonSchema = boolean | Record<string, unknown>

export interface AgentOpts {
  workingDirectory?: string
  timeoutMs?: number
  resume?: string
  /** Repository write coordination, independent of client execution access. */
  repoWriteLock?: boolean
  taskId?: string
  features?: readonly string[]
  /** Canonical exact file paths used only for Foreman's write-lock admission. */
  writePaths?: readonly string[]
  /** Original requested agent runtime carried separately from the exact
   *  execution profile chosen by the daemon dispatch resolver. */
  requestedAgentRuntime?: string
  /** Per-attempt dispatch snapshot produced by the daemon resolver. */
  dispatchSnapshot?: import('./core/operations/types.mts').TaskDispatchSnapshot | null
  /** Private non-persistent CodeBuddy admission binding. */
  codeBuddyExecution?: import('./core/operations/types.mts').CodeBuddyExecutionBinding
  /** Canonical agent-runtime failure class, when classified by the runtime. */
  failureClass?: import('@wrenyard/task').AgentFailureClass | string | null
}

export interface AgentResult {
  output: string
  status: 'done' | 'failed' | 'cancelled'
  /** Time the execution waited in the queue before its process launched. */
  queueWaitMs?: number
  nativeSessionId?: string
  /** Concrete execution profile captured from the terminal stream event.
   *  Set when the runtime reports a resolved agent runtime profile; undefined
   *  for initial runs and for runtimes that do not report one. */
  resolvedProfile?: string
  /** Original requested agent runtime, distinct from the exact execution profile. */
  requestedAgentRuntime?: string
  /** Per-attempt dispatch snapshot produced by the daemon resolver. */
  dispatchSnapshot?: import('./core/operations/types.mts').TaskDispatchSnapshot | null
  /** Canonical agent-runtime failure class captured from `run_finished`, if present. */
  failureClass?: import('@wrenyard/task').AgentFailureClass | string | null
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
  /** MCP connection id that triggered the run (for cc-channel session targeting) */
  connectingId?: string
  /** Bounded JSON-safe context inherited from a direct run or TaskGraph. */
  taskContext?: import('@wrenyard/task').TaskContext
  /** Daemon-side deterministic task dispatch resolver. Optional only for isolated
   *  legacy tests; constrained production definitions require it to resolve an
   *  exact approved plan before the first agent attempt. */
  taskDispatchResolver?: import('@wrenyard/task').TaskDispatchResolver
  /** Daemon-owned authoritative settings resolver for task runs. Optional only
   *  for isolated legacy tests; daemon bootstrap attaches the single
   *  TaskSettingsService resolver after constructing the workflow runner. */
  taskSettingsResolver?: TaskRunSettingsResolver
  /** Optional daemon-owned native-task route-state port bound to the shared
   *  Gateway circuit. Absent for isolated legacy tests, which then launch
   *  without touching circuit health. */
  taskRouteState?: TaskRouteStateHooks
  /** Non-persistent invocation-layer settings carried to execution-time
   *  settings resolution. Never persisted by the daemon. */
  invocationSettings?: TaskSettingsLayer
  /** In-process auxiliary model-call port for one task-output compile per run. */
  taskOutputModelCall?: import('./daemon/execution/task-output-model-call.mts').TaskOutputModelCallPort
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
  /** Estimated rendered input, calculated by the execution kernel. */
  inputTokens?: number
  taskName: string
  /** Builtin/project identity of the task being run. */
  kind?: 'builtin' | 'project'
  /** Project name required to isolate a stable per-task identity for project tasks. */
  project?: string
  /** TaskConfig-declared defaults (dispatch; never a runtime pin). */
  defaults?: {
    dispatch?: Record<string, unknown>
  }
  /** Optional public snake_case invocation settings layer. */
  invocation?: TaskSettingsLayer
  /** Feature ids actually mounted for this input (not the declared tool
   *  surface), used for input-specific automatic-routing preferences. */
  mountedFeatures?: readonly string[]
}

export interface TaskRunSettingsResolution {
  /** The single exact canonical execution target the run must launch
   *  ('<provider>/<model>:<client>'). Populated by the automatic selection as
   *  the only launched runtime. */
  exactAgentRuntime: string | null
  /** Resolved dispatch snapshot produced by the daemon resolver for this run. */
  dispatch: import('./core/operations/types.mts').TaskDispatchSnapshot | null
  /** Private CodeBuddy admission binding captured with this resolution. Never
   * persisted or projected through public task settings/telemetry DTOs. */
  codeBuddyExecution?: import('./core/operations/types.mts').CodeBuddyExecutionBinding
  /** Effective global task run time limit in minutes after all layer merges. */
  runTimeLimitMinutes: number | null
  /** Per-field winning source layer. */
  sources: {
    runTimeLimitMinutes: TaskRunSettingsLayerName
    automatic: Partial<Record<string, TaskRunSettingsLayerName>>
  }
}

export type TaskRunSettingsResolver = (
  params: TaskRunSettingsParams,
) => Promise<TaskRunSettingsResolution> | TaskRunSettingsResolution

// ── Task-domain types re-export shim ─────────────────────────────────
//
// The task-domain types (TaskConfig / TaskDefinition / RegisteredTask /
// TaskRunResult / TaskListEntry / TaskGate / GatePass / GateFail /
// GateContext) now live in the `@wrenyard/task` package as the single source
// of truth (Core Concept 7). They are re-exported here so the existing files
// importing from `lib/types.mts` do not need to change their import paths.
// New code should import directly from `@wrenyard/task`.
//
// `TaskExecutionResult` stays daemon-side because it references the
// daemon-local `AgentResult`.
//
// `import type` brings the types into local module scope so the
// `declare global` block below can reference `TaskConfig` / `TaskDefinition`
// without resolving to undefined names.

import type {
  TaskConfig,
  TaskDefinition,
  TaskDispatchResolver,
  TaskRouteFault,
  ForemanSchemas,
} from '@wrenyard/task'
import type { ForemanInstructions } from './standard/instructions/index.mts'

export type {
  TaskSchemaInput,
  TaskConfig,
  TaskDefinition,
  TaskDeclaration,
  TaskInheritedDeclaration,
  InheritanceChainEntry,
  RegisteredTask,
  TaskRunResult,
  TaskListEntry,
  TaskDispatchRequirements,
  GatePass,
  GateFail,
  GateContext,
  TaskGate,
} from '@wrenyard/task'

/** Daemon-side execution result; references the daemon-local `AgentResult`. */
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

/**
 * Authoring global overloads. A complete `TaskConfig` must declare
 * input/output/prompt; an inherited `TaskInheritedDeclaration` must declare
 * `extends` and may only layer the inherited fields. Overload excess-property
 * checking makes a mixed/forbidden shape (for example `extends` plus `input`)
 * a compile-time error.
 */
export interface DefineTask {
  (config: TaskConfig): TaskDefinition
  (config: import('@wrenyard/task').TaskInheritedDeclaration): TaskDefinition
}

declare global {
  var defineTask: DefineTask | undefined
  var agent: PrimitiveSet['agent'] | undefined
  var shell: PrimitiveSet['shell'] | undefined
  var checkpoint: CheckpointFn | undefined
  var foremanSchemas: ForemanSchemas | undefined
  var foremanInstructions: ForemanInstructions | undefined
}
