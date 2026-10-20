import type { JsonSchema } from '../common/jsonrpc'

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
  /**
   * Active taskgraph runs, distinct from the legacy `activeWorkflowCount`. The
   * daemon always returns it; the schema keeps it optional so responses from
   * older daemons that predate the field remain valid.
   */
  activeTaskGraphCount?: number
  lowDisk: { status: 'ok' | 'low' | 'unavailable'; availableBytes: number | null; minimumBytes: number; error: string | null }
}

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
export interface HealthPingParams {}

export interface HealthPingResult {
  ok: true
  /**
   * Integer IPC protocol version. Clients send their expected version in the
   * handshake params and validate this echoed value; a missing value fails the
   * client handshake closed.
   */
  protocolVersion: number
  uptimeMs?: number
  identity?: {
    mode: 'source' | 'installed'
    version?: string
    checkout?: string
    node?: string
  }
}
