/**
 * Typed JSON-RPC params/results for the workspace todo methods.
 *
 * Workspace todos are daemon-owned Markdown files under the configured
 * workspace root; every method addresses them by their short stable id. The
 * store is authoritative on the daemon, so no method ever accepts a filesystem
 * root: the caller can only name a todo and its fields, never where it lives.
 */

/** The valid todo statuses; a stored legacy `accepted` reads as `done`. */
export type TodoStatus = 'open' | 'in_progress' | 'done' | 'cancelled'

/** A workspace todo as stored in its Markdown file. */
export interface Todo {
  id: string
  title: string
  status: TodoStatus
  project?: string
  depends_on: string[]
  created: string
  updated: string
  request: string
  acceptance: string
  attachments: string[]
  tags: string[]
  comments: TodoComment[]
}

export interface TodoComment { id: string; author: string; at: string; text: string }

/** Input for todo.create. */
export interface TodoCreateInput {
  title: string
  status?: TodoStatus
  project?: string
  depends_on?: string[]
  request?: string
  acceptance?: string
  attachments?: string[]
}

/** Input for todo.update; absent fields are kept. */
export interface TodoUpdateInput {
  id: string
  title?: string
  status?: TodoStatus
  project?: string
  depends_on?: string[]
  request?: string
  acceptance?: string
  attachments?: string[]
  old_title?: string
  old_request?: string
  old_acceptance?: string
}

// ─── todo.list ─────────────────────────────────────────────────────

/** Row shape for `todo.list` when `fields` is `compact` (the default). */
export interface TodoCompact {
  id: string
  title: string
  status: TodoStatus
  project?: string
  depends_on: string[]
  updated: string
  tags: string[]
}

export type TodoListFields = 'compact' | 'full'

export interface TodoListParams {
  status?: TodoStatus
  project?: string
  tag?: string
  /** `compact` omits bodies; `full` returns complete todo records. */
  fields?: TodoListFields
}

export interface TodoListResult {
  todos: Todo[] | TodoCompact[]
  /** Files skipped by the last scan because they could not be parsed. */
  skipped?: { file: string; reason: string }[]
}

// ─── todo.get ──────────────────────────────────────────────────────

export interface TodoGetParams {
  id: string
}

export interface TodoGetResult {
  todo: Todo
}

// ─── todo.create ───────────────────────────────────────────────────

export type TodoCreateParams = TodoCreateInput

export interface TodoCreateResult {
  todo: Todo
}

// ─── todo.update ───────────────────────────────────────────────────

export type TodoUpdateParams = TodoUpdateInput

export interface TodoUpdateResult {
  todo: Todo
}

export interface TodoTagResult { tags: string[]; changed: boolean }
export interface TodoCommentResult { comments: TodoComment[]; changed: boolean }
export interface TodoAddTagsInput { id: string; tags: string[] }
export interface TodoRemoveTagInput { id: string; tag: string }
export interface TodoAppendCommentInput { id: string; text: string }
export interface TodoDeleteCommentInput { id: string; commentId: string }
