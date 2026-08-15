import type { JsonSchema } from '../jsonrpc.mts'

export type PmTicketStatus = 'todo' | 'in_progress' | 'done' | 'blocked'
export type PmTicketKind = 'main' | 'sub'

export interface PmTicketAssignee {
  session_id: string
}

export interface PmTicket {
  id: string
  kind: PmTicketKind
  project_id: string
  title: string
  description?: string
  status: PmTicketStatus
  parent_id?: string
  assignee?: PmTicketAssignee
  created_at: string
  updated_at: string
}

// create

export interface PmTicketCreateMainParams {
  kind: 'main'
  project_id: string
  title: string
  description?: string
  assignee?: PmTicketAssignee
}

export interface PmTicketCreateSubParams {
  kind: 'sub'
  project_id: string
  title: string
  description?: string
  parent_id: string
}

export type PmTicketCreateParams = PmTicketCreateMainParams | PmTicketCreateSubParams

export interface PmTicketCreateResult {
  ticket: PmTicket
}

// get

export interface PmTicketGetParams {
  id: string
}

export interface PmTicketGetResult {
  ticket: PmTicket
}

// list

export interface PmTicketListParams {
  project_id: string
  kind?: PmTicketKind
  status?: PmTicketStatus
  parent_id?: string
  assignee_session_id?: string
}

export interface PmTicketListResult {
  tickets: PmTicket[]
  count: number
}

// update

export interface PmTicketEditParams {
  action: 'edit'
  id: string
  title?: string
  description?: string | null
  assignee?: PmTicketAssignee | null
}

export interface PmTicketSetStatusParams {
  action: 'set_status'
  id: string
  status: PmTicketStatus
}

export type PmTicketUpdateParams = PmTicketEditParams | PmTicketSetStatusParams

export interface PmTicketUpdateResult {
  ticket: PmTicket
}

// delete

export interface PmTicketDeleteParams {
  id: string
}

export interface PmTicketDeleteResult {
  deleted: true
  id: string
}

// --- Schemas ---

const sessionIdSchema = {
  type: 'object',
  required: ['session_id'],
  properties: {
    session_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const statusSchema = {
  enum: ['todo', 'in_progress', 'done', 'blocked'],
} as const satisfies JsonSchema

const kindSchema = {
  enum: ['main', 'sub'],
} as const satisfies JsonSchema

const ticketAssigneeSchema = sessionIdSchema

const pmTicketSchema = {
  type: 'object',
  required: ['id', 'kind', 'project_id', 'title', 'status', 'created_at', 'updated_at'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: kindSchema,
    project_id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    status: statusSchema,
    parent_id: { type: 'string' },
    assignee: ticketAssigneeSchema,
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const assigneeSchema = ticketAssigneeSchema

const nullableAssigneeSchema = {
  anyOf: [
    ticketAssigneeSchema,
    { type: 'null' },
  ],
} as const satisfies JsonSchema

export const pmTicketCreateParamsSchema = {
  type: 'object',
  required: ['kind', 'project_id', 'title'],
  anyOf: [
    {
      properties: {
        kind: { const: 'main' },
        assignee: assigneeSchema,
      },
      required: ['kind'],
    },
    {
      properties: {
        kind: { const: 'sub' },
        parent_id: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'parent_id'],
    },
  ],
  properties: {
    kind: kindSchema,
    project_id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    parent_id: { type: 'string', minLength: 1 },
    assignee: assigneeSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const pmTicketCreateResultSchema = {
  type: 'object',
  required: ['ticket'],
  properties: {
    ticket: pmTicketSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const pmTicketGetParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const pmTicketGetResultSchema = pmTicketCreateResultSchema

export const pmTicketListParamsSchema = {
  type: 'object',
  required: ['project_id'],
  properties: {
    project_id: { type: 'string', minLength: 1 },
    kind: kindSchema,
    status: statusSchema,
    parent_id: { type: 'string' },
    assignee_session_id: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const pmTicketListResultSchema = {
  type: 'object',
  required: ['tickets', 'count'],
  properties: {
    tickets: { type: 'array', items: pmTicketSchema },
    count: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const pmTicketUpdateParamsSchema = {
  type: 'object',
  required: ['id', 'action'],
  anyOf: [
    {
      properties: {
        action: { const: 'edit' },
      },
      required: ['action'],
    },
    {
      properties: {
        action: { const: 'set_status' },
        status: statusSchema,
      },
      required: ['action', 'status'],
    },
  ],
  properties: {
    id: { type: 'string', minLength: 1 },
    action: { enum: ['edit', 'set_status'] },
    title: { type: 'string', minLength: 1 },
    description: {
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
    },
    assignee: nullableAssigneeSchema,
    status: statusSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const pmTicketUpdateResultSchema = pmTicketCreateResultSchema

export const pmTicketDeleteParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const pmTicketDeleteResultSchema = {
  type: 'object',
  required: ['deleted', 'id'],
  properties: {
    deleted: { const: true },
    id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
