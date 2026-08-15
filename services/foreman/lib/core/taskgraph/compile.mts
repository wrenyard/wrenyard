// ─── Compact literal task-graph compiler ──────────────────────────────────────
//
// Pure, dependency-free expansion of a compact literal-task DAG description
// into the existing full TaskGraph create IR. The compiler validates only
// compact-form invariants with stable concise errors (object shape, non-empty
// project, non-empty steps, unique non-reserved ids, deps/return_nodes
// referencing declared steps, no self dependency). Cycles and task definition
// contracts are owned by the existing daemon validator at create time; this
// module never imports client, protocol, or server layers and never bypasses
// server validation.
//
// The compiled output is deterministic: start node first, steps in input
// order, end node last, with literal action params (no $inputs templates).

import type {
  JsonObject,
  NodeId,
  ObjectJsonSchema,
  TaskGraphNode,
} from './model.mts'
import {
  normalizeTaskContext,
  TaskContextError,
  type TaskContext,
} from '../task/context.mts'

// ─── Compact input types ─────────────────────────────────────────────────────

export interface CompactTaskStep {
  id: string
  task: string
  name?: string
  project?: string
  input?: JsonObject
  deps?: string[]
}

export interface CompactTaskGraphInput {
  project: string
  tg_ctx?: TaskContext
  title?: string
  on_node_failure?: 'pause' | 'cancel'
  timeout_ms?: number
  steps: CompactTaskStep[]
  return_nodes?: string[]
}

/** Service-layer full-graph IR. Protocol create is template-only; compact run
 *  creates `template: "default"` then patches these nodes in. */
export interface CompactTaskGraphCreateParams {
  graph: {
    nodes: Record<NodeId, TaskGraphNode>
  }
  project: string
  tg_ctx?: TaskContext
  title?: string
  on_node_failure: 'pause' | 'cancel'
}

export interface CompactTaskGraphCompiled {
  /** Deterministic full-graph create params (start + steps + end). */
  create: CompactTaskGraphCreateParams
  /** Normalized wait timeout; present only when the compact input requested one. */
  timeout_ms?: number
  /** Normalized requested return node ids (defaults to leaf steps). */
  return_nodes: string[]
}

/**
 * Internal normalized step shape produced by parsing/validation: `deps` is
 * required (defaulted to `[]`) so every internal dependency iteration is
 * statically safe. The exported {@link CompactTaskStep} keeps `deps` optional
 * for compact input authors.
 */
interface NormalizedTaskStep {
  id: string
  task: string
  name?: string
  project?: string
  input?: JsonObject
  deps: string[]
}

// ─── Stable concise compile errors ───────────────────────────────────────────

export const COMPACT_TASKGRAPH_ERROR_CODES = [
  'INVALID_INPUT',
  'PROJECT_REQUIRED',
  'STEPS_REQUIRED',
  'STEP_INVALID',
  'DUPLICATE_STEP_ID',
  'RESERVED_STEP_ID',
  'DEPS_INVALID',
  'SELF_DEP',
  'UNKNOWN_DEP',
  'RETURN_NODES_INVALID',
  'UNKNOWN_RETURN_NODE',
  'CTX_INVALID',
] as const

export type CompactTaskGraphErrorCode = (typeof COMPACT_TASKGRAPH_ERROR_CODES)[number]

export class CompactTaskGraphError extends Error {
  readonly code: CompactTaskGraphErrorCode

  constructor(code: CompactTaskGraphErrorCode, message: string) {
    super(message)
    this.name = 'CompactTaskGraphError'
    this.code = code
  }
}

const RESERVED_IDS = new Set<string>(['start', 'end'])

/** Empty strict input schema — the graph owns no wiring slots. */
const EMPTY_INPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

/** Empty object output schema — daemon task-contract materialization fills it. */
const EMPTY_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

/**
 * Compile a compact literal-task DAG description into full TaskGraph create
 * params plus normalized timeout/return-node metadata.
 *
 * Pure and deterministic: the input object is never mutated, no I/O is
 * performed, and identical inputs always produce structurally identical
 * outputs. Compact-form mistakes throw {@link CompactTaskGraphError} with a
 * stable `code` before any client call can be made.
 */
export function compileCompactTaskGraph(input: unknown): CompactTaskGraphCompiled {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CompactTaskGraphError('INVALID_INPUT', 'compact task graph must be a JSON object')
  }
  const raw = input as Record<string, unknown>

  const rawSteps = raw.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new CompactTaskGraphError('STEPS_REQUIRED', 'steps must be a non-empty array')
  }

  const project = raw.project
  if (typeof project !== 'string' || !project.trim()) {
    throw new CompactTaskGraphError('PROJECT_REQUIRED', 'project must be a non-empty string')
  }
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined
  const onNodeFailure: 'pause' | 'cancel' = raw.on_node_failure === 'pause' ? 'pause' : 'cancel'
  const timeoutMs = typeof raw.timeout_ms === 'number'
    && Number.isInteger(raw.timeout_ms) && raw.timeout_ms >= 1
    ? raw.timeout_ms
    : undefined
  let taskGraphContext: TaskContext | undefined
  if (raw.tg_ctx !== undefined) {
    try {
      taskGraphContext = normalizeTaskContext(raw.tg_ctx, 'tg_ctx')
    } catch (error) {
      if (error instanceof TaskContextError) {
        throw new CompactTaskGraphError('CTX_INVALID', error.message)
      }
      throw error
    }
  }

  // ── Parse steps: shape, unique non-reserved ids, task names ────────────────
  const steps: NormalizedTaskStep[] = []
  const declared = new Set<NodeId>()
  for (let i = 0; i < rawSteps.length; i++) {
    const rawStep = rawSteps[i]
    if (rawStep === null || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      throw new CompactTaskGraphError('STEP_INVALID', `steps[${i}]: expected an object`)
    }
    const step = rawStep as Record<string, unknown>
    const id = typeof step.id === 'string' && step.id.trim() ? step.id : undefined
    if (id === undefined) {
      throw new CompactTaskGraphError('STEP_INVALID', `steps[${i}]: step id must be a non-empty string`)
    }
    if (RESERVED_IDS.has(id)) {
      throw new CompactTaskGraphError('RESERVED_STEP_ID', `step id "${id}" is reserved`)
    }
    if (declared.has(id)) {
      throw new CompactTaskGraphError('DUPLICATE_STEP_ID', `duplicate step id "${id}"`)
    }
    const task = typeof step.task === 'string' && step.task.trim() ? step.task : undefined
    if (task === undefined) {
      throw new CompactTaskGraphError('STEP_INVALID', `step "${id}": task must be a non-empty string`)
    }

    const deps: string[] = []
    if (step.deps !== undefined) {
      if (!Array.isArray(step.deps) || step.deps.some((dep) => typeof dep !== 'string')) {
        throw new CompactTaskGraphError('DEPS_INVALID', `step "${id}": deps must be an array of step ids`)
      }
      deps.push(...(step.deps as string[]))
    }

    const compactStep: NormalizedTaskStep = { id, task, deps }
    if (typeof step.name === 'string' && step.name.trim()) compactStep.name = step.name
    if (typeof step.project === 'string' && step.project.trim()) compactStep.project = step.project
    if (
      step.input !== undefined && step.input !== null
      && typeof step.input === 'object' && !Array.isArray(step.input)
    ) {
      compactStep.input = step.input as JsonObject
    }

    steps.push(compactStep)
    declared.add(id)
  }

  // ── Dep graph: no self dependency, all deps declared (cycles → daemon) ─────
  const downstream = new Map<NodeId, Set<NodeId>>()
  for (const step of steps) downstream.set(step.id, new Set())
  for (const step of steps) {
    for (const dep of step.deps) {
      if (dep === step.id) {
        throw new CompactTaskGraphError('SELF_DEP', `step "${step.id}" cannot depend on itself`)
      }
      if (!declared.has(dep)) {
        throw new CompactTaskGraphError('UNKNOWN_DEP', `step "${step.id}" depends on unknown step "${dep}"`)
      }
      downstream.get(dep)?.add(step.id)
    }
  }

  // ── return_nodes: explicit (preserve order) or default to leaf steps ───────
  let returnNodes: string[]
  if (raw.return_nodes !== undefined) {
    if (!Array.isArray(raw.return_nodes) || raw.return_nodes.some((n) => typeof n !== 'string')) {
      throw new CompactTaskGraphError('RETURN_NODES_INVALID', 'return_nodes must be an array of declared step ids')
    }
    for (const node of raw.return_nodes as string[]) {
      if (!declared.has(node)) {
        throw new CompactTaskGraphError('UNKNOWN_RETURN_NODE', `return node "${node}" is not a declared step`)
      }
    }
    returnNodes = [...(raw.return_nodes as string[])]
  } else {
    returnNodes = steps
      .filter((step) => (downstream.get(step.id)?.size ?? 0) === 0)
      .map((step) => step.id)
  }

  // ── Expand into the full TaskGraph IR ─────────────────────────────────────
  const leafIds = steps
    .filter((step) => (downstream.get(step.id)?.size ?? 0) === 0)
    .map((step) => step.id)

  const nodes = Object.create(null) as Record<NodeId, TaskGraphNode>
  nodes.start = {
    id: 'start',
    name: 'start',
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: EMPTY_INPUT_SCHEMA,
    output_schema: EMPTY_OUTPUT_SCHEMA,
  }
  for (const step of steps) {
    const stepProject = step.project ?? project
    const params: JsonObject = {
      name: step.task,
      ...(stepProject !== undefined ? { project: stepProject } : {}),
      ...(step.input !== undefined ? { input: step.input } : {}),
    }
    nodes[step.id] = {
      id: step.id,
      name: step.name ?? step.id,
      action: { type: 'task', params },
      deps: step.deps.length > 0 ? [...step.deps] : ['start'],
      input: [],
      input_schema: EMPTY_INPUT_SCHEMA,
      output_schema: EMPTY_OUTPUT_SCHEMA,
    }
  }
  nodes.end = {
    id: 'end',
    name: 'end',
    action: { type: 'end', params: {} },
    deps: leafIds,
    input: [],
    input_schema: EMPTY_INPUT_SCHEMA,
    output_schema: EMPTY_OUTPUT_SCHEMA,
  }

  return {
    create: {
      graph: { nodes },
      project,
      ...(taskGraphContext ? { tg_ctx: taskGraphContext } : {}),
      ...(title !== undefined ? { title } : {}),
      on_node_failure: onNodeFailure,
    },
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    return_nodes: returnNodes,
  }
}
