/**
 * Transport-neutral protocol surface for native FWA operations.
 */

import type { JsonSchema } from '../jsonrpc.mts'

// ─── fwa.assign ───────────────────────────────────────────────────

export interface FwaAssignParams {
  ticket_id: string
  project_id: string
  prompt: string
}

export interface FwaAssignResult {
  session: {
    id: string
    message_address: string
    ticket_id: string
    project_id: string
    status: string
    queue_depth: number
    graph_refs: string[]
    task_refs: string[]
  }
}

export const fwaAssignParamsSchema = {
  type: 'object',
  required: ['ticket_id', 'project_id', 'prompt'],
  properties: {
    ticket_id: { type: 'string', minLength: 1 },
    project_id: { type: 'string', minLength: 1 },
    prompt: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const fwaAssignResultSchema = {
  type: 'object',
  required: ['session'],
  properties: {
    session: {
      type: 'object',
      required: ['id', 'message_address', 'ticket_id', 'project_id', 'status', 'queue_depth', 'graph_refs', 'task_refs'],
      properties: {
        id: { type: 'string' },
        message_address: { type: 'string' },
        ticket_id: { type: 'string' },
        project_id: { type: 'string' },
        status: { type: 'string' },
        queue_depth: { type: 'integer' },
        graph_refs: { type: 'array', items: { type: 'string' } },
        task_refs: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── fwa.list ────────────────────────────────────────────────────────

export interface FwaListParams {
  // empty
}

export interface FwaListResult {
  sessions: Array<{
    id: string
    message_address: string
    ticket_id: string
    project_id: string
    status: string
    queue_depth: number
    graph_refs: string[]
    task_refs: string[]
  }>
}

export const fwaListParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const fwaListResultSchema = {
  type: 'object',
  required: ['sessions'],
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'message_address', 'ticket_id', 'project_id', 'status', 'queue_depth', 'graph_refs', 'task_refs'],
        properties: {
          id: { type: 'string' },
          message_address: { type: 'string' },
          ticket_id: { type: 'string' },
          project_id: { type: 'string' },
          status: { type: 'string' },
          queue_depth: { type: 'integer' },
          graph_refs: { type: 'array', items: { type: 'string' } },
          task_refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── fwa.status ──────────────────────────────────────────────────────

export interface FwaStatusParams {
  session_id: string
}

export interface FwaStatusResult {
  session_id: string
  message_address: string
  ticket_id: string
  project_id: string
  status: string
  queue_depth: number
  active_turn_seq: number | null
  last_error: string | null
  graph_refs: string[]
  task_refs: string[]
  created_at: string
  updated_at: string
}

export const fwaStatusParamsSchema = {
  type: 'object',
  required: ['session_id'],
  properties: {
    session_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const fwaStatusResultSchema = {
  type: 'object',
  required: ['session_id', 'message_address', 'ticket_id', 'project_id', 'status', 'queue_depth'],
  properties: {
    session_id: { type: 'string' },
    message_address: { type: 'string' },
    ticket_id: { type: 'string' },
    project_id: { type: 'string' },
    status: { type: 'string' },
    queue_depth: { type: 'integer' },
    active_turn_seq: { type: ['integer', 'null'] },
    last_error: { type: ['string', 'null'] },
    graph_refs: { type: 'array', items: { type: 'string' } },
    task_refs: { type: 'array', items: { type: 'string' } },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── fwa.transcript ──────────────────────────────────────────────────

export interface FwaTranscriptParams {
  session_id: string
}

export interface FwaTranscriptResult {
  entries: Array<{
    seq: number
    role: string
    content: string
    tool_call_id?: string
    tool_name?: string
    created_at: string
  }>
}

export const fwaTranscriptParamsSchema = {
  type: 'object',
  required: ['session_id'],
  properties: {
    session_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const fwaTranscriptResultSchema = {
  type: 'object',
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['seq', 'role', 'content', 'created_at'],
        properties: {
          seq: { type: 'integer' },
          role: { type: 'string' },
          content: { type: 'string' },
          tool_call_id: { type: 'string' },
          tool_name: { type: 'string' },
          created_at: { type: 'string' },
        },
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
