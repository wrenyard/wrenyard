/**
 * Workspace todo handler — server-side protocol adapter.
 *
 * Registers todo.list/get/create/update RPC handlers that delegate to an
 * injected workspace todo service (the daemon-owned WorkspaceTodoService). The
 * service provides the file authority and the workspace root is fixed at
 * construction, so no handler param ever selects a filesystem root. This module
 * has no node:fs/node:path imports.
 */

import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type {
  TodoListParams,
  TodoListResult,
  TodoGetParams, TodoGetResult,
  TodoCreateParams, TodoCreateResult,
  TodoUpdateParams, TodoUpdateResult,
} from '../../protocol/methods/workspace-todo.mts'
import type {
  TodoAddTagsInput,
  TodoRemoveTagInput,
  TodoAppendCommentInput,
  TodoDeleteCommentInput,
} from '../../protocol/methods/workspace-todo.mts'
import type {
  Todo,
  TodoCreateInput,
  TodoUpdateInput,
} from '../../daemon/services/workspace-todo-service.mts'
import type { TodoTagMutationResult, TodoCommentMutationResult } from '../../daemon/services/workspace-todo-service.mts'
import type { TodoTagResult, TodoCommentResult } from '../../protocol/methods/workspace-todo.mts'
import type { RpcRouter } from '../rpc-router.mts'
import { mapServiceError } from './project.mts'

export interface WorkspaceTodoHandlerService {
  listTodos(params?: TodoListParams): Promise<TodoListResult['todos']>
  getLastSkippedTodoFiles(): NonNullable<TodoListResult['skipped']>
  getTodo(id: string): Promise<Todo>
  createTodo(input: TodoCreateInput): Promise<Todo>
  updateTodo(input: TodoUpdateInput, author?: string): Promise<Todo>
  addTodoTags(id: string, tags: string[], author?: string): Promise<TodoTagMutationResult>
  removeTodoTag(id: string, tag: string, author?: string): Promise<TodoTagMutationResult>
  appendTodoComment(id: string, author: string, text: string): Promise<TodoCommentMutationResult>
  deleteTodoComment(id: string, commentId: string, author: string): Promise<TodoCommentMutationResult>
}

export function registerWorkspaceTodoHandlers(router: RpcRouter, service?: WorkspaceTodoHandlerService): void {
  if (!service) {
    const unavailable = () => {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'workspace todo service not available in this runtime' },
        { service: 'todo', code: 'workspace_todo_unavailable' },
      )
    }
    router.register('todo.list', unavailable)
    router.register('todo.get', unavailable)
    router.register('todo.create', unavailable)
    router.register('todo.update', unavailable)
    router.register('todo.tag', unavailable)
    router.register('todo.untag', unavailable)
    router.register('todo.comment', unavailable)
    router.register('todo.uncomment', unavailable)
    return
  }

  // Every method surfaces a WorkspaceTodoError.code through the shared
  // mapServiceError, so a rejection arrives as error data { service, code }
  // rather than an opaque INTERNAL_ERROR.
  router.register('todo.list', async (params: TodoListParams = {}) => {
    try {
      const todos = await service.listTodos(params)
      const skipped = service.getLastSkippedTodoFiles()
      const result: TodoListResult = { todos }
      if (skipped.length > 0) result.skipped = skipped
      return result
    } catch (error) {
      throw mapServiceError(error, 'workspace-todo', 'todo_error')
    }
  })
  router.register('todo.get', async (params: TodoGetParams) => {
    try {
      return { todo: await service.getTodo(params.id) } satisfies TodoGetResult
    } catch (error) {
      throw mapServiceError(error, 'workspace-todo', 'todo_error')
    }
  })
  router.register('todo.create', async (params: TodoCreateParams) => {
    try {
      return { todo: await service.createTodo(params) } satisfies TodoCreateResult
    } catch (error) {
      throw mapServiceError(error, 'workspace-todo', 'todo_error')
    }
  })
  router.register('todo.update', async (params: TodoUpdateParams) => {
    try {
      return { todo: await service.updateTodo(params, 'user') } satisfies TodoUpdateResult
    } catch (error) {
      throw mapServiceError(error, 'workspace-todo', 'todo_error')
    }
  })
  router.register('todo.tag', async (params: TodoAddTagsInput) => {
    try { return await service.addTodoTags(params.id, params.tags, 'user') satisfies TodoTagResult }
    catch (error) { throw mapServiceError(error, 'workspace-todo', 'todo_error') }
  })
  router.register('todo.untag', async (params: TodoRemoveTagInput) => {
    try { return await service.removeTodoTag(params.id, params.tag, 'user') satisfies TodoTagResult }
    catch (error) { throw mapServiceError(error, 'workspace-todo', 'todo_error') }
  })
  router.register('todo.comment', async (params: TodoAppendCommentInput) => {
    try { return await service.appendTodoComment(params.id, 'user', params.text) satisfies TodoCommentResult }
    catch (error) { throw mapServiceError(error, 'workspace-todo', 'todo_error') }
  })
  router.register('todo.uncomment', async (params: TodoDeleteCommentInput) => {
    try { return await service.deleteTodoComment(params.id, params.commentId, 'user') satisfies TodoCommentResult }
    catch (error) { throw mapServiceError(error, 'workspace-todo', 'todo_error') }
  })
}
