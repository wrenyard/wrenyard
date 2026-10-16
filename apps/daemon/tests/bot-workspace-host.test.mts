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

// ── 3. done is persisted before accepted ────────────────────────────────────

test('the review-ready gate persists done before acceptance persists accepted', async () => {
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

      // Acceptance: lane, rebase, then the passing run that writes `accepted`.
      await host.tick(bot.id)
      await host.tick(bot.id)
      await host.tick(bot.id)
      await host.tick(bot.id)
      assert.equal(store.getItem(bot.id, item.id).state, 'accepted')
      assert.equal(todoStatus(fixture.root, todo.id), 'accepted')

      // The two writes are separate, and `done` was persisted first.
      const writes = store.listLog(bot.id, 0)
        .filter(entry => entry.code === 'todo.status')
        .map(entry => entry.message)
      assert.equal(writes.length, 2)
      assert.match(writes[0] ?? '', /set to done/)
      assert.match(writes[1] ?? '', /set to accepted/)
    })
  } finally {
    removeFixture(fixture)
  }
})

// ── 4. an accepted todo passes the pre-completion gate ──────────────────────

test('an accepted todo passes the pre-completion source gate and is never downgraded', async () => {
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

      const todo = await service.createTodo({ title: 'Accepted work', request: 'r', acceptance: 'a' })
      await service.updateTodo({ id: todo.id, status: 'accepted' })
      const item = store.createItem({ botId: bot.id, sourceId: todo.id, state: 'completing', project: 'alpha' })
      assert.equal(store.acquireLane({ project: 'alpha', botId: bot.id, itemId: item.id }), true)
      store.beginStep({ itemId: item.id, kind: 'inbox.complete', idemKey: `${item.id}:1:inbox.complete:1` })

      await host.tick(bot.id)

      // The source gate admitted the accepted todo and the completion write left
      // it accepted: no downgrade to in_progress or done, no status write at all.
      assert.equal(store.findStepByIdemKey(`${item.id}:1:inbox.complete:1`)?.status, 'done')
      assert.equal(todoStatus(fixture.root, todo.id), 'accepted')
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
