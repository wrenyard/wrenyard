/**
 * Typed JSON-RPC params/results and JSON schemas for the workspace todo methods.
 *
 * Workspace todos are daemon-owned Markdown files under the configured
 * workspace root; every method addresses them by their short stable id. The
 * store is authoritative on the daemon, so no schema ever accepts a filesystem
 * root: the caller can only name a todo and its fields, never where it lives.
 */

import type { JsonSchema } from '../jsonrpc.mts'

// Re-export the authoritative wire types so protocol consumers import them
// from the protocol module rather than reaching into the daemon service.
export type {
  Todo,
  TodoStatus,
  TodoCreateInput,
  TodoUpdateInput,
  TodoListParams,
  TodoListResult,
  TodoGetParams,
  TodoGetResult,
  TodoCreateParams,
  TodoCreateResult,
  TodoUpdateParams,
  TodoUpdateResult,
  TodoAddTagsInput,
  TodoRemoveTagInput,
  TodoAppendCommentInput,
  TodoDeleteCommentInput,
  TodoTagResult,
  TodoCommentResult,
} from '@wrenyard/protocol/workspace'

/** The complete, ordered set of valid todo statuses shared by every schema. */
const TODO_STATUS_VALUES = ['open', 'in_progress', 'done', 'cancelled'] as const

/** Status discriminator shared by every todo schema. */
const todoStatusProperty = {
  type: 'string',
  enum: TODO_STATUS_VALUES,
  description: "The todo status: 'open', 'in_progress', 'done' or 'cancelled'.",
} as const satisfies JsonSchema

/** The complete todo record returned by get/create/update and inside list. */
const todoSchema = {
  type: 'object',
  required: ['id', 'title', 'status', 'depends_on', 'created', 'updated', 'request', 'acceptance', 'attachments', 'tags', 'comments'],
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
    tags: { type: 'array', items: { type: 'string' } },
    comments: { type: 'array', items: { type: 'object', required: ['id', 'author', 'at', 'text'], properties: { id: { type: 'string' }, author: { type: 'string' }, at: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false } },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

/** Compact list row: metadata only; bodies come from todo.get. */
const todoCompactSchema = {
  type: 'object',
  required: ['id', 'title', 'status', 'depends_on', 'updated', 'tags'],
  properties: {
    id: { type: 'string', description: 'The short stable path-safe todo id.' },
    title: { type: 'string', description: 'The human-readable todo title.' },
    status: todoStatusProperty,
    project: { type: 'string', description: 'The optional project label the todo belongs to.' },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'Ids of todos this todo depends on.' },
    updated: { type: 'string', description: 'Last update time as an ISO 8601 timestamp.' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── todo.list ─────────────────────────────────────────────────────

export const todoListParamsSchema = {
  type: 'object',
  description: 'List workspace todos, ordered by id. Compact rows by default; use todo.get for full bodies.',
  properties: {
    status: todoStatusProperty,
    project: { type: 'string', minLength: 1, description: 'Filter to todos with this project label.' },
    tag: { type: 'string', minLength: 1, description: 'Exact tag filter.' },
    fields: {
      type: 'string',
      enum: ['compact', 'full'],
      description: "Row shape: 'compact' (default) or 'full' with request, acceptance and attachments.",
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const todoListResultSchema = {
  type: 'object',
  description: 'Matching workspace todos, ordered by id.',
  required: ['todos'],
  properties: {
    todos: {
      type: 'array',
      description: 'The matching todos (compact or full per params.fields).',
      items: { oneOf: [todoCompactSchema, todoSchema] },
    },
    skipped: {
      type: 'array',
      description: 'Todo files the last scan skipped because they could not be parsed.',
      items: {
        type: 'object',
        required: ['file', 'reason'],
        properties: { file: { type: 'string' }, reason: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── todo.get ──────────────────────────────────────────────────────

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

export const todoUpdateParamsSchema = {
  type: 'object',
  description:
    "Update one existing workspace todo by id. Absent fields are kept; id and created are immutable and updated is refreshed. Refuses with missing when no such todo exists and the same field validations as todo.create.",
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, description: 'The short stable id of the todo to update.' },
    title: { type: 'string', minLength: 1, description: 'The new todo title.' },
    old_title: { type: 'string', description: 'Exact current title required when changing title.' },
    status: todoStatusProperty,
    project: { type: 'string', minLength: 1, description: 'The new project label.' },
    depends_on: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'The new dependency ids; the combined graph must stay acyclic.',
    },
    request: { type: 'string', description: 'The new request section body.' },
    old_request: { type: 'string', description: 'Exact current request required when changing request.' },
    acceptance: { type: 'string', description: 'The new acceptance criteria section body.' },
    old_acceptance: { type: 'string', description: 'Exact current acceptance required when changing acceptance.' },
    attachments: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'The new relative-path attachments; absolute or upward-escaping paths are refused.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const todoTagParamsSchema = { type: 'object', required: ['id', 'tags'], properties: { id: { type: 'string', minLength: 1 }, tags: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } }, additionalProperties: false } as const satisfies JsonSchema
export const todoTagResultSchema = { type: 'object', required: ['tags', 'changed'], properties: { tags: { type: 'array', items: { type: 'string' } }, changed: { type: 'boolean' } }, additionalProperties: false } as const satisfies JsonSchema
export const todoUntagParamsSchema = { type: 'object', required: ['id', 'tag'], properties: { id: { type: 'string', minLength: 1 }, tag: { type: 'string', minLength: 1 } }, additionalProperties: false } as const satisfies JsonSchema
export const todoCommentParamsSchema = { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string', minLength: 1 }, text: { type: 'string' } }, additionalProperties: false } as const satisfies JsonSchema
export const todoCommentResultSchema = { type: 'object', required: ['comments', 'changed'], properties: { comments: { type: 'array', items: { type: 'object', required: ['id', 'author', 'at', 'text'], properties: { id: { type: 'string' }, author: { type: 'string' }, at: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false } }, changed: { type: 'boolean' } }, additionalProperties: false } as const satisfies JsonSchema
export const todoUncommentParamsSchema = { type: 'object', required: ['id', 'commentId'], properties: { id: { type: 'string', minLength: 1 }, commentId: { type: 'string', pattern: '^[0-9a-f]{6}$' } }, additionalProperties: false } as const satisfies JsonSchema

export const todoUpdateResultSchema = {
  type: 'object',
  description: 'The updated workspace todo.',
  required: ['todo'],
  properties: { todo: todoSchema },
  additionalProperties: false,
} as const satisfies JsonSchema
