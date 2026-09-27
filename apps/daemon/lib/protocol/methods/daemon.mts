import type { JsonSchema } from '../jsonrpc.mts'

export interface DaemonShutdownParams {
  reason?: string
  force?: boolean
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
    force: { type: 'boolean' },
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

// ── daemon.status ─────────────────────────────────────────────────────

export interface DaemonStatusParams {}

export interface DaemonStatusResult {
  ok: true
  shutting_down: boolean
  idle: boolean
  activeTaskCount: number
  activeWorkflowCount: number
  activeExecutionCount: number
}

export const daemonStatusParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const daemonStatusResultSchema = {
  type: 'object',
  required: ['ok', 'shutting_down', 'idle', 'activeTaskCount', 'activeWorkflowCount', 'activeExecutionCount'],
  properties: {
    ok: { const: true },
    shutting_down: { type: 'boolean' },
    idle: { type: 'boolean' },
    activeTaskCount: { type: 'integer', minimum: 0 },
    activeWorkflowCount: { type: 'integer', minimum: 0 },
    activeExecutionCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
