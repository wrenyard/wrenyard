/**
 * Typed JSON-RPC params/results and JSON schemas for the workspace todo methods.
 *
 * Workspace todos are daemon-owned Markdown files under the configured
 * workspace root; every method addresses them by their short stable id. The
 * store is authoritative on the daemon, so no schema ever accepts a filesystem
 * root: the caller can only name a todo and its fields, never where it lives.
 * Execution-finished (`done`) and acceptance-passed (`accepted`) are separate
 * stored statuses.
 */

import type { JsonSchema } from '../jsonrpc.mts'
import type { Todo, TodoCreateInput, TodoUpdateInput } from '../../daemon/services/workspace-todo-service.mts'

// Re-export the authoritative service types so protocol consumers import them
// from the protocol module rather than reaching into the daemon service.
export type { Todo, TodoStatus, TodoCreateInput, TodoUpdateInput } from '../../daemon/services/workspace-todo-service.mts'

/** The complete, ordered set of valid todo statuses shared by every schema. */
const TODO_STATUS_VALUES = ['open', 'in_progress', 'done', 'accepted', 'cancelled'] as const

/** Status discriminator shared by every todo schema. */
const todoStatusProperty = {
  type: 'string',
  enum: TODO_STATUS_VALUES,
  description: "The todo status: 'open', 'in_progress', 'done', 'accepted' or 'cancelled'. 'done' (execution finished) and 'accepted' (acceptance passed) are distinct.",
} as const satisfies JsonSchema

/** The complete todo record returned by get/create/update and inside list. */
const todoSchema = {
  type: 'object',
  required: ['id', 'title', 'status', 'depends_on', 'created', 'updated', 'request', 'acceptance', 'attachments'],
  properties: {
    id: { type: 'string', description: 'The short stable path-safe todo id.' },
    title: { type: 'string', description: 'The human-readable todo title.' },
    status: todoStatusProperty,
    project: { type: 'string', description: 'The optional project label the todo belongs to.' },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'Ids of todos this todo depends on.' },
    created: { type: 'string', description: 'Creation time as an ISO 8601 timestamp.' },
    updated: { type: 'string', description: 'Last update time as an ISO 8601 timestamp.' },
    request: { type: 'string', description: 'The request section body.' },
    acceptance: { type: 'string', description: 'The acceptance criteria section body.' },
    attachments: { type: 'array', items: { type: 'string' }, description: 'Relative-path attachments.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── todo.list ─────────────────────────────────────────────────────

export type TodoListParams = Record<string, never>

export interface TodoListResult {
  todos: Todo[]
}

export const todoListParamsSchema = {
  type: 'object',
  description: 'List every workspace todo, ordered by id. Read-only.',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const todoListResultSchema = {
  type: 'object',
  description: 'Every workspace todo, ordered by id.',
  required: ['todos'],
  properties: {
    todos: { type: 'array', description: 'The matching todos.', items: todoSchema },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── todo.get ──────────────────────────────────────────────────────

export interface TodoGetParams {
  id: string
}

export interface TodoGetResult {
  todo: Todo
}

export const todoGetParamsSchema = {
  type: 'object',
  description: 'Read one workspace todo by its id. Refuses with missing when no such todo exists.',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, description: 'The short stable id of the todo to read.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const todoGetResultSchema = {
  type: 'object',
  description: 'The requested workspace todo.',
  required: ['todo'],
  properties: { todo: todoSchema },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── todo.create ───────────────────────────────────────────────────

export type TodoCreateParams = TodoCreateInput

export interface TodoCreateResult {
  todo: Todo
}

export const todoCreateParamsSchema = {
  type: 'object',
  description:
    "Create one workspace todo. The daemon generates the short stable id. Refuses with bad_title on an empty title, bad_status on an unknown status, bad_dependency/dependency_self/dependency_cycle on an invalid dependency list and bad_attachment on an absolute or escaping path. There is no caller-selectable filesystem root.",
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, description: 'The todo title.' },
    status: todoStatusProperty,
    project: { type: 'string', minLength: 1, description: 'The optional project label.' },
    depends_on: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Ids of existing todos this todo depends on; the combined graph must stay acyclic.',
    },
    request: { type: 'string', description: 'The request section body.' },
    acceptance: { type: 'string', description: 'The acceptance criteria section body.' },
    attachments: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Relative-path attachments; absolute or upward-escaping paths are refused.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const todoCreateResultSchema = {
  type: 'object',
  description: 'The created workspace todo.',
  required: ['todo'],
  properties: { todo: todoSchema },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── todo.update ───────────────────────────────────────────────────

export type TodoUpdateParams = TodoUpdateInput

export interface TodoUpdateResult {
  todo: Todo
}

export const todoUpdateParamsSchema = {
  type: 'object',
  description:
    "Update one existing workspace todo by id. Absent fields are kept; id and created are immutable and updated is refreshed. Refuses with missing when no such todo exists and the same field validations as todo.create.",
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, description: 'The short stable id of the todo to update.' },
    title: { type: 'string', minLength: 1, description: 'The new todo title.' },
    status: todoStatusProperty,
    project: { type: 'string', minLength: 1, description: 'The new project label.' },
    depends_on: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'The new dependency ids; the combined graph must stay acyclic.',
    },
    request: { type: 'string', description: 'The new request section body.' },
    acceptance: { type: 'string', description: 'The new acceptance criteria section body.' },
    attachments: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'The new relative-path attachments; absolute or upward-escaping paths are refused.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const todoUpdateResultSchema = {
  type: 'object',
  description: 'The updated workspace todo.',
  required: ['todo'],
  properties: { todo: todoSchema },
  additionalProperties: false,
} as const satisfies JsonSchema
