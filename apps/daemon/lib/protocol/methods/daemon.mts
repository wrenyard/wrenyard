import type { JsonSchema } from '../jsonrpc.mts'


export type {
  DaemonShutdownParams,
  DaemonShutdownResult,
  DaemonStatusParams,
  DaemonStatusResult,
} from '@wrenyard/protocol/daemon'

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

export const daemonStatusParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const daemonStatusResultSchema = {
  type: 'object',
  required: ['ok', 'shutting_down', 'idle', 'activeTaskCount', 'activeWorkflowCount', 'activeExecutionCount', 'lowDisk'],
  properties: {
    ok: { const: true },
    shutting_down: { type: 'boolean' },
    idle: { type: 'boolean' },
    activeTaskCount: { type: 'integer', minimum: 0 },
    activeWorkflowCount: { type: 'integer', minimum: 0 },
    activeExecutionCount: { type: 'integer', minimum: 0 },
    // Optional (not in `required`) so a response from an older daemon that
    // predates this field still validates; the daemon always emits it.
    activeTaskGraphCount: { type: 'integer', minimum: 0 },
    lowDisk: { type: 'object', required: ['status', 'availableBytes', 'minimumBytes', 'error'], properties: { status: { type: 'string', enum: ['ok', 'low', 'unavailable'] }, availableBytes: { type: ['integer', 'null'], minimum: 0 }, minimumBytes: { type: 'integer', minimum: 0 }, error: { type: ['string', 'null'] } }, additionalProperties: false },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
