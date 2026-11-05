import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkspaceTodoService } from '../lib/daemon/services/workspace-todo-service.mts'
import { parseMethodParams } from '../lib/protocol/validate.mts'
import { registerWorkspaceTodoHandlers } from '../lib/server/handlers/workspace-todo.mts'
import { RpcRouter } from '../lib/server/rpc-router.mts'

let root: string
let todos: WorkspaceTodoService
let router: RpcRouter

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wrenyard-todo-'))
  todos = new WorkspaceTodoService(root)
  router = new RpcRouter()
  registerWorkspaceTodoHandlers(router, todos)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const setStatus = async (id: string, status: string) =>
  router.invoke('todo.update', parseMethodParams('todo.update', { id, status }))

it.each(['open', 'in_progress', 'ready', 'blocked', 'done', 'cancelled'])(
  'keeps a todo %s through the protocol and the file', async status => {
    const todo = await todos.createTodo({ title: 'Fix login' })
    await setStatus(todo.id, status)
    expect(await new WorkspaceTodoService(root).getTodo(todo.id)).toMatchObject({ status })
  })

it('rejects a status it does not know', async () => {
  const todo = await todos.createTodo({ title: 'Fix login' })
  await expect(setStatus(todo.id, 'finished')).rejects.toThrow()
})

it('reads a todo a person edited by hand', async () => {
  const todo = await todos.createTodo({ title: 'Fix login' })
  const file = join(root, 'todos', `${todo.id}.md`)
  writeFileSync(file, readFileSync(file, 'utf-8').replace('status: open', 'status: ready'))
  expect(await todos.getTodo(todo.id)).toMatchObject({ status: 'ready' })
})
