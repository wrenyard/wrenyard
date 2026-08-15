import type { JsonSchema } from '../jsonrpc.mts'

export interface DaemonShutdownParams {
  reason?: string
}

export interface DaemonShutdownResult {
  ok: true
  shutting_down: true
  reason: string
}

export const daemonShutdownParamsSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const daemonShutdownResultSchema = {
  type: 'object',
  required: ['ok', 'shutting_down', 'reason'],
  properties: {
    ok: { const: true },
    shutting_down: { const: true },
    reason: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ── daemon.freeze ─────────────────────────────────────────────────────

export interface DaemonFreezeParams {}

export interface DaemonFreezeResult {
  ok: true
  frozen: boolean
  accepting: boolean
  activeTasks: string[]
  activeTaskCount: number
  activeWorkflows: string[]
  activeWorkflowCount: number
  activeExecutions: string[]
  activeExecutionCount: number
}

export const daemonFreezeParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const daemonFreezeResultSchema = {
  type: 'object',
  required: ['ok', 'frozen', 'accepting', 'activeTasks', 'activeTaskCount', 'activeWorkflows', 'activeWorkflowCount', 'activeExecutions', 'activeExecutionCount'],
  properties: {
    ok: { const: true },
    frozen: { type: 'boolean' },
    accepting: { type: 'boolean' },
    activeTasks: { type: 'array', items: { type: 'string' } },
    activeTaskCount: { type: 'integer', minimum: 0 },
    activeWorkflows: { type: 'array', items: { type: 'string' } },
    activeWorkflowCount: { type: 'integer', minimum: 0 },
    activeExecutions: { type: 'array', items: { type: 'string' } },
    activeExecutionCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ── daemon.thaw ───────────────────────────────────────────────────────

export interface DaemonThawParams {}

export interface DaemonThawResult {
  ok: true
  frozen: boolean
  accepting: boolean
  activeTasks: string[]
  activeTaskCount: number
  activeWorkflows: string[]
  activeWorkflowCount: number
  activeExecutions: string[]
  activeExecutionCount: number
}

export const daemonThawParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const daemonThawResultSchema = {
  type: 'object',
  required: ['ok', 'frozen', 'accepting', 'activeTasks', 'activeTaskCount', 'activeWorkflows', 'activeWorkflowCount', 'activeExecutions', 'activeExecutionCount'],
  properties: {
    ok: { const: true },
    frozen: { type: 'boolean' },
    accepting: { type: 'boolean' },
    activeTasks: { type: 'array', items: { type: 'string' } },
    activeTaskCount: { type: 'integer', minimum: 0 },
    activeWorkflows: { type: 'array', items: { type: 'string' } },
    activeWorkflowCount: { type: 'integer', minimum: 0 },
    activeExecutions: { type: 'array', items: { type: 'string' } },
    activeExecutionCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ── daemon.drain ──────────────────────────────────────────────────────

export const DAEMON_DRAIN_DEFAULT_TIMEOUT_MS = 30_000

export interface DaemonDrainParams {
  timeout_ms?: number
}

export interface DaemonDrainResult {
  drained: boolean
  activeTaskCount: number
  activeWorkflowCount: number
  activeExecutionCount: number
  activeTasks: string[]
  activeWorkflows: string[]
  activeExecutions: string[]
}

export const daemonDrainParamsSchema = {
  type: 'object',
  properties: {
    timeout_ms: { type: 'integer', minimum: 1, maximum: 300_000 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const daemonDrainResultSchema = {
  type: 'object',
  required: ['drained', 'activeTasks', 'activeTaskCount', 'activeWorkflows', 'activeWorkflowCount', 'activeExecutions', 'activeExecutionCount'],
  properties: {
    drained: { type: 'boolean' },
    activeTasks: { type: 'array', items: { type: 'string' } },
    activeTaskCount: { type: 'integer', minimum: 0 },
    activeWorkflows: { type: 'array', items: { type: 'string' } },
    activeWorkflowCount: { type: 'integer', minimum: 0 },
    activeExecutions: { type: 'array', items: { type: 'string' } },
    activeExecutionCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ── daemon.status ─────────────────────────────────────────────────────

export interface DaemonStatusParams {}

export interface DaemonStatusResult {
  ok: true
  mode: 'accepting' | 'frozen' | 'planned_restart'
  frozen: boolean
  accepting: boolean
  activeTasks: string[]
  activeTaskCount: number
  activeWorkflows: string[]
  activeWorkflowCount: number
  activeExecutions: string[]
  activeExecutionCount: number
  active_task_count: number
  active_workflow_count: number
  active_execution_count: number
  recovery_required: boolean
  operation_id?: string
  kind?: 'update' | 'restart'
  phase?: 'preparing' | 'draining' | 'updating' | 'stopping' | 'starting' | 'verifying' | 'completed' | 'failed'
}

export const daemonStatusParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const daemonStatusResultSchema = {
  type: 'object',
  required: ['ok', 'mode', 'frozen', 'accepting', 'activeTasks', 'activeTaskCount', 'activeWorkflows', 'activeWorkflowCount', 'activeExecutions', 'activeExecutionCount', 'active_task_count', 'active_workflow_count', 'active_execution_count', 'recovery_required'],
  properties: {
    ok: { const: true },
    mode: { type: 'string', enum: ['accepting', 'frozen', 'planned_restart'] },
    frozen: { type: 'boolean' },
    accepting: { type: 'boolean' },
    activeTasks: { type: 'array', items: { type: 'string' } },
    activeTaskCount: { type: 'integer', minimum: 0 },
    activeWorkflows: { type: 'array', items: { type: 'string' } },
    activeWorkflowCount: { type: 'integer', minimum: 0 },
    activeExecutions: { type: 'array', items: { type: 'string' } },
    activeExecutionCount: { type: 'integer', minimum: 0 },
    active_task_count: { type: 'integer', minimum: 0 },
    active_workflow_count: { type: 'integer', minimum: 0 },
    active_execution_count: { type: 'integer', minimum: 0 },
    recovery_required: { type: 'boolean' },
    operation_id: { type: 'string' },
    kind: { type: 'string', enum: ['update', 'restart'] },
    phase: { type: 'string', enum: ['preparing', 'draining', 'updating', 'stopping', 'starting', 'verifying', 'completed', 'failed'] },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
