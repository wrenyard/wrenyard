import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createInboxClient, itemFingerprint } from '../lib/daemon/services/bot/adapters.mts'
import { validateBotConfig } from '../lib/daemon/services/bot/config.mts'
import { WorkspaceTodoService } from '../lib/daemon/services/workspace-todo-service.mts'

// The built-in workspace inbox drives the real WorkspaceTodoService over a
// scratch todo directory; the bot config validator is exercised against
// workspace, command (Things) and invalid adapter shapes. No Git or
// multi-device behavior is covered here by design.

/** Build a service and its typed inbox client over one scratch root. */
function makeInbox(
  isDependencyCompleted?: (id: string) => boolean,
): { root: string; service: WorkspaceTodoService; inbox: ReturnType<typeof createInboxClient> } {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-inbox-'))
  const service = new WorkspaceTodoService(root)
  const inbox = createInboxClient(
    { kind: 'workspace' },
    {
      workspaceTodoService: service,
      ...(isDependencyCompleted === undefined ? {} : { isDependencyCompleted }),
    },
  )
  return { root, service, inbox }
}

/** Write one raw todo file to model an externally broken dependency. */
function writeRawTodo(root: string, id: string, dependsOn: string[]): void {
  const dir = join(root, 'todos')
  mkdirSync(dir, { recursive: true })
  const lines = [
    '---',
    `id: ${id}`,
    'title: Blocked raw todo',
    'status: open',
    'depends_on:',
    ...dependsOn.map((dependency) => `  - ${dependency}`),
    'created: 2026-10-16T00:00:00.000Z',
    'updated: 2026-10-16T00:00:00.000Z',
    '---',
    '',
    '## Request',
    '',
    'raw',
    '',
    '## Acceptance criteria',
    '',
    'raw',
  ]
  writeFileSync(join(dir, `${id}.md`), `${lines.join('\n')}\n`, 'utf-8')
}

// ── inbox list/get gating ───────────────────────────────────────────────────

test('list and get expose only open/in_progress todos whose dependencies are finished', async () => {
  const { root, service, inbox } = makeInbox()
  try {
    // A dependency that is still open blocks its dependent.
    const alpha = await service.createTodo({ title: 'Alpha', request: 'r', acceptance: 'a' })
    const beta = await service.createTodo({ title: 'Beta', depends_on: [alpha.id], request: 'r', acceptance: 'a' })
    // A cancelled dependency also blocks.
    const delta = await service.createTodo({ title: 'Delta', request: 'r', acceptance: 'a' })
    const gamma = await service.createTodo({ title: 'Gamma', depends_on: [delta.id], request: 'r', acceptance: 'a' })
    await service.updateTodo({ id: delta.id, status: 'cancelled' })
    // An in_progress todo with no dependencies is dispatchable.
    const epsilon = await service.createTodo({ title: 'Epsilon', request: 'r', acceptance: 'a', status: 'in_progress' })
    // A raw file with an unknown dependency is blocked, not an error.
    writeRawTodo(root, 'zeta', ['ghost'])

    const initial = await inbox.list()
    assert.deepEqual(initial.items.map((item) => item.id).sort(), [alpha.id, epsilon.id].sort())
    // The body carries the request and acceptance for intake.
    const alphaItem = initial.items.find((item) => item.id === alpha.id)
    assert.match(alphaItem?.body ?? '', /Request:\nr/)
    assert.match(alphaItem?.body ?? '', /Acceptance criteria:\na/)

    // Unfinished, cancelled and missing dependencies are all reported non-open.
    assert.equal((await inbox.get(beta.id)).item?.open, false)
    assert.equal((await inbox.get(gamma.id)).item?.open, false)
    assert.equal((await inbox.get('zeta')).item?.open, false)
    assert.equal((await inbox.get(alpha.id)).item?.open, true)

    // Once the dependency finishes, its dependent becomes dispatchable.
    await service.updateTodo({ id: alpha.id, status: 'done' })
    const afterDone = await inbox.list()
    assert.deepEqual(afterDone.items.map((item) => item.id).sort(), [beta.id, epsilon.id].sort())
    assert.equal((await inbox.get(beta.id)).item?.open, true)

    // An accepted dependency is equally satisfying, and a done or cancelled
    // todo is never itself listed as open work.
    await service.updateTodo({ id: epsilon.id, status: 'accepted' })
    const finalIds = (await inbox.list()).items.map((item) => item.id)
    assert.equal(finalIds.includes(alpha.id), false)
    assert.equal(finalIds.includes(delta.id), false)
    assert.equal(finalIds.includes(gamma.id), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── dependency projection (isDependencyCompleted) ───────────────────────────

test('an injected callback makes a blocked todo eligible while both files stay open', async () => {
  const completed = new Set<string>()
  const { root, service, inbox } = makeInbox((id) => completed.has(id))
  try {
    const dependency = await service.createTodo({ title: 'Dependency', request: 'r', acceptance: 'a' })
    const dependent = await service.createTodo({
      title: 'Dependent',
      depends_on: [dependency.id],
      request: 'r',
      acceptance: 'a',
    })

    // While the callback reports nothing, the dependent stays blocked.
    assert.equal((await inbox.get(dependent.id)).item?.open, false)
    assert.deepEqual((await inbox.list()).items.map((item) => item.id), [dependency.id])

    const dependencyFile = readFileSync(join(root, 'todos', `${dependency.id}.md`), 'utf-8')
    const dependentFile = readFileSync(join(root, 'todos', `${dependent.id}.md`), 'utf-8')

    // The callback now reports the unfinished dependency as completed.
    completed.add(dependency.id)
    assert.deepEqual(
      (await inbox.list()).items.map((item) => item.id).sort(),
      [dependency.id, dependent.id].sort(),
    )
    assert.equal((await inbox.get(dependent.id)).item?.open, true)

    // The projection is read-only: neither file's status changed on disk.
    assert.equal((await service.getTodo(dependency.id)).status, 'open')
    assert.equal((await service.getTodo(dependent.id)).status, 'open')
    assert.equal(readFileSync(join(root, 'todos', `${dependency.id}.md`), 'utf-8'), dependencyFile)
    assert.equal(readFileSync(join(root, 'todos', `${dependent.id}.md`), 'utf-8'), dependentFile)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('without the callback an unfinished dependency still blocks its dependent', async () => {
  const { root, service, inbox } = makeInbox()
  try {
    const dependency = await service.createTodo({ title: 'Dependency', request: 'r', acceptance: 'a' })
    const dependent = await service.createTodo({
      title: 'Dependent',
      depends_on: [dependency.id],
      request: 'r',
      acceptance: 'a',
    })

    assert.deepEqual((await inbox.list()).items.map((item) => item.id), [dependency.id])
    assert.equal((await inbox.get(dependent.id)).item?.open, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cancelled or missing dependency stays blocked even when the callback reports it completed', async () => {
  const completed = new Set<string>(['ghost'])
  const { root, service, inbox } = makeInbox((id) => completed.has(id))
  try {
    const cancelled = await service.createTodo({ title: 'Cancelled', request: 'r', acceptance: 'a' })
    await service.updateTodo({ id: cancelled.id, status: 'cancelled' })
    completed.add(cancelled.id)
    const blockedByCancelled = await service.createTodo({
      title: 'Blocked by cancelled',
      depends_on: [cancelled.id],
      request: 'r',
      acceptance: 'a',
    })
    // A dependency file that does not exist is never rescued by the callback.
    writeRawTodo(root, 'missing-dep', ['ghost'])

    assert.equal((await inbox.get(blockedByCancelled.id)).item?.open, false)
    assert.equal((await inbox.get('missing-dep')).item?.open, false)
    const ids = (await inbox.list()).items.map((item) => item.id)
    assert.equal(ids.includes(blockedByCancelled.id), false)
    assert.equal(ids.includes('missing-dep'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a done or accepted dependency satisfies gating without any callback', async () => {
  const { root, service, inbox } = makeInbox()
  try {
    const done = await service.createTodo({ title: 'Done dependency', request: 'r', acceptance: 'a' })
    await service.updateTodo({ id: done.id, status: 'done' })
    const accepted = await service.createTodo({ title: 'Accepted dependency', request: 'r', acceptance: 'a' })
    await service.updateTodo({ id: accepted.id, status: 'accepted' })
    const afterDone = await service.createTodo({
      title: 'After done',
      depends_on: [done.id],
      request: 'r',
      acceptance: 'a',
    })
    const afterAccepted = await service.createTodo({
      title: 'After accepted',
      depends_on: [accepted.id],
      request: 'r',
      acceptance: 'a',
    })

    assert.equal((await inbox.get(afterDone.id)).item?.open, true)
    assert.equal((await inbox.get(afterAccepted.id)).item?.open, true)
    const ids = (await inbox.list()).items.map((item) => item.id)
    assert.equal(ids.includes(afterDone.id), true)
    assert.equal(ids.includes(afterAccepted.id), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── complete / release / annotate ───────────────────────────────────────────

test('complete writes done and never downgrades an already accepted todo', async () => {
  const { root, service, inbox } = makeInbox()
  try {
    const todo = await service.createTodo({ title: 'To finish', request: 'r', acceptance: 'a' })
    assert.deepEqual(await inbox.complete(todo.id), { ok: true })
    assert.equal((await service.getTodo(todo.id)).status, 'done')

    const accepted = await service.createTodo({ title: 'Accepted', request: 'r', acceptance: 'a' })
    await service.updateTodo({ id: accepted.id, status: 'accepted' })
    assert.deepEqual(await inbox.complete(accepted.id), { ok: true })
    // Acceptance is a distinct stored state and is preserved.
    assert.equal((await service.getTodo(accepted.id)).status, 'accepted')

    assert.deepEqual(await inbox.complete('nope'), { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release returns in_progress to open and leaves other statuses alone', async () => {
  const { root, service, inbox } = makeInbox()
  try {
    const todo = await service.createTodo({ title: 'Claimed', request: 'r', acceptance: 'a', status: 'in_progress' })
    assert.deepEqual(await inbox.release(todo.id), { ok: true })
    assert.equal((await service.getTodo(todo.id)).status, 'open')

    // Release only affects in_progress work.
    const done = await service.createTodo({ title: 'Done', request: 'r', acceptance: 'a' })
    await service.updateTodo({ id: done.id, status: 'done' })
    assert.deepEqual(await inbox.release(done.id), { ok: true })
    assert.equal((await service.getTodo(done.id)).status, 'done')

    assert.deepEqual(await inbox.release('nope'), { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('annotate persists the result summary without corrupting request or fingerprint', async () => {
  const { root, service, inbox } = makeInbox()
  try {
    const todo = await service.createTodo({
      title: 'Annotated',
      request: 'the original request',
      acceptance: 'the original acceptance',
    })
    const before = (await inbox.get(todo.id)).item
    assert.ok(before !== null)
    const fingerprintBefore = itemFingerprint({ title: before.title, body: before.body })

    assert.deepEqual(await inbox.annotate(todo.id, 'Result: finished cleanly.'), { ok: true })

    const stored = await service.getTodo(todo.id)
    assert.equal(stored.resultSummary, 'Result: finished cleanly.')
    assert.equal(stored.request, 'the original request')
    assert.equal(stored.acceptance, 'the original acceptance')

    // The intake view is byte-for-byte the same, so the dispatch fingerprint
    // does not change when a summary is recorded.
    const after = (await inbox.get(todo.id)).item
    assert.ok(after !== null)
    assert.equal(itemFingerprint({ title: after.title, body: after.body }), fingerprintBefore)

    assert.deepEqual(await inbox.annotate('nope', 'x'), { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── config validation ───────────────────────────────────────────────────────

/** A minimal valid config, with the inbox supplied per case. */
function botConfig(inbox?: unknown): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: 'bot-test',
    mode: 'dryRun',
    notifier: { kind: 'command', argv: ['/bin/echo'] },
    projects: [{ id: 'alpha', match: ['alpha'] }],
    routing: {
      default: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
      acceptance: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
      judgment: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
    },
  }
  if (inbox !== undefined) config.inbox = inbox
  return config
}

test('the config accepts a workspace inbox', () => {
  const result = validateBotConfig(botConfig({ kind: 'workspace' }))
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.config.inbox, { kind: 'workspace' })
})

test('the config still accepts an existing command-kind (Things) inbox unchanged', () => {
  const inbox = { kind: 'command', argv: ['node', 'inbox-adapter.mjs'], timeoutMs: 15_000 }
  const result = validateBotConfig(botConfig(inbox))
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.config.inbox, {
      kind: 'command',
      argv: ['node', 'inbox-adapter.mjs'],
      timeoutMs: 15_000,
    })
  }
})

test('an omitted inbox defaults to workspace for new configs without rewriting input', () => {
  const parsed = botConfig()
  const before = JSON.stringify(parsed)
  const result = validateBotConfig(parsed)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.config.inbox, { kind: 'workspace' })
  // The default is applied to the returned config only; the caller's object and
  // any file it came from are left exactly as they were.
  assert.equal(JSON.stringify(parsed), before)
  assert.equal('inbox' in parsed, false)
})

test('the config rejects unknown inbox keys', () => {
  const result = validateBotConfig(botConfig({ kind: 'workspace', argv: ['nope'] }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue === 'inbox.argv is not a supported key'))
})

test('the config rejects workspace as a notifier', () => {
  const config = botConfig({ kind: 'workspace' })
  config.notifier = { kind: 'workspace' }
  const result = validateBotConfig(config)
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue === "notifier.kind must be 'command' or 'mcp'"))
})

test('a config file with an omitted inbox is validated without being rewritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-bot-config-'))
  try {
    const filePath = join(dir, 'bot.json')
    writeFileSync(filePath, JSON.stringify(botConfig(), null, 2), 'utf-8')
    const before = readFileSync(filePath, 'utf-8')
    const result = validateBotConfig(JSON.parse(before) as unknown)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.config.inbox, { kind: 'workspace' })
    assert.equal(readFileSync(filePath, 'utf-8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
