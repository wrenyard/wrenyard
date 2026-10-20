import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Session } from '@wrenyard/session'
import { initDb } from '../lib/db/connection.mts'
import { createBotStore } from '../lib/daemon/services/bot/store.mts'
import { createBotHost } from '../lib/daemon/services/bot/host.mts'
import { createInboxClient, itemFingerprint } from '../lib/daemon/services/bot/adapters.mts'
import { WorkspaceTodoService } from '../lib/daemon/services/workspace-todo-service.mts'
import type { ProjectManager } from '../lib/core/project/manager.mts'

// Host-level regression coverage for the repaired workspace-inbox lifecycle.
// Every case builds a real Bot host over a scratch workspace root, stubs each
// boundary runner (the command notifier, the judgment/acceptance task runs and
// the project-git manager) so no merge, push, notification or model call ever
// happens, and drives the host's own tick and step handlers. Fixture values are
// synthetic; nothing here names a real worktree, bot, todo or user.

/** The session surface a bot host needs; per-test send/readLedger hooks. */
type BotTestSession = Pick<Session, 'createSession' | 'listSessions' | 'send' | 'readLedger'>

function botSession(
  send: BotTestSession['send'] = async () => ({ turn: 1 }),
  readLedger: BotTestSession['readLedger'] = () => [],
): BotTestSession {
  return { createSession: async () => ({ sessionId: 'session-1' }), listSessions: () => [], send, readLedger }
}

/** Every routing entry the config loader requires; the stubs never model-call. */
const ROUTING = {
  default: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
  acceptance: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
  judgment: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
} as const

/** A stub notifier command: one JSON request in, `{ ok: true }` out. */
const NOTIFIER_SCRIPT = [
  "let raw = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { raw += chunk });",
  "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ ok: true })) });",
].join('\n')

interface Fixture {
  home: string
  dir: string
  root: string
  configPath: string
}

/**
 * A workspace-inbox bot config under a scratch config home, plus a scratch
 * workspace root that hosts the todo files. The notifier is a stub command so a
 * notification never leaves the test.
 */
function makeFixture(name: string, mode: 'live' | 'dryRun'): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'wrenyard-host-home-'))
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-host-adapters-'))
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-host-ws-'))
  const botsDir = join(home, 'bots')
  mkdirSync(botsDir, { recursive: true })
  const notifierPath = join(dir, 'notifier.mjs')
  writeFileSync(notifierPath, NOTIFIER_SCRIPT, 'utf-8')
  const config = {
    name,
    mode,
    inbox: { kind: 'workspace' },
    notifier: { kind: 'command', argv: [process.execPath, notifierPath], timeoutMs: 10_000 },
    projects: [{ id: 'alpha', match: ['alpha'], merge: true, push: true }],
    routing: ROUTING,
  }
  const configPath = join(botsDir, `${name}.json`)
  writeFileSync(configPath, JSON.stringify(config), 'utf-8')
  return { home, dir, root, configPath }
}

/**
 * Run a body with the config home pointed at one fixture, then restore it. The
 * daemon state home is redirected into the same fixture too, so the host's
 * disposable todo index lands in scratch rather than the real user state.
 */
async function withConfigHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const previousConfig = process.env.WRENYARD_CONFIG_HOME
  const previousState = process.env.WRENYARD_STATE_HOME
  process.env.WRENYARD_CONFIG_HOME = home
  process.env.WRENYARD_STATE_HOME = join(home, 'state')
  try {
    return await body()
  } finally {
    if (previousConfig === undefined) delete process.env.WRENYARD_CONFIG_HOME
    else process.env.WRENYARD_CONFIG_HOME = previousConfig
    if (previousState === undefined) delete process.env.WRENYARD_STATE_HOME
    else process.env.WRENYARD_STATE_HOME = previousState
  }
}

function removeFixture(fixture: Fixture): void {
  rmSync(fixture.home, { recursive: true, force: true })
  rmSync(fixture.dir, { recursive: true, force: true })
  rmSync(fixture.root, { recursive: true, force: true })
}

/** The status field of a todo file, read verbatim from its front matter. */
function todoStatus(root: string, id: string): string {
  const text = readFileSync(join(root, 'todos', `${id}.md`), 'utf-8')
  const match = /^status:\s*(\S+)\s*$/mu.exec(text)
  assert.ok(match !== null, `todo ${id} must carry a status field`)
  return match[1] ?? ''
}

/**
 * The dispatch fingerprint of one source, read through a callback-free
 * workspace inbox so it equals what an unprojected poll records.
 */
async function sourceFingerprint(service: WorkspaceTodoService, id: string): Promise<string> {
  const inbox = createInboxClient({ kind: 'workspace' }, { workspaceTodoService: service })
  const item = (await inbox.get(id)).item
  assert.ok(item !== null, `todo ${id} must be readable`)
  return itemFingerprint(item)
}

/** Write one raw open todo file directly, to model an externally broken graph. */
function writeRawTodo(root: string, id: string, dependsOn: string[]): void {
  const dir = join(root, 'todos')
  mkdirSync(dir, { recursive: true })
  const lines = [
    '---',
    `id: ${id}`,
    'title: Raw todo',
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

/** One deterministic git command in a scratch repository, with a stub identity. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'bot',
      GIT_AUTHOR_EMAIL: 'bot@example.invalid',
      GIT_COMMITTER_NAME: 'bot',
      GIT_COMMITTER_EMAIL: 'bot@example.invalid',
    },
  })
}

/**
 * A scratch project checkout plus a linked worktree one commit ahead of `main`,
 * so the host's ready gate can compare a real worktree head with the target.
 */
function makeWorktreeAheadOfMain(dir: string): { repo: string; worktree: string } {
  const repo = join(dir, 'project')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'file.txt'), 'base\n', 'utf-8')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'base'])
  const worktree = join(dir, 'worktree')
  git(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree])
  writeFileSync(join(worktree, 'change.txt'), 'change\n', 'utf-8')
  git(worktree, ['add', '.'])
  git(worktree, ['commit', '-q', '-m', 'change'])
  return { repo, worktree }
}

// ── 1. a source read error does not dispatch ────────────────────────────────

test('a workspace source read error leaves the item verified and enqueues no dispatch step', async () => {
  const fixture = makeFixture('readerror', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'readerror', state: 'running', mode: 'live', configPath: fixture.configPath })
      // A directory where a todo file should be: `list` skips it and `get`
      // fails, so the host sees a source read error rather than a withdrawal.
      const sourceId = 'unreadable-source'
      mkdirSync(join(fixture.root, 'todos', `${sourceId}.md`), { recursive: true })
      const item = store.createItem({ botId: bot.id, sourceId, state: 'verified', project: 'alpha' })

      const host = createBotHost({ db, workspaceRoot: fixture.root, session: botSession(), log: () => {} })
      await host.tick(bot.id)

      // The failed re-read neither parks the item nor lets dispatch proceed:
      // it stays verified and no dispatch step was enqueued.
      assert.equal(store.getItem(bot.id, item.id).state, 'verified')
      assert.equal(store.findStepByIdemKey(`${item.id}:1:worktree.create:1`), undefined)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:session.create:1`), undefined)
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'dispatch.source_retry'), true)
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 2. a cancelled source is not resurrected ────────────────────────────────

test('a cancelled workspace source is not resurrected by a dispatch status write', async () => {
  const fixture = makeFixture('cancelled', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'cancelled', state: 'running', mode: 'live', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
      })
      // A warm-up pass consumes the forced-poll allowance, so the next pass
      // drives the step without a poll withdrawing the in-flight item first.
      await host.tick(bot.id)

      const todo = await service.createTodo({ title: 'Cancelled work', request: 'r', acceptance: 'a' })
      await service.updateTodo({ id: todo.id, status: 'cancelled' })
      const item = store.createItem({ botId: bot.id, sourceId: todo.id, state: 'dispatched', project: 'alpha' })
      store.patchItem(item.id, { sessionId: 'session-1' })

      await host.tick(bot.id)

      // The dispatch's `in_progress` write is refused, so the cancelled todo is
      // never resurrected; the step fails instead of silently advancing.
      assert.equal(todoStatus(fixture.root, todo.id), 'cancelled')
      assert.equal(store.findStepByIdemKey(`${item.id}:1:session.send:1`)?.status, 'failed')
      const log = store.listLog(bot.id, 0)
      assert.equal(log.some(entry => entry.code === 'todo.status'), false)
      assert.equal(log.some(entry => entry.code === 'todo.status_failed'), true)
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 3. done is persisted before acceptance ──────────────────────────────────

test('the review-ready gate persists done before the item is accepted', async () => {
  const fixture = makeFixture('lifecycle', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'lifecycle', state: 'running', mode: 'live', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const { repo, worktree } = makeWorktreeAheadOfMain(fixture.dir)
      // The only project-git surface the lifecycle needs, stubbed so nothing
      // real is rebased or merged.
      const projectManager = {
        diff: async () => '',
        listWorktrees: () => [{ id: 'wt-1', clean: true }],
        getProject: () => ({ path: repo, defaultBranch: 'main' }),
        resolveWorktreePath: () => worktree,
        worktreeContainsTarget: () => true,
        rebaseWorktree: () => ({ rebased: true, head_sha: 'head-sha' }),
      } as unknown as ProjectManager

      // A finished turn whose last reply carries the closing marker the ready
      // gate requires.
      const at = new Date().toISOString()
      const ledger: ReturnType<BotTestSession['readLedger']> = [
        {
          seq: 1,
          at,
          type: 'turn.started',
          turn: 1,
          id: 't1',
          text: 'the dispatch brief',
          model: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
        },
        {
          seq: 2,
          at,
          type: 'reply.sent',
          turn: 1,
          text: 'Committed. BOT-READY 0123456789abcdef0123456789abcdef01234567',
        },
        { seq: 3, at, type: 'turn.finished', turn: 1, id: 't1', status: 'completed' },
      ]

      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 }), () => ledger),
        projectManager,
        log: () => {},
        taskRunner: {
          async startTask({ task }) { return { runId: `run:${task}` } },
          async getTask(runId) {
            if (runId === 'run:bot-review') {
              return { status: 'done' as const, output: { verdict: 'ready', reason: 'the change is complete' } }
            }
            return { status: 'done' as const, output: { assessments: [{ criterion_id: 'c1', status: 'passed' }] } }
          },
        },
      })
      // Warm-up pass: the lifecycle ticks that follow do not poll.
      await host.tick(bot.id)

      const todo = await service.createTodo({ title: 'Lifecycle work', request: 'r', acceptance: 'a' })
      const item = store.createItem({
        botId: bot.id,
        sourceId: todo.id,
        state: 'in_progress',
        project: 'alpha',
        title: 'Lifecycle work',
      })
      store.patchItem(item.id, { sessionId: 'session-1', worktreeId: 'wt-1' })
      const verify = store.beginStep({ itemId: item.id, kind: 'verify', idemKey: `${item.id}:1:verify:1` })
      store.finishStep(verify.step.id, {
        status: 'done',
        output: {
          decision: 'real',
          reason: 'reproduced on main',
          project: 'alpha',
          class: 'default',
          acceptance: {
            checks: [
              { id: 'c1', claim: 'the daemon reports the new state', surface: 'daemon', recipe: 'run the daemon check' },
            ],
          },
        },
      })

      // Review: the first tick starts the detached run, the second applies the
      // ready verdict, which writes `done` before the item enters acceptance.
      await host.tick(bot.id)
      assert.equal(todoStatus(fixture.root, todo.id), 'open')
      await host.tick(bot.id)
      assert.equal(store.getItem(bot.id, item.id).state, 'ready')
      assert.equal(todoStatus(fixture.root, todo.id), 'done')

      // Acceptance: lane, rebase, then the passing run; the todo stays `done`.
      await host.tick(bot.id)
      await host.tick(bot.id)
      await host.tick(bot.id)
      await host.tick(bot.id)
      assert.equal(store.getItem(bot.id, item.id).state, 'accepted')
      assert.equal(todoStatus(fixture.root, todo.id), 'done')

      // The ready gate already persisted `done`; acceptance writes no status.
      const writes = store.listLog(bot.id, 0)
        .filter(entry => entry.code === 'todo.status')
        .map(entry => entry.message)
      assert.equal(writes.length, 1)
      assert.match(writes[0] ?? '', /set to done/)
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 4. a done todo passes the pre-completion gate ───────────────────────────

test('a done todo passes the pre-completion source gate and is never downgraded', async () => {
  const fixture = makeFixture('completing', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'completing', state: 'running', mode: 'live', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const host = createBotHost({ db, workspaceRoot: fixture.root, session: botSession(), log: () => {} })
      // Warm-up pass so the completion tick does not poll first.
      await host.tick(bot.id)

      const todo = await service.createTodo({ title: 'Done work', request: 'r', acceptance: 'a' })
      await service.updateTodo({ id: todo.id, status: 'done' })
      const item = store.createItem({ botId: bot.id, sourceId: todo.id, state: 'completing', project: 'alpha' })
      assert.equal(store.acquireLane({ project: 'alpha', botId: bot.id, itemId: item.id }), true)
      store.beginStep({ itemId: item.id, kind: 'inbox.complete', idemKey: `${item.id}:1:inbox.complete:1` })

      await host.tick(bot.id)

      // The source gate admitted the done todo and the completion write left
      // it done: no downgrade to in_progress, no status write at all.
      assert.equal(store.findStepByIdemKey(`${item.id}:1:inbox.complete:1`)?.status, 'done')
      assert.equal(todoStatus(fixture.root, todo.id), 'done')
      assert.equal(store.getItem(bot.id, item.id).state, 'completing')
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'todo.status'), false)
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 5. dryRun records would-be statuses without writing ─────────────────────

test('dryRun records the would-be status without writing any todo file', async () => {
  const fixture = makeFixture('dryrun', 'dryRun')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'dryrun', state: 'running', mode: 'dryRun', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const todo = await service.createTodo({ title: 'Dry work', request: 'r', acceptance: 'a' })
      const todoPath = join(fixture.root, 'todos', `${todo.id}.md`)
      const before = readFileSync(todoPath, 'utf-8')
      const item = store.createItem({ botId: bot.id, sourceId: todo.id, state: 'dispatched', project: 'alpha' })
      store.patchItem(item.id, { sessionId: 'session-1' })

      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
      })
      await host.tick(bot.id)

      // Dispatch still runs, but the `in_progress` status is only recorded: the
      // file is untouched and no real status write happened.
      const log = store.listLog(bot.id, 0)
      assert.equal(log.some(entry => entry.code === 'todo.status_dry_run'), true)
      assert.equal(log.some(entry => entry.code === 'todo.status'), false)
      assert.equal(readFileSync(todoPath, 'utf-8'), before)
      assert.equal(store.getItem(bot.id, item.id).state, 'in_progress')
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 6. dry-run dependency projection ────────────────────────────────────────
//
// In dry-run mode the bot never writes a todo file, so a finished predecessor
// stays `open` on disk and the dependent would wait forever. The host projects
// a dependency as finished only from a completed same-bot dry run whose
// recorded fingerprint still matches the file, and only for a dry-run bot.

test('a completed dry-run predecessor with a matching fingerprint admits its dependent without writing either file', async () => {
  const fixture = makeFixture('dryrunsuccess', 'dryRun')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'dryrunsuccess', state: 'running', mode: 'dryRun', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const predecessor = await service.createTodo({ title: 'Predecessor', request: 'r', acceptance: 'a' })
      const dependent = await service.createTodo({
        title: 'Dependent',
        depends_on: [predecessor.id],
        request: 'r',
        acceptance: 'a',
      })

      // The predecessor finished a same-bot dry run: its item is completed with
      // the dryRun flag and the fingerprint of the unchanged file.
      store.createItem({
        botId: bot.id,
        sourceId: predecessor.id,
        state: 'completed',
        dryRun: true,
        fingerprint: await sourceFingerprint(service, predecessor.id),
        title: 'Predecessor',
      })

      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
      })
      await host.tick(bot.id)

      // The projection made the dependent eligible for intake even though its
      // predecessor's file is still `open`, and neither file was written.
      assert.ok(store.findItemBySource(bot.id, dependent.id) !== undefined)
      assert.equal(
        store.listLog(bot.id, 0).some(entry => entry.code === 'poll.discovered' && entry.message.includes(dependent.id)),
        true,
      )
      assert.equal(todoStatus(fixture.root, predecessor.id), 'open')
      assert.equal(todoStatus(fixture.root, dependent.id), 'open')
    })
  } finally {
    removeFixture(fixture)
  }
})

test('a predecessor whose fingerprint no longer matches its completed dry run leaves the dependent blocked', async () => {
  const fixture = makeFixture('dryrunmismatch', 'dryRun')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'dryrunmismatch', state: 'running', mode: 'dryRun', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const predecessor = await service.createTodo({ title: 'Predecessor', request: 'r', acceptance: 'a' })
      const dependent = await service.createTodo({
        title: 'Dependent',
        depends_on: [predecessor.id],
        request: 'r',
        acceptance: 'a',
      })

      // The run completed but its recorded fingerprint is stale: the file
      // changed after the dry run, so the dependency is not finished.
      store.createItem({
        botId: bot.id,
        sourceId: predecessor.id,
        state: 'completed',
        dryRun: true,
        fingerprint: 'stale-fingerprint',
        title: 'Predecessor',
      })

      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
      })
      await host.tick(bot.id)

      assert.equal(store.findItemBySource(bot.id, dependent.id), undefined)
      assert.equal(todoStatus(fixture.root, predecessor.id), 'open')
      assert.equal(todoStatus(fixture.root, dependent.id), 'open')
    })
  } finally {
    removeFixture(fixture)
  }
})

test('a cancelled or missing dependency stays blocked even after a completed dry run', async () => {
  const fixture = makeFixture('dryrunblocked', 'dryRun')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'dryrunblocked', state: 'running', mode: 'dryRun', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      // A cancelled dependency: its intake fingerprint is unchanged by the
      // status write, so the run matches, yet a cancelled source never counts.
      const cancelled = await service.createTodo({ title: 'Cancelled', request: 'r', acceptance: 'a' })
      const afterCancelled = await service.createTodo({
        title: 'After cancelled',
        depends_on: [cancelled.id],
        request: 'r',
        acceptance: 'a',
      })
      const cancelledFingerprint = await sourceFingerprint(service, cancelled.id)
      await service.updateTodo({ id: cancelled.id, status: 'cancelled' })
      store.createItem({
        botId: bot.id,
        sourceId: cancelled.id,
        state: 'completed',
        dryRun: true,
        fingerprint: cancelledFingerprint,
        title: 'Cancelled',
      })
      // A dependency whose file is gone entirely, with a completed run too.
      writeRawTodo(fixture.root, 'rawblocked', ['ghostdep'])
      store.createItem({
        botId: bot.id,
        sourceId: 'ghostdep',
        state: 'completed',
        dryRun: true,
        fingerprint: 'ghost-fingerprint',
        title: 'Ghost',
      })

      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
      })
      await host.tick(bot.id)

      assert.equal(store.findItemBySource(bot.id, afterCancelled.id), undefined)
      assert.equal(store.findItemBySource(bot.id, 'rawblocked'), undefined)
      assert.equal(todoStatus(fixture.root, cancelled.id), 'cancelled')
      assert.equal(todoStatus(fixture.root, afterCancelled.id), 'open')
    })
  } finally {
    removeFixture(fixture)
  }
})

test('a live bot never receives the dry-run dependency projection', async () => {
  const fixture = makeFixture('liveprojection', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'liveprojection', state: 'running', mode: 'live', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const predecessor = await service.createTodo({ title: 'Predecessor', request: 'r', acceptance: 'a' })
      const dependent = await service.createTodo({
        title: 'Dependent',
        depends_on: [predecessor.id],
        request: 'r',
        acceptance: 'a',
      })

      // A completed same-bot item with a matching fingerprint is still not a
      // projection for a live bot: only the on-disk status counts.
      store.createItem({
        botId: bot.id,
        sourceId: predecessor.id,
        state: 'completed',
        dryRun: false,
        fingerprint: await sourceFingerprint(service, predecessor.id),
        title: 'Predecessor',
      })

      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
      })
      await host.tick(bot.id)

      assert.equal(store.findItemBySource(bot.id, dependent.id), undefined)
      assert.equal(todoStatus(fixture.root, predecessor.id), 'open')
      assert.equal(todoStatus(fixture.root, dependent.id), 'open')
    })
  } finally {
    removeFixture(fixture)
  }
})

test('live dependency gating stays the on-disk check: a done predecessor admits its dependent', async () => {
  const fixture = makeFixture('livegate', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'livegate', state: 'running', mode: 'live', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const predecessor = await service.createTodo({ title: 'Predecessor', request: 'r', acceptance: 'a' })
      const dependent = await service.createTodo({
        title: 'Dependent',
        depends_on: [predecessor.id],
        request: 'r',
        acceptance: 'a',
      })
      await service.updateTodo({ id: predecessor.id, status: 'done' })

      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
      })
      await host.tick(bot.id)

      assert.ok(store.findItemBySource(bot.id, dependent.id) !== undefined)
      assert.equal(todoStatus(fixture.root, predecessor.id), 'done')
    })
  } finally {
    removeFixture(fixture)
  }
})

test('acceptance uses checks from the latest done real verify attempt, not an earlier failed attempt', async () => {
  const fixture = makeFixture('latestverify', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'latestverify', state: 'running', mode: 'live', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const { repo, worktree } = makeWorktreeAheadOfMain(fixture.dir)
      const projectManager = {
        diff: async () => '',
        listWorktrees: () => [{ id: 'wt-1', clean: true }],
        getProject: () => ({ path: repo, defaultBranch: 'main' }),
        resolveWorktreePath: () => worktree,
        worktreeContainsTarget: () => true,
        rebaseWorktree: () => ({ rebased: true, head_sha: 'head-sha' }),
      } as unknown as ProjectManager
      const acceptanceInputs: Record<string, unknown>[] = []
      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(),
        projectManager,
        log: () => {},
        taskRunner: {
          async startTask({ task, input }) {
            if (task === 'test') acceptanceInputs.push(input as Record<string, unknown>)
            return { runId: `run:${task}` }
          },
          async getTask() {
            return { status: 'running' as const }
          },
        },
      })
      await host.tick(bot.id)

      const todo = await service.createTodo({ title: 'Latest attempt work', request: 'r', acceptance: 'a' })
      const item = store.createItem({
        botId: bot.id,
        sourceId: todo.id,
        state: 'accepting',
        project: 'alpha',
        title: 'Latest attempt work',
      })
      store.patchItem(item.id, { worktreeId: 'wt-1' })
      store.acquireLane({ project: 'alpha', botId: bot.id, itemId: item.id })

      const firstVerify = store.beginStep({ itemId: item.id, kind: 'verify', idemKey: `${item.id}:1:verify:1` })
      store.finishStep(firstVerify.step.id, { status: 'failed', error: 'first verification failed' })
      const latestVerify = store.beginStep({ itemId: item.id, kind: 'verify', idemKey: `${item.id}:1:verify:2` })
      store.finishStep(latestVerify.step.id, {
        status: 'done',
        output: {
          decision: 'real',
          reason: 'latest verification passed',
          project: 'alpha',
          class: 'default',
          acceptance: {
            checks: [
              { id: 'latest-check', claim: 'the latest check ran', surface: 'daemon', recipe: 'run latest check' },
            ],
          },
        },
      })

      for (let tick = 0; tick < 5 && acceptanceInputs.length === 0; tick += 1) await host.tick(bot.id)

      assert.equal(firstVerify.step.output, undefined)
      assert.equal(acceptanceInputs.length, 1)
      assert.deepEqual(acceptanceInputs[0]?.acceptance_criteria, [
        {
          id: 'latest-check',
          given: 'the daemon surface of alpha',
          when: 'run latest check',
          then: 'the latest check ran',
        },
      ])
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 7. a public answer to a verify park dispatches one fresh verify run ─────
//
// A verify park leaves the item `verifying` (its parked-from state) with its
// first verify step already done, so resuming it must schedule one fresh
// attempt above the last one. That attempt runs on the next tick, receives the
// stored answer as labeled text inside the existing request body (the strict
// bot-verify schema has no top-level clarification field), and advances the
// item to `verified`. A done step that still carries the run it started is
// history, not an in-flight run, so it must not suppress the retry; a pending
// attempt, by contrast, never queues a duplicate.

test('a public answer to a verify park dispatches one fresh verify run that forwards the answer in the request body and reaches verified', async () => {
  const fixture = makeFixture('verifieresume', 'live')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'verifieresume', state: 'running', mode: 'live', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      // Every verify task input the host starts, in order, plus one poll of the
      // second run that reports `running` before it finishes.
      const verifyInputs: Record<string, unknown>[] = []
      let verifyPolls = 0
      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async () => ({ turn: 1 })),
        log: () => {},
        taskRunner: {
          async startTask({ task, input }) {
            if (task !== 'bot-verify') return { runId: `run:${task}` }
            verifyInputs.push(input as Record<string, unknown>)
            return { runId: `run:bot-verify:${verifyInputs.length}` }
          },
          async getTask(runId) {
            if (runId === 'run:bot-verify:1') {
              return {
                status: 'done' as const,
                output: { decision: 'park', reason: 'needs a decision', question: 'which branch should the change target?' },
              }
            }
            if (runId === 'run:bot-verify:2') {
              verifyPolls += 1
              if (verifyPolls === 1) return { status: 'running' as const }
              return {
                status: 'done' as const,
                output: { decision: 'real', reason: 'reproduced on main', project: 'alpha', class: 'default' },
              }
            }
            return { status: 'running' as const }
          },
        },
      })
      // Warm-up pass consumes the forced-poll allowance, so later ticks neither
      // poll nor re-discover the todo once it exists.
      await host.tick(bot.id)

      const todo = await service.createTodo({ title: 'Resumed work', request: 'r', acceptance: 'a' })
      const item = store.createItem({
        botId: bot.id,
        sourceId: todo.id,
        state: 'discovered',
        project: 'alpha',
        title: 'Resumed work',
        body: 'Original request text',
      })

      // Tick 1: discovered -> verifying, and verify attempt 1 starts.
      await host.tick(bot.id)
      assert.equal(store.getItem(bot.id, item.id).state, 'verifying')
      assert.equal(store.findStepByIdemKey(`${item.id}:1:verify:1`)?.status, 'pending')
      assert.equal(verifyInputs.length, 1)

      // Tick 2: the park verdict lands and the item is parked on the question.
      await host.tick(bot.id)
      assert.equal(store.getItem(bot.id, item.id).state, 'parked')
      const parked = store.findStepByIdemKey(`${item.id}:1:verify:1`)
      assert.equal(parked?.status, 'done')
      assert.ok(parked !== undefined)
      // The finished step is left carrying the run it started: a persisted run
      // id on a done step is history, not an in-flight run, so resuming must
      // still schedule the retry (the run id must not suppress it).
      store.recordStepOutput(parked.id, { runId: 'run:bot-verify:1' })
      assert.equal(store.findStepByIdemKey(`${item.id}:1:verify:1`)?.status, 'done')

      // The public answer resumes the item; the next tick must dispatch exactly
      // one fresh verify attempt above the done one.
      await host.itemAction(bot.id, item.id, 'answer', 'target main and use the existing helper')
      await host.tick(bot.id)
      assert.equal(store.getItem(bot.id, item.id).state, 'verifying')
      assert.equal(store.findStepByIdemKey(`${item.id}:1:verify:2`)?.status, 'pending')
      assert.equal(verifyInputs.length, 2)
      // The answer reached the verifier as labeled text appended to the existing
      // request body, with the rest of the request preserved and no unsupported
      // top-level clarification field added.
      const resumed = verifyInputs[1] as { request?: { title?: string; body?: string }; clarification?: unknown }
      assert.equal(Object.hasOwn(resumed, 'clarification'), false)
      assert.equal(resumed.request?.title, 'Resumed work')
      assert.equal(
        resumed.request?.body,
        'Original request text\n\nUser clarification:\ntarget main and use the existing helper',
      )

      // A further tick while the fresh run is still pending starts no verify
      // task and enqueues no third attempt: a non-done step schedules nothing.
      await host.tick(bot.id)
      assert.equal(verifyInputs.length, 2)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:verify:3`), undefined)
      assert.equal(store.getItem(bot.id, item.id).state, 'verifying')

      // The finishing run moves the item to `verified`, with no further run and
      // the earlier park step, its run id and the journal all retained.
      await host.tick(bot.id)
      assert.equal(store.getItem(bot.id, item.id).state, 'verified')
      assert.equal(verifyInputs.length, 2)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:verify:1`)?.status, 'done')
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'verify.real'), true)
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 8. a workspace dryRun dispatch brief carries the clarification and deps ──
//
// A resumed dispatch (an item parked from `dispatched` and answered) reuses the
// same dispatch brief. For a workspace dry-run bot the brief must carry the
// stored public answer as a labeled clarification and truthful dependency
// semantics, so the session neither mistakes a todo id for a commit nor assumes
// a predecessor's dry-run artifact exists on main.

test('a workspace dryRun session.send payload carries the stored answer and truthful dependency semantics', async () => {
  const fixture = makeFixture('briefcontext', 'dryRun')
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: fixture.root })
      const bot = store.createBot({ name: 'briefcontext', state: 'running', mode: 'dryRun', configPath: fixture.configPath })
      const service = new WorkspaceTodoService(fixture.root)
      const predecessor = await service.createTodo({ title: 'Predecessor', request: 'r', acceptance: 'a' })
      const dependent = await service.createTodo({
        title: 'Dependent',
        depends_on: [predecessor.id],
        request: 'create the dependent artifact',
        acceptance: 'a',
      })

      const sent: string[] = []
      const host = createBotHost({
        db,
        workspaceRoot: fixture.root,
        session: botSession(async (_sessionId, input) => {
          sent.push(input.text)
          return { turn: 1 }
        }),
        log: () => {},
      })
      // Warm-up pass consumes the forced-poll allowance, so the driving tick
      // neither polls nor re-reads the dependent's blocked source.
      await host.tick(bot.id)

      // The item is already dispatched and carries the public answer a park
      // resume stored; its dependency lives in the todo file, not in the brief.
      const item = store.createItem({
        botId: bot.id,
        sourceId: dependent.id,
        state: 'dispatched',
        project: 'alpha',
        title: 'Dependent',
      })
      store.patchItem(item.id, {
        sessionId: 'session-1',
        answer: 'the predecessor id is a todo id, not a commit to wait for',
      })

      await host.tick(bot.id)

      assert.equal(sent.length, 1)
      const brief = sent[0] ?? ''
      // The stored public answer reaches the session as a labeled clarification.
      assert.match(brief, /User clarification:\nthe predecessor id is a todo id, not a commit to wait for/)
      // The dependency semantics are truthful: ids are todo ids, a dry run
      // merges nothing, scheduling completion is not artifact availability, and
      // a genuinely missing artifact must be reported rather than worked around.
      assert.match(brief, /depends_on/)
      assert.match(brief, new RegExp(predecessor.id))
      assert.match(brief, /todo ids, not Git commit hashes/i)
      assert.match(brief, /never merges/i)
      assert.match(brief, /genuinely missing/i)
      // The dry run wrote neither todo file.
      assert.equal(todoStatus(fixture.root, predecessor.id), 'open')
      assert.equal(todoStatus(fixture.root, dependent.id), 'open')
    })
  } finally {
    removeFixture(fixture)
  }
})
