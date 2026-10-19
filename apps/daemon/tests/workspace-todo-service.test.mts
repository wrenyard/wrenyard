import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  WorkspaceTodoError,
  WorkspaceTodoService,
} from '../lib/daemon/services/workspace-todo-service.mts'

// File-authoritative workspace todo storage: the Markdown file under
// `<root>/todos/<id>.md` is the only source of truth, so every case below reads
// or writes that directory directly and re-instantiates the service rather than
// relying on any in-memory index. Malformed input must fail with a precise code.

/** A fresh scratch workspace root; each test owns its own directory. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wrenyard-todo-'))
}

/** Write one raw todo file, bypassing the service, to exercise the parser. */
function writeRawTodo(root: string, fileName: string, content: string): void {
  const dir = join(root, 'todos')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), content, 'utf-8')
}

/** Assert a rejection is a WorkspaceTodoError carrying exactly `code`. */
async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceTodoError, `expected a WorkspaceTodoError, received ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('create, list, get and update roundtrip including a dependent todo', async () => {
  const root = makeRoot()
  try {
    const service = new WorkspaceTodoService(root)

    // A finished todo first, so a later todo can depend on it.
    const first = await service.createTodo({
      title: 'First',
      request: 'Do the first thing',
      acceptance: 'The first thing is done',
      project: 'alpha',
    })
    assert.match(first.id, /^[a-z0-9][a-z0-9-]*$/u)
    assert.equal(first.status, 'open')
    assert.equal(first.project, 'alpha')
    assert.deepEqual(first.depends_on, [])
    await service.updateTodo({ id: first.id, status: 'done' })

    const dependent = await service.createTodo({
      title: 'Second',
      depends_on: [first.id],
      request: 'Do the second thing',
      acceptance: 'The second thing is done',
    })
    assert.deepEqual(dependent.depends_on, [first.id])
    assert.equal(dependent.status, 'open')

    const listed = await service.listTodos()
    assert.deepEqual(listed.map((todo) => todo.id).sort(), [first.id, dependent.id].sort())

    const loaded = await service.getTodo(dependent.id)
    assert.equal(loaded.title, 'Second')
    assert.equal(loaded.request, 'Do the second thing')
    assert.equal(loaded.acceptance, 'The second thing is done')

    const updated = await service.updateTodo({
      id: dependent.id,
      title: 'Second, revised',
      request: 'Do the revised second thing',
      status: 'in_progress',
    })
    assert.equal(updated.title, 'Second, revised')
    assert.equal(updated.request, 'Do the revised second thing')
    assert.equal(updated.acceptance, 'The second thing is done')
    assert.equal(updated.status, 'in_progress')
    // The immutable identity and creation time survive an update.
    assert.equal(updated.id, dependent.id)
    assert.equal(updated.created, dependent.created)

    const reread = await service.getTodo(dependent.id)
    assert.equal(reread.title, 'Second, revised')
    assert.equal(reread.status, 'in_progress')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('files are authoritative: a new service instance reads the same todos', async () => {
  const root = makeRoot()
  try {
    const first = new WorkspaceTodoService(root)
    const created = await first.createTodo({ title: 'Persisted', request: 'r', acceptance: 'a' })

    // No index exists; a second instance over the same root sees the file.
    const second = new WorkspaceTodoService(root)
    const reloaded = await second.getTodo(created.id)
    assert.equal(reloaded.title, 'Persisted')

    // An edit made on disk (not through the service) is what the next read
    // returns, proving the file, not a cache, is the authority.
    const filePath = join(root, 'todos', `${created.id}.md`)
    const onDisk = readFileSync(filePath, 'utf-8')
    assert.match(onDisk, /status: open/)
    writeFileSync(filePath, onDisk.replace('status: open', 'status: done'), 'utf-8')
    assert.equal((await second.getTodo(created.id)).status, 'done')

    const third = new WorkspaceTodoService(root)
    assert.equal((await third.getTodo(created.id)).status, 'done')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('done and accepted remain distinct stored statuses', async () => {
  const root = makeRoot()
  try {
    const service = new WorkspaceTodoService(root)
    const todo = await service.createTodo({ title: 'Distinct', request: 'r', acceptance: 'a' })

    const done = await service.updateTodo({ id: todo.id, status: 'done' })
    assert.equal(done.status, 'done')
    assert.equal((await service.getTodo(todo.id)).status, 'done')

    const accepted = await service.updateTodo({ id: todo.id, status: 'accepted' })
    assert.equal(accepted.status, 'accepted')
    assert.notEqual(done.status, accepted.status)
    assert.equal((await service.getTodo(todo.id)).status, 'accepted')

    // The status is written to the file, not held in memory.
    assert.match(readFileSync(join(root, 'todos', `${todo.id}.md`), 'utf-8'), /status: accepted/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('annotate adds a Result summary while preserving Request and Acceptance criteria', async () => {
  const root = makeRoot()
  try {
    const service = new WorkspaceTodoService(root)
    const todo = await service.createTodo({
      title: 'Annotated',
      request: 'Please do the work',
      acceptance: 'The work is verifiable',
    })

    const annotated = await service.annotateTodo(todo.id, 'Result: the work is complete.')
    assert.equal(annotated.resultSummary, 'Result: the work is complete.')
    // Everything that identifies or describes the request is untouched.
    assert.equal(annotated.id, todo.id)
    assert.equal(annotated.title, todo.title)
    assert.equal(annotated.created, todo.created)
    assert.equal(annotated.updated, todo.updated)
    assert.equal(annotated.request, 'Please do the work')
    assert.equal(annotated.acceptance, 'The work is verifiable')

    const reloaded = await service.getTodo(todo.id)
    assert.equal(reloaded.resultSummary, 'Result: the work is complete.')
    assert.equal(reloaded.request, 'Please do the work')
    assert.equal(reloaded.acceptance, 'The work is verifiable')

    const onDisk = readFileSync(join(root, 'todos', `${todo.id}.md`), 'utf-8')
    assert.match(onDisk, /## Result summary\n\nResult: the work is complete\./)
    assert.match(onDisk, /## Request\n\nPlease do the work/)
    assert.match(onDisk, /## Acceptance criteria\n\nThe work is verifiable/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── create/update validation, each with its own error code ──────────────────

test('create rejects absolute and path-escaping attachments with coded errors', async () => {
  const root = makeRoot()
  try {
    const service = new WorkspaceTodoService(root)
    await rejectsWithCode(
      service.createTodo({ title: 'Absolute', attachments: ['/etc/passwd'] }),
      'bad_attachment',
    )
    await rejectsWithCode(
      service.createTodo({ title: 'Escape', attachments: ['../outside.txt'] }),
      'bad_attachment',
    )

    // A safe relative attachment is accepted and roundtrips.
    const ok = await service.createTodo({ title: 'Safe', attachments: ['notes/detail.png'] })
    assert.deepEqual((await service.getTodo(ok.id)).attachments, ['notes/detail.png'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('create and update reject duplicate, self, unknown and cyclic dependencies', async () => {
  const root = makeRoot()
  try {
    const service = new WorkspaceTodoService(root)
    const todo = await service.createTodo({ title: 'Independent' })

    // Duplicate entries and unknown ids fail on write.
    await rejectsWithCode(
      service.createTodo({ title: 'Duplicate', depends_on: [todo.id, todo.id] }),
      'bad_dependency',
    )
    await rejectsWithCode(
      service.createTodo({ title: 'Unknown', depends_on: ['ghost'] }),
      'unknown_dependency',
    )

    // A todo may not depend on itself, and a two-node cycle is refused.
    await rejectsWithCode(
      service.updateTodo({ id: todo.id, depends_on: [todo.id] }),
      'dependency_self',
    )
    const dependent = await service.createTodo({ title: 'Depends', depends_on: [todo.id] })
    await rejectsWithCode(
      service.updateTodo({ id: todo.id, depends_on: [dependent.id] }),
      'dependency_cycle',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── parser validation of raw files ──────────────────────────────────────────

// ── disposable SQLite index ─────────────────────────────────────────────────

test('the disposable SQLite index rebuilds from the Markdown files alone', async () => {
  const root = makeRoot()
  // The index lives outside the workspace tree, so it gets its own scratch dir.
  const indexRoot = makeRoot()
  const indexDbPath = join(indexRoot, 'todo-index.db')
  try {
    const service = new WorkspaceTodoService(root, indexDbPath)
    const first = await service.createTodo({ title: 'Indexed first', request: 'r1', acceptance: 'a1' })
    const dependent = await service.createTodo({
      title: 'Indexed second',
      depends_on: [first.id],
      request: 'r2',
      acceptance: 'a2',
    })
    await service.updateTodo({ id: first.id, status: 'done', project: 'alpha' })
    assert.ok(existsSync(indexDbPath), 'the writes created the index file')

    // The snapshot is what the index holds after the writes, not a fresh read.
    const before = await service.readIndex()
    assert.deepEqual(before.map((record) => record.id), [first.id, dependent.id].sort())
    assert.equal(before.find((record) => record.id === first.id)?.status, 'done')
    assert.equal(before.find((record) => record.id === first.id)?.project, 'alpha')
    assert.deepEqual(before.find((record) => record.id === dependent.id)?.depends_on, [first.id])

    // Wipe ONLY the index file; the Markdown files are left untouched.
    rmSync(indexDbPath, { force: true })

    // A fresh service rebuilds an identical snapshot purely from the files.
    const rebuilt = new WorkspaceTodoService(root, indexDbPath)
    assert.deepEqual(await rebuilt.rebuildIndex(), before)

    // An external edit to one Markdown file is observed through a plain read,
    // and the refreshed index agrees with it.
    const dependentFile = join(root, 'todos', `${dependent.id}.md`)
    writeFileSync(
      dependentFile,
      readFileSync(dependentFile, 'utf-8').replace('status: open', 'status: in_progress'),
      'utf-8',
    )
    const listed = await rebuilt.listTodos()
    assert.equal(listed.find((todo) => todo.id === dependent.id)?.status, 'in_progress')
    assert.equal((await rebuilt.getTodo(dependent.id)).status, 'in_progress')
    assert.equal((await rebuilt.readIndex()).find((record) => record.id === dependent.id)?.status, 'in_progress')

    // A malformed file fails explicitly instead of leaving a valid index.
    writeRawTodo(root, 'broken.md', '# A heading without front matter\n')
    await rejectsWithCode(rebuilt.listTodos(), 'malformed')
    await rejectsWithCode(rebuilt.rebuildIndex(), 'malformed')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(indexRoot, { recursive: true, force: true })
  }
})
