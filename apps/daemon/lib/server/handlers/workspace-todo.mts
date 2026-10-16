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
  TodoListResult,
  TodoGetParams, TodoGetResult,
  TodoCreateParams, TodoCreateResult,
  TodoUpdateParams, TodoUpdateResult,
} from '../../protocol/methods/workspace-todo.mts'
import type {
  Todo,
  TodoCreateInput,
  TodoUpdateInput,
} from '../../daemon/services/workspace-todo-service.mts'
import type { RpcRouter } from '../rpc-router.mts'
import { mapServiceError } from './project.mts'

export interface WorkspaceTodoHandlerService {
  listTodos(): Promise<Todo[]>
  getTodo(id: string): Promise<Todo>
  createTodo(input: TodoCreateInput): Promise<Todo>
  updateTodo(input: TodoUpdateInput): Promise<Todo>
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
    return
  }

  // Every method surfaces a WorkspaceTodoError.code through the shared
  // mapServiceError, so a rejection arrives as error data { service, code }
  // rather than an opaque INTERNAL_ERROR.
  router.register('todo.list', async () => {
    try {
      return { todos: await service.listTodos() } satisfies TodoListResult
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
      return { todo: await service.updateTodo(params) } satisfies TodoUpdateResult
    } catch (error) {
      throw mapServiceError(error, 'workspace-todo', 'todo_error')
    }
  })
}
