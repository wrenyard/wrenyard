import type { JsonSchema } from '../jsonrpc.mts'

export interface HealthPingParams {}

export interface HealthPingResult {
  ok: true
  version?: string
  uptimeMs?: number
  dispatch?: {
    mode: 'accepting' | 'frozen' | 'planned_restart'
    frozen: boolean
    accepting: boolean
    activeTaskCount: number
    activeWorkflowCount: number
    activeExecutionCount: number
    active_task_count: number
    active_workflow_count: number
    active_execution_count: number
    recovery_required: boolean
    operation_id?: string
    kind?: 'update' | 'restart'
    phase?: 'preparing' | 'draining' | 'updating' | 'stopping' | 'starting' | 'verifying' | 'completed' | 'failed'
  }
}

export const healthPingParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const healthPingResultSchema = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { const: true },
    version: { type: 'string' },
    uptimeMs: { type: 'number', minimum: 0 },
    dispatch: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['accepting', 'frozen', 'planned_restart'] },
        frozen: { type: 'boolean' },
        accepting: { type: 'boolean' },
        activeTaskCount: { type: 'integer', minimum: 0 },
        activeWorkflowCount: { type: 'integer', minimum: 0 },
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
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
