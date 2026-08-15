/**
 * Agent protocol methods: agent.sync, agent.list, agent.compact, agent.graph.review,
 * agent.model.list, agent.model.set
 */

import type { JsonSchema } from '../jsonrpc.mts'

// ─── agent.list ──────────────────────────────────────────────────────

export interface AgentListParams {
  // empty
}

export interface AgentEntry {
  address: string
  kind: string
  status: string
  last_seq: number
  queue_depth: number
  model: string
}

export interface AgentListResult {
  agents: AgentEntry[]
}

export const agentListParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const agentListResultSchema = {
  type: 'object',
  required: ['agents'],
  properties: {
    agents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['address', 'kind', 'status', 'last_seq', 'queue_depth', 'model'],
        properties: {
          address: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          last_seq: { type: 'integer' },
          queue_depth: { type: 'integer' },
          model: { type: 'string' },
        },
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── agent.sync ──────────────────────────────────────────────────────

export interface AgentSyncParams {
  address: string
  after_seq?: number
  limit?: number
  wait_ms?: number
}

export interface AgentSyncResult {
  events: Array<{
    seq: number
    turn_seq?: number
    kind: string
    payload: unknown
    created_at: string
  }>
  next_seq: number
  has_more: boolean
  state: string
  /** Number of branch turns currently in flight for the address. */
  running_branches: number
}

export const agentSyncParamsSchema = {
  type: 'object',
  required: ['address'],
  properties: {
    address: { type: 'string', minLength: 1 },
    after_seq: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    wait_ms: { type: 'integer', minimum: 0, maximum: 60000 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const agentSyncResultSchema = {
  type: 'object',
  required: ['events', 'next_seq', 'has_more', 'state'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['seq', 'kind', 'payload', 'created_at'],
        properties: {
          seq: { type: 'integer' },
          turn_seq: { type: 'integer' },
          kind: { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
          created_at: { type: 'string' },
        },
      },
    },
    next_seq: { type: 'integer' },
    has_more: { type: 'boolean' },
    state: { type: 'string' },
    running_branches: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── agent.compact ───────────────────────────────────────────────────

export interface AgentCompactParams {
  address: string
}

export interface AgentCompactResult {
  compact_seq: number
  covers_through_seq: number
}

export const agentCompactParamsSchema = {
  type: 'object',
  required: ['address'],
  properties: {
    address: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const agentCompactResultSchema = {
  type: 'object',
  required: ['compact_seq', 'covers_through_seq'],
  properties: {
    compact_seq: { type: 'integer' },
    covers_through_seq: { type: 'integer' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── agent.graph.review ──────────────────────────────────────────────

export interface AgentGraphReviewParams {
  address: string
  graph_id: string
  patch_id: string
  decision: 'confirm' | 'reject'
  client_action_id: string
}

export interface AgentGraphReviewResult {
  status: string
}

export const agentGraphReviewParamsSchema = {
  type: 'object',
  required: ['address', 'graph_id', 'patch_id', 'decision', 'client_action_id'],
  properties: {
    address: { type: 'string', minLength: 1 },
    graph_id: { type: 'string', minLength: 1 },
    patch_id: { type: 'string', minLength: 1 },
    decision: { type: 'string', enum: ['confirm', 'reject'] },
    client_action_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const agentGraphReviewResultSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── agent.model.list ────────────────────────────────────────────────

export interface AgentModelListParams {
  // empty
}

export interface AgentModelListResult {
  current: string
  available: string[]
}

export const agentModelListParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const agentModelListResultSchema = {
  type: 'object',
  required: ['current', 'available'],
  properties: {
    current: { type: 'string' },
    available: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── agent.model.set ─────────────────────────────────────────────────

export interface AgentModelSetParams {
  address: string
  model: string
}

export interface AgentModelSetResult {
  ok: boolean
  current: string
  available: string[]
  error?: string
}

export const agentModelSetParamsSchema = {
  type: 'object',
  required: ['address', 'model'],
  properties: {
    address: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const agentModelSetResultSchema = {
  type: 'object',
  required: ['ok', 'current', 'available'],
  properties: {
    ok: { type: 'boolean' },
    current: { type: 'string' },
    available: {
      type: 'array',
      items: { type: 'string' },
    },
    error: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
