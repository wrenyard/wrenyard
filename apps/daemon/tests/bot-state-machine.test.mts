import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import type { Session } from '@wrenyard/session'
import { initDb } from '../lib/db/connection.mts'
import {
  assertItemTransition,
  canTransition,
  isTerminalItemState,
  requiresDeliveryLane,
} from '../lib/daemon/services/bot/machine.mts'
import { createBotStore } from '../lib/daemon/services/bot/store.mts'
import { createBotHost } from '../lib/daemon/services/bot/host.mts'
import { itemFingerprint } from '../lib/daemon/services/bot/adapters.mts'
import type { ProjectManager } from '../lib/core/project/manager.mts'

const WORKSPACE = '/tmp/wrenyard-bot-test-workspace'

/** The session surface a bot host needs, with per-test send/readLedger hooks. */
type BotTestSession = Pick<Session, 'createSession' | 'listSessions' | 'send' | 'readLedger'>

function botSession(
  send: BotTestSession['send'] = async () => ({ turn: 1 }),
  readLedger: BotTestSession['readLedger'] = () => [],
): BotTestSession {
  return { createSession: async () => ({ sessionId: 'session-1' }), listSessions: () => [], send, readLedger }
}

/** Model stored on the item so a follow-up send resolves without a ledger read. */
const TEST_MODEL = { provider: 'test', model: 'test-model', reasoningEffort: 'high' } as const

test('item state machine accepts the documented transitions and rejects the rest', () => {
  for (const [from, to] of [
    ['discovered', 'verifying'],
    ['verifying', 'verified'],
    ['verified', 'dispatched'],
    ['dispatched', 'in_progress'],
    ['in_progress', 'ready'],
    ['ready', 'accepting'],
    ['accepting', 'accepted'],
    ['accepted', 'merging'],
    ['merging', 'merged'],
    ['merged', 'completing'],
    ['completing', 'completed'],
    ['accepting', 'rejected'],
    ['rejected', 'in_progress'],
  ] as const) {
    assert.doesNotThrow(() => assertItemTransition(from, to), `${from} -> ${to} must be legal`)
  }
  // Any non-terminal state may park, fail or withdraw.
  for (const state of ['discovered', 'verifying', 'dispatched', 'in_progress', 'ready', 'merging'] as const) {
    assert.equal(canTransition(state, 'parked'), true)
    assert.equal(canTransition(state, 'failed'), true)
    assert.equal(canTransition(state, 'withdrawn'), true)
  }
  // Illegal jumps and moves out of a terminal state throw.
  assert.throws(() => assertItemTransition('discovered', 'merged'), /illegal bot item transition/)
  assert.throws(() => assertItemTransition('verified', 'completed'), /illegal bot item transition/)
  assert.throws(() => assertItemTransition('completed', 'verifying'), /illegal bot item transition/)
  assert.throws(() => assertItemTransition('dismissed', 'discovered'), /illegal bot item transition/)
  assert.throws(() => assertItemTransition('withdrawn', 'discovered'), /illegal bot item transition/)
  // A failed item returns only by an explicit manual retry.
  assert.doesNotThrow(() => assertItemTransition('failed', 'discovered'))
  assert.throws(() => assertItemTransition('failed', 'verifying'), /illegal bot item transition/)
})

test('a parked item resumes only into the state it parked from', () => {
  assert.doesNotThrow(() => assertItemTransition('parked', 'accepting', { parkedFrom: 'accepting' }))
  assert.throws(() => assertItemTransition('parked', 'accepting', { parkedFrom: 'ready' }))
  assert.throws(() => assertItemTransition('parked', 'accepting'))
  // Dismissing, failing or withdrawing a parked item is always allowed.
  assert.doesNotThrow(() => assertItemTransition('parked', 'dismissed'))
  assert.doesNotThrow(() => assertItemTransition('parked', 'failed'))
  assert.doesNotThrow(() => assertItemTransition('parked', 'withdrawn'))
})

test('terminal states and the delivery-lane range are exactly the documented ones', () => {
  assert.equal(isTerminalItemState('completed'), true)
  assert.equal(isTerminalItemState('dismissed'), true)
  assert.equal(isTerminalItemState('withdrawn'), true)
  assert.equal(isTerminalItemState('failed'), false)
  assert.equal(isTerminalItemState('parked'), false)
  assert.equal(isTerminalItemState('merged'), false)

  for (const state of ['accepting', 'accepted', 'rejected', 'merging', 'merged', 'completing'] as const) {
    assert.equal(requiresDeliveryLane(state), true, `${state} must hold the lane`)
  }
  for (const state of ['discovered', 'in_progress', 'ready', 'parked', 'failed', 'completed'] as const) {
    assert.equal(requiresDeliveryLane(state), false, `${state} must not hold the lane`)
  }
})

test('the delivery lane admits one item per project across every bot', () => {
  const db = initDb(':memory:')
  const store = createBotStore({ db, workspaceRoot: WORKSPACE })
  const first = store.createBot({ name: 'first', state: 'running' })
  const second = store.createBot({ name: 'second', state: 'running' })

  assert.equal(store.acquireLane({ project: 'alpha', botId: first.id, itemId: 'item-1' }), true)
  // The same item re-acquiring is idempotent...
  assert.equal(store.acquireLane({ project: 'alpha', botId: first.id, itemId: 'item-1' }), true)
  // ...but another bot's item of the same project cannot take it.
  assert.equal(store.acquireLane({ project: 'alpha', botId: second.id, itemId: 'item-2' }), false)
  // A different project delivers in parallel.
  assert.equal(store.acquireLane({ project: 'beta', botId: second.id, itemId: 'item-2' }), true)

  assert.equal(store.releaseLane({ project: 'alpha', itemId: 'item-1' }), true)
  assert.equal(store.releaseLane({ project: 'alpha', itemId: 'item-1' }), false)
  assert.equal(store.acquireLane({ project: 'alpha', botId: second.id, itemId: 'item-2' }), true)
})

test('restart reconciliation marks an unprobeable pending notify unknown without re-running it', async () => {
  const db = initDb(':memory:')
  const store = createBotStore({ db, workspaceRoot: WORKSPACE })
  const bot = store.createBot({ name: 'recover', state: 'running' })
  const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'completing' })

  const idemKey = `${item.id}:1:notify:1`
  const { step } = store.beginStep({
    itemId: item.id,
    kind: 'notify',
    idemKey,
    input: { wouldNotify: true },
  })
  assert.equal(step.status, 'pending')
  // Only a started step is probed on restart; mark this notify in flight.
  store.markStepStarted(step.id)

  const host = createBotHost({
    db,
    workspaceRoot: WORKSPACE,
    session: botSession(),
    log: () => {},
  })

  await host.reconcile()

  const after = store.findStepByIdemKey(idemKey)
  assert.equal(after?.status, 'unknown')
  const log = store.listLog(bot.id, 0)
  // The notify handler is registered, but it has no probe, so reconciliation
  // reports it as unprobeable rather than unavailable.
  assert.equal(log.filter(entry => entry.code === 'step.unprobeable').length, 1)
  assert.equal(log.some(entry => entry.code === 'step.failed'), false)
  // The item itself is left exactly where it was.
  assert.equal(store.getItem(bot.id, item.id).state, 'completing')
  // A second reconciliation does not re-log or change anything.
  await host.reconcile()
  assert.equal(store.findStepByIdemKey(idemKey)?.status, 'unknown')
  assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'step.unprobeable').length, 1)
})

test('a public tick during an in-flight tick never runs the same step twice', async () => {
  // Each test owns a distinct workspace root: the in-memory database is one
  // shared connection, so a shared root would leak rows between the cases.
  const root = `${WORKSPACE}-tick`
  const db = initDb(':memory:')
  const store = createBotStore({ db, workspaceRoot: root })
  const bot = store.createBot({ name: 'ticker', state: 'running' })
  const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'dispatched' })
  store.patchItem(item.id, { sessionId: 'session-1', sessionModel: TEST_MODEL })

  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const host = createBotHost({
    db,
    workspaceRoot: root,
    session: botSession(async () => { calls += 1; await gate; return { turn: 1 } }),
    log: () => {},
  })
  const idemKey = `${item.id}:1:session.send:1`
  store.beginStep({ itemId: item.id, kind: 'session.send', idemKey })

  const first = host.tick(bot.id)
  const second = host.tick(bot.id)
  release()
  await Promise.all([first, second])

  assert.equal(calls, 1)
  assert.equal(store.findStepByIdemKey(idemKey)?.status, 'done')
  assert.equal(store.getItem(bot.id, item.id).state, 'in_progress')
})

test('a handler error in a lane state parks the item and releases the project lane', async () => {
  const root = `${WORKSPACE}-lane`
  const db = initDb(':memory:')
  const store = createBotStore({ db, workspaceRoot: root })
  // A live bot runs the real handler; a dry-run bot would only record it.
  const bot = store.createBot({ name: 'laner', state: 'running', mode: 'live' })
  // `merging` is a lane state whose only next step is the merge handler; using
  // it here keeps the failing step deterministic (an `accepting` item would also
  // enqueue the rebase step).
  const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'merging', project: 'alpha' })
  assert.equal(store.acquireLane({ project: 'alpha', botId: bot.id, itemId: item.id }), true)
  // The merge handler throws for an item without a worktree, so the step fails
  // while the item holds the lane.
  store.beginStep({ itemId: item.id, kind: 'merge', idemKey: `${item.id}:1:merge:1` })

  const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
  await host.tick(bot.id)

  const parked = store.getItem(bot.id, item.id)
  assert.equal(parked.state, 'parked')
  assert.equal(parked.parkedFrom, 'merging')
  assert.equal(parked.question, 'item has no project worktree to merge')
  // The lane is released in the same write, so the project is not blocked.
  assert.equal(store.getLane('alpha'), undefined)
  assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'step.failed'), true)
})

test('cleaning up a terminal item leaves no lane row behind', async () => {
  const root = `${WORKSPACE}-cleanup`
  const db = initDb(':memory:')
  const store = createBotStore({ db, workspaceRoot: root })
  const bot = store.createBot({ name: 'cleaner', state: 'running' })
  const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'completed', project: 'beta' })
  // Simulate a lane row left on a terminal item.
  assert.equal(store.acquireLane({ project: 'beta', botId: bot.id, itemId: item.id }), true)

  const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
  await host.itemAction(bot.id, item.id, 'cleanup')

  assert.equal(store.getLane('beta'), undefined)
  assert.throws(() => store.getItem(bot.id, item.id), /unknown bot item/)
})

test('reconcile leaves a never-started pending step for the tick to run', async () => {
  // reconcile() walks every running bot of its workspace root, so this case
  // needs its own root as well.
  const root = `${WORKSPACE}-queued`
  const db = initDb(':memory:')
  const store = createBotStore({ db, workspaceRoot: root })
  const bot = store.createBot({ name: 'queued', state: 'running' })
  const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'dispatched' })
  store.patchItem(item.id, { sessionId: 'session-1', sessionModel: TEST_MODEL })

  const idemKey = `${item.id}:1:session.send:1`
  store.beginStep({ itemId: item.id, kind: 'session.send', idemKey })
  assert.equal(store.findStepByIdemKey(idemKey)?.startedAt, undefined)

  const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
  await host.reconcile()
  // A pending step that never started is not proven unknown; it stays queued.
  assert.equal(store.findStepByIdemKey(idemKey)?.status, 'pending')
  assert.equal(store.getItem(bot.id, item.id).state, 'dispatched')

  // The next tick runs it normally.
  await host.tick(bot.id)
  assert.equal(store.findStepByIdemKey(idemKey)?.status, 'done')
  assert.equal(store.getItem(bot.id, item.id).state, 'in_progress')
})

// ── adapter host integration ───────────────────────────────────────────────

/** Routing entries the config loader requires; the tests never send a turn. */
const ADAPTER_ROUTING = {
  default: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
  acceptance: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
  judgment: { provider: 'test', model: 'test-model', reasoningEffort: 'high' },
} as const

/** An inbox command adapter: one JSON request on stdin, one reply per op. */
function inboxScript(behavior: Record<string, unknown>): string {
  return [
    `const behavior = ${JSON.stringify(behavior)};`,
    "let raw = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { raw += chunk });",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(raw === '' ? '{}' : raw);",
    "  const reply = behavior[request.op];",
    "  process.stdout.write(JSON.stringify(reply === undefined ? { ok: false } : reply));",
    "});",
  ].join('\n')
}

/** A notifier command adapter that appends every request to a file. */
function notifierScript(): string {
  return [
    "import { appendFileSync } from 'node:fs'",
    "let raw = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { raw += chunk });",
    "process.stdin.on('end', () => {",
    "  const target = process.env.BOT_FAKE_NOTIFY_FILE;",
    "  if (typeof target === 'string' && target !== '') appendFileSync(target, raw + '\\n');",
    "  process.stdout.write(JSON.stringify({ ok: true }));",
    "});",
  ].join('\n')
}

interface BotFixture {
  configPath: string
  notifyFile: string
  home: string
  dir: string
}

/**
 * Write a temporary bot config under `<home>/bots` plus its fake inbox and
 * notifier scripts, launched through this same node binary.
 */
async function writeBotFixture(options: {
  name: string
  mode: 'live' | 'dryRun'
  inboxBehavior: Record<string, unknown>
  /** Cadence the config declares; the tests' usual fast one by default. */
  cadence?: { tickSeconds: number; pollMinutes: number }
}): Promise<BotFixture> {
  const home = await mkdtemp(join(tmpdir(), 'wrenyard-bot-home-'))
  const dir = await mkdtemp(join(tmpdir(), 'wrenyard-bot-adapter-'))
  const botsDir = join(home, 'bots')
  await mkdir(botsDir, { recursive: true })
  const inboxPath = join(dir, 'inbox.mjs')
  await writeFile(inboxPath, inboxScript(options.inboxBehavior), 'utf-8')
  const notifierPath = join(dir, 'notifier.mjs')
  await writeFile(notifierPath, notifierScript(), 'utf-8')
  const notifyFile = join(dir, 'notify.log')
  const config = {
    name: options.name,
    mode: options.mode,
    inbox: { kind: 'command', argv: [process.execPath, inboxPath], timeoutMs: 10_000 },
    notifier: {
      kind: 'command',
      argv: [process.execPath, notifierPath],
      env: { BOT_FAKE_NOTIFY_FILE: notifyFile },
      timeoutMs: 10_000,
    },
    projects: [{ id: 'alpha', match: ['alpha'], merge: true, push: true }],
    routing: ADAPTER_ROUTING,
    concurrency: { maxActiveItems: 3, maxDispatchPerTick: 2 },
    cadence: options.cadence ?? { tickSeconds: 10, pollMinutes: 1 },
    budgets: { maxCorrections: 3, maxAcceptanceAttempts: 2, maxItemHours: 8, maxItemsPerDay: 20 },
  }
  const configPath = join(botsDir, `${options.name}.json`)
  await writeFile(configPath, JSON.stringify(config), 'utf-8')
  return { configPath, notifyFile, home, dir }
}

/** Run a body with the config home pointed at one fixture, then restore it. */
async function withConfigHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.WRENYARD_CONFIG_HOME
  process.env.WRENYARD_CONFIG_HOME = home
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.WRENYARD_CONFIG_HOME
    else process.env.WRENYARD_CONFIG_HOME = previous
  }
}

async function removeFixture(fixture: BotFixture): Promise<void> {
  await rm(fixture.home, { recursive: true, force: true })
  await rm(fixture.dir, { recursive: true, force: true })
}

/**
 * Await the tick pass a mocked timer interval just queued. The host serializes
 * every pass, so `ticking` is already true when the interval callback returns.
 */
async function settleTimerPass(host: { readonly ticking: boolean }): Promise<void> {
  for (let i = 0; i < 500 && host.ticking; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(host.ticking, false, 'the timer pass settled')
}

test('repeated inbox polls admit one item per source', async () => {
  const root = `${WORKSPACE}-poll`
  const fixture = await writeBotFixture({
    name: 'poller',
    mode: 'live',
    inboxBehavior: {
      list: { items: [{ id: 'source-a', title: 'Do the thing', body: 'details', project: 'alpha' }] },
    },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'poller', state: 'running', mode: 'live', configPath: fixture.configPath })
      // The first tick also starts the verify step this stage wires in, so a
      // stubbed detached run parks the item deterministically instead of failing
      // the step: the first tick records the run id, the second polls it.
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(),
        log: () => {},
        taskRunner: {
          async startTask() { return { runId: 'run-verify' } },
          async getTask() {
            return {
              status: 'done' as const,
              output: { decision: 'park', reason: 'needs a decision', question: 'which project?' },
            }
          },
        },
      })

      await host.tick(bot.id)
      await host.tick(bot.id)

      const items = store.listItems(bot.id)
      assert.equal(items.length, 1)
      assert.equal(items[0]?.sourceId, 'source-a')
      assert.equal(items[0]?.state, 'parked')
      assert.equal(items[0]?.project, 'alpha')
      assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'poll.discovered').length, 1)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('an unchanged inbox poll logs no poll.ok row and one poll.changed per change', async () => {
  const root = `${WORKSPACE}-polllog`
  const fixture = await writeBotFixture({
    name: 'polllog',
    mode: 'live',
    inboxBehavior: { list: { items: [] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      // A file-backed inbox script so one poll can differ from the previous one;
      // the fixture's config already points at this path.
      const itemsFile = join(fixture.dir, 'inbox-items.json')
      await writeFile(join(fixture.dir, 'inbox.mjs'), [
        "import { readFileSync } from 'node:fs'",
        "let raw = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { raw += chunk });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(raw === '' ? '{}' : raw);",
        `  const items = JSON.parse(readFileSync(${JSON.stringify(itemsFile)}, 'utf8'));`,
        '  const replies = {',
        '    list: { items },',
        '    get: { item: items.find((candidate) => candidate.id === request.id) ?? null },',
        '    complete: { ok: true },',
        '    annotate: { ok: true },',
        '    release: { ok: true },',
        '  };',
        '  process.stdout.write(JSON.stringify(replies[request.op] ?? { ok: false }));',
        '});',
      ].join('\n'), 'utf-8')

      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'polllog', state: 'running', mode: 'live', configPath: fixture.configPath })
      const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
      const source = (id: string, title: string) => ({ id, title, body: 'details', project: 'alpha' })
      // A named `bot.tick` forces a poll at most once per 30 s, so the later
      // polls are made due on the ordinary cadence instead.
      const pollNow = () => store.updateBot(bot.id, { nextPollAt: new Date(Date.now() - 1_000).toISOString() })
      const codeCount = (code: string) => store.listLog(bot.id, 0).filter(entry => entry.code === code).length

      await writeFile(itemsFile, JSON.stringify([source('source-a', 'First')]), 'utf-8')
      await host.tick(bot.id)
      // The first poll after host start has no baseline and reports a change.
      assert.equal(codeCount('poll.changed'), 1)

      pollNow()
      await host.tick(bot.id)
      // An identical repeat is routine: no info row, one rate-limited debug row.
      assert.equal(codeCount('poll.changed'), 1)
      assert.equal(codeCount('poll.ok'), 0)
      assert.equal(codeCount('poll.unchanged'), 1)

      await writeFile(itemsFile, JSON.stringify([
        source('source-a', 'First'),
        source('source-b', 'Second'),
      ]), 'utf-8')
      pollNow()
      await host.tick(bot.id)
      // A changed result is reported again, and the new source is admitted.
      assert.equal(codeCount('poll.changed'), 2)
      assert.equal(store.listItems(bot.id).length, 2)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('the bot config drives the poll interval and the timer pass cadence', async () => {
  const root = `${WORKSPACE}-cadence`
  const fixture = await writeBotFixture({
    name: 'cadence',
    mode: 'live',
    inboxBehavior: { list: { items: [] } },
    cadence: { tickSeconds: 30, pollMinutes: 1 },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'cadence', state: 'running', mode: 'live', configPath: fixture.configPath })
      // A controllable clock, so a 30 s cadence is exercised without waiting;
      // the timer itself is mocked so its 10 s interval fires on demand.
      let now = Date.now()
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(),
        log: () => {},
        now: () => now,
        tickMs: 10_000,
      })
      mock.timers.enable({ apis: ['setInterval'] })
      try {
        await host.start()

        // The poll interval is the config's pollMinutes (1 min), not the 10 min
        // default the host falls back to without a config.
        const nextPollAt = Date.parse(store.getBot(bot.id).nextPollAt ?? '')
        assert.ok(
          Math.abs(nextPollAt - (Date.now() + 60_000)) < 5_000,
          `next poll was ${Math.round((nextPollAt - Date.now()) / 1_000)} s away`,
        )

        // The first pass after start always runs, but it is not a cadence tick.
        assert.equal((await host.health(bot.id)).ticks, 0)

        // A timer pass 10 s later is early for this bot's own 30 s cadence.
        now += 10_000
        mock.timers.tick(10_000)
        await settleTimerPass(host)
        assert.equal((await host.health(bot.id)).ticks, 0)

        // Still early at 20 s.
        now += 10_000
        mock.timers.tick(10_000)
        await settleTimerPass(host)
        assert.equal((await host.health(bot.id)).ticks, 0)

        // Once its cadence has elapsed the pass advances it and is counted.
        now += 10_000
        mock.timers.tick(10_000)
        await settleTimerPass(host)
        assert.equal((await host.health(bot.id)).ticks, 1)
      } finally {
        host.stop()
        mock.timers.reset()
      }
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a source that disappears mid-flight is withdrawn and never merged', async () => {
  const root = `${WORKSPACE}-withdraw`
  const fixture = await writeBotFixture({
    name: 'withdrawer',
    mode: 'live',
    inboxBehavior: { list: { items: [] }, get: { item: null } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'withdrawer', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-gone', state: 'accepted', project: 'alpha' })
      assert.equal(store.acquireLane({ project: 'alpha', botId: bot.id, itemId: item.id }), true)
      const mergeKey = `${item.id}:1:merge:1`
      store.beginStep({ itemId: item.id, kind: 'merge', idemKey: mergeKey })

      const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
      await host.tick(bot.id)

      assert.equal(store.getItem(bot.id, item.id).state, 'withdrawn')
      // The lane is released and the pending merge is cancelled, not run.
      assert.equal(store.getLane('alpha'), undefined)
      assert.equal(store.findStepByIdemKey(mergeKey)?.status, 'unknown')
      const log = store.listLog(bot.id, 0)
      assert.equal(log.some(entry => entry.code === 'source.withdrawn'), true)
      assert.equal(log.some(entry => entry.code === 'step.failed'), false)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a bot-verify not_real decision dismisses the item and queues its notification', async () => {
  const root = `${WORKSPACE}-verify`
  const fixture = await writeBotFixture({
    name: 'verifier',
    mode: 'live',
    inboxBehavior: { list: { items: [] }, get: { item: null } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'verifier', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({
        botId: bot.id,
        sourceId: 'source-x',
        state: 'discovered',
        title: 'Ship the thing',
        project: 'alpha',
      })

      const calls: string[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(),
        log: () => {},
        taskRunner: {
          // Exactly one judgment run is started, and it is the verify task.
          async startTask({ task }) {
            calls.push(task)
            return task === 'bot-verify' ? { runId: 'run-verify' } : { rejected: `unexpected task ${task}` }
          },
          async getTask() {
            return { status: 'done' as const, output: { decision: 'not_real', reason: 'already implemented' } }
          },
        },
      })

      // The first tick only starts the detached run: the item waits in verifying.
      await host.tick(bot.id)
      assert.deepEqual(calls, ['bot-verify'])
      assert.equal(store.getItem(bot.id, item.id).state, 'verifying')
      const startedVerify = store.findStepByIdemKey(`${item.id}:1:verify:1`)
      assert.equal(startedVerify?.status, 'pending')
      assert.match(String(startedVerify?.output ?? ''), /run-verify/)

      // The second tick polls the finished run and applies the verify handling.
      await host.tick(bot.id)
      const after = store.getItem(bot.id, item.id)
      assert.equal(after.state, 'dismissed')
      assert.equal(after.error, 'already implemented')
      assert.equal(store.findStepByIdemKey(`${item.id}:1:verify:1`)?.status, 'done')
      // The dismissal notification is queued for a later tick, not sent now.
      assert.equal(store.findStepByIdemKey(`${item.id}:1:notify:1`)?.status, 'pending')
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'verify.not_real'), true)

      // The next tick sends it, even though the item is already terminal.
      await host.tick(bot.id)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:notify:1`)?.status, 'done')
      assert.equal(existsSync(fixture.notifyFile), true)
      assert.match(readFileSync(fixture.notifyFile, 'utf-8'), /Not dispatched: Ship the thing/)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a detached verify run keeps the item verifying until its task run finishes', async () => {
  const root = `${WORKSPACE}-detached`
  const fixture = await writeBotFixture({
    name: 'detached',
    mode: 'live',
    inboxBehavior: { list: { items: [] }, get: { item: null } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'detached', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({
        botId: bot.id,
        sourceId: 'source-d',
        state: 'discovered',
        title: 'Ship the thing',
        project: 'alpha',
      })

      let started = 0
      let runStatus: 'running' | 'done' = 'running'
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(),
        log: () => {},
        taskRunner: {
          async startTask() { started += 1; return { runId: 'run-detached' } },
          async getTask() {
            if (runStatus === 'running') return { status: 'running' as const }
            return {
              status: 'done' as const,
              output: {
                decision: 'real',
                reason: 'reproduced on main',
                project: 'alpha',
                class: 'default',
                brief: 'Change greeting.txt to hello, bot.',
                acceptance: { checks: [{ id: 'c1', claim: 'greeting.txt reads hello, bot', surface: 'daemon', recipe: 'cat greeting.txt' }] },
              },
            }
          },
        },
      })
      const verifyKey = `${item.id}:1:verify:1`

      // Two ticks while the run is still going: the item stays verifying, the
      // run is polled (not restarted) and no tick waited for the model to finish.
      await host.tick(bot.id)
      await host.tick(bot.id)

      assert.equal(started, 1)
      assert.equal(store.getItem(bot.id, item.id).state, 'verifying')
      const polling = store.findStepByIdemKey(verifyKey)
      assert.equal(polling?.status, 'pending')
      assert.notEqual(polling?.startedAt, undefined)
      assert.match(String(polling?.output ?? ''), /run-detached/)

      // Once the run finishes, the same verify handling advances the item.
      runStatus = 'done'
      await host.tick(bot.id)

      const verified = store.getItem(bot.id, item.id)
      assert.equal(verified.state, 'verified')
      assert.equal(store.findStepByIdemKey(verifyKey)?.status, 'done')
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'verify.real'), true)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a failed acceptance run is retried while the item keeps its project lane', async () => {
  const root = `${WORKSPACE}-accept-run`
  const fixture = await writeBotFixture({
    name: 'acceptor',
    mode: 'live',
    // The source is still listed, so the in-flight item is not withdrawn.
    inboxBehavior: { list: { items: [{ id: 'source-a', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'acceptor', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-a', state: 'accepting', project: 'alpha' })
      store.patchItem(item.id, { worktreeId: 'wt-accept' })
      // The store acquires the project lane when an item enters `accepting`.
      assert.equal(store.acquireLane({ project: 'alpha', botId: bot.id, itemId: item.id }), true)
      // A recorded acceptance plan and a finished rebase: acceptance runs next.
      const verify = store.beginStep({ itemId: item.id, kind: 'verify', idemKey: `${item.id}:1:verify:1` })
      store.finishStep(verify.step.id, {
        status: 'done',
        output: {
          decision: 'real',
          reason: 'reproduced on main',
          project: 'alpha',
          class: 'default',
          acceptance: {
            checks: [{ id: 'c1', claim: 'greeting.txt reads hello, bot', surface: 'daemon', recipe: 'cat greeting.txt' }],
          },
        },
      })
      const rebase = store.beginStep({ itemId: item.id, kind: 'rebase', idemKey: `${item.id}:1:rebase:1` })
      store.finishStep(rebase.step.id, { status: 'done', output: { rebased: true } })

      const started: string[] = []
      let polls = 0
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(),
        log: () => {},
        taskRunner: {
          async startTask({ task }) { started.push(task); return { runId: `run-${started.length}` } },
          async getTask() {
            polls += 1
            // The first acceptance run ends failed; the retry finishes cleanly.
            if (polls === 1) return { status: 'failed' as const, error: 'final output is empty' }
            return { status: 'done' as const, output: { assessments: [{ criterion_id: 'c1', status: 'passed' }] } }
          },
        },
      })

      // The first tick starts the detached acceptance run; the item waits.
      await host.tick(bot.id)
      assert.deepEqual(started, ['test'])
      assert.equal(store.getItem(bot.id, item.id).state, 'accepting')
      const firstAttempt = store.findStepByIdemKey(`${item.id}:1:accept:1`)
      assert.equal(firstAttempt?.status, 'pending')
      assert.match(String(firstAttempt?.output ?? ''), /run-1/)

      // The second tick sees the run failed: no park on the first occurrence.
      await host.tick(bot.id)
      const afterFailure = store.getItem(bot.id, item.id)
      assert.equal(afterFailure.state, 'accepting')
      assert.equal(store.getLane('alpha')?.itemId, item.id)
      assert.equal(afterFailure.counters?.acceptanceRunFailures, 1)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:accept:1`)?.status, 'failed')
      const log = store.listLog(bot.id, 0)
      assert.equal(log.some(entry => entry.code === 'accept.run_failed'), true)
      assert.equal(log.some(entry => entry.code === 'step.failed'), false)

      // The retry is a new attempt: it starts, then its passing result lands.
      await host.tick(bot.id)
      assert.deepEqual(started, ['test', 'test'])
      await host.tick(bot.id)

      assert.equal(store.getItem(bot.id, item.id).state, 'accepted')
      assert.equal(store.getItem(bot.id, item.id).counters?.acceptanceRunFailures, 1)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:accept:2`)?.status, 'done')
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'acceptance.passed'), true)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('dry-run completion and notification record would-be outputs without sending', async () => {
  const root = `${WORKSPACE}-dryrun`
  const title = 'Ship the thing'
  const body = 'with details'
  const fixture = await writeBotFixture({
    name: 'dry',
    mode: 'dryRun',
    inboxBehavior: {
      list: { items: [{ id: 'source-c', title, body, project: 'alpha' }] },
      get: { item: { id: 'source-c', title, body, project: 'alpha', open: true } },
    },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'dry', state: 'running', mode: 'dryRun', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-c', state: 'ready', project: 'alpha' })
      store.patchItem(item.id, { title, body, fingerprint: itemFingerprint({ title, body }) })
      // Walk the item into the lane range so the store acquires the project
      // lane, exactly as the accept, merge and push steps would.
      for (const next of ['accepting', 'accepted', 'merging', 'merged', 'completing'] as const) {
        store.transitionItem(item.id, next)
      }
      assert.equal(store.getLane('alpha')?.itemId, item.id)

      const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
      await host.tick(bot.id)
      await host.tick(bot.id)

      assert.equal(store.getItem(bot.id, item.id).state, 'completed')
      const completeStep = store.findStepByIdemKey(`${item.id}:1:inbox.complete:1`)
      assert.equal(completeStep?.status, 'done')
      assert.match(String(completeStep?.output ?? ''), /wouldComplete/)
      const notifyStep = store.findStepByIdemKey(`${item.id}:1:notify:1`)
      assert.equal(notifyStep?.status, 'done')
      assert.match(String(notifyStep?.output ?? ''), /wouldNotify/)
      // The fake notifier was never started, so its file was never written.
      assert.equal(existsSync(fixture.notifyFile), false)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a dispatched item with an empty ledger sends the routed default model', async () => {
  const root = `${WORKSPACE}-first-send`
  const fixture = await writeBotFixture({
    name: 'firstsend',
    mode: 'live',
    // The source is still listed, so the in-flight item is not withdrawn.
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'firstsend', state: 'running', mode: 'live', configPath: fixture.configPath })
      // The state right after `session.create` stored the id: the session exists,
      // the ledger has no `turn.started` yet and no model is stored on the item.
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'dispatched', project: 'alpha' })
      store.patchItem(item.id, { sessionId: 'session-1' })

      const sent: { sessionId: string; text: string; model: { provider: string; model: string; reasoningEffort: string } }[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        // `readLedger` defaults to an empty ledger.
        session: botSession(async (sessionId, input) => {
          sent.push({ sessionId, text: input.text, model: input.model })
          return { turn: 1 }
        }),
        log: () => {},
      })

      await host.tick(bot.id)

      // The first dispatch resolves the routing entry for the item's class
      // (here the `default` one) instead of failing for a missing stored model.
      assert.equal(sent.length, 1)
      assert.equal(sent[0]?.sessionId, 'session-1')
      assert.deepEqual(sent[0]?.model, ADAPTER_ROUTING.default)
      assert.match(sent[0]?.text ?? '', /\[bot:/)
      const after = store.getItem(bot.id, item.id)
      assert.equal(after.state, 'in_progress')
      assert.deepEqual(after.sessionModel, ADAPTER_ROUTING.default)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:session.send:1`)?.status, 'done')
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a stalled session is nudged once per finished turn', async () => {
  const root = `${WORKSPACE}-nudge`
  const fixture = await writeBotFixture({
    name: 'nudger',
    mode: 'live',
    // The source is still listed, so the in-flight item is not withdrawn.
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'nudger', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'in_progress', project: 'alpha' })
      store.patchItem(item.id, { sessionId: 'session-1', worktreeId: 'wt-nudge' })

      // An idle session whose only turn has finished on a plain reply: neither
      // `BOT-READY` nor `BOT-BLOCKED`, so it will never move on its own. Its
      // `turn.started` model is the one a follow-up must reuse.
      const at = new Date().toISOString()
      const ledger: ReturnType<BotTestSession['readLedger']> = [
        {
          seq: 1,
          at,
          type: 'turn.started',
          turn: 1,
          id: 't1',
          text: 'the dispatch brief',
          model: { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' },
        },
        { seq: 2, at, type: 'reply.sent', turn: 1, text: 'I read the file but did not change it.' },
        { seq: 3, at, type: 'turn.finished', turn: 1, id: 't1', status: 'completed' },
      ]

      const sent: { sessionId: string; text: string; model: unknown }[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(
          async (sessionId, input) => {
            sent.push({ sessionId, text: input.text, model: input.model })
            return { turn: 2 }
          },
          () => ledger,
        ),
        // The review reads the worktree diff; a stub keeps this case off git.
        projectManager: { diff: async () => '' } as unknown as ProjectManager,
        log: () => {},
        taskRunner: {
          async startTask() { return { runId: 'run-review' } },
          async getTask() {
            return { status: 'done' as const, output: { verdict: 'continue', reason: 'still working on it' } }
          },
        },
      })

      // The first tick starts the detached review; the second applies its
      // `continue` verdict, and that is where the stalled session is nudged.
      await host.tick(bot.id)
      await host.tick(bot.id)

      assert.equal(sent.length, 1)
      assert.equal(sent[0]?.sessionId, 'session-1')
      assert.deepEqual(sent[0]?.model, { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' })
      assert.match(sent[0]?.text ?? '', /wt-nudge/)
      assert.match(sent[0]?.text ?? '', /BOT-READY <head sha>/)
      assert.match(sent[0]?.text ?? '', /BOT-BLOCKED <question>/)
      assert.match(sent[0]?.text ?? '', /commit it locally, and end/)

      const nudged = store.getItem(bot.id, item.id)
      assert.equal(nudged.state, 'in_progress')
      assert.equal(nudged.counters?.corrections, 1)
      assert.equal(nudged.counters?.nudgedTurn, 1)
      assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'review.nudge').length, 1)

      // A later tick with no new session turn sends no second nudge.
      await host.tick(bot.id)
      assert.equal(sent.length, 1)
      assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'review.nudge').length, 1)
    })
  } finally {
    await removeFixture(fixture)
  }
})

// ── load back-off, watchdogs and the item age budget ───────────────────────

test('load back-off holds new dispatch while overloaded and resumes when it clears', async () => {
  const root = `${WORKSPACE}-backoff`
  const fixture = await writeBotFixture({
    name: 'backoff',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'backoff', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'verified', project: 'alpha' })

      let active = 8
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(),
        log: () => {},
        loadProbe: () => ({ activeExecutions: active, maxExecutions: 10, queuedExecutions: 0 }),
      })
      const dispatchKey = `${item.id}:1:worktree.create:1`

      // Overloaded: the verified -> worktree.create dispatch step is not created,
      // the back-off is logged once and health reports it.
      await host.tick(bot.id)
      assert.equal(store.findStepByIdemKey(dispatchKey), undefined)
      assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'load.backoff').length, 1)
      assert.equal((await host.health(bot.id)).load.backedOff, true)

      // Healthy again: dispatch resumes on the next tick.
      active = 0
      await host.tick(bot.id)
      assert.notEqual(store.findStepByIdemKey(dispatchKey), undefined)
      assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'load.recovered').length, 1)
      assert.equal((await host.health(bot.id)).load.backedOff, false)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a verify run that outlives its budget is cancelled and retried', async () => {
  const root = `${WORKSPACE}-stuck`
  const fixture = await writeBotFixture({
    name: 'stuck',
    mode: 'live',
    inboxBehavior: { list: { items: [] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'stuck', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'verifying', project: 'alpha' })

      // A detached verify run that was started 30 minutes ago: past the default
      // 20-minute verify budget.
      const verifyKey = `${item.id}:1:verify:1`
      const { step } = store.beginStep({ itemId: item.id, kind: 'verify', idemKey: verifyKey })
      store.markStepStarted(step.id)
      store.recordStepOutput(step.id, { runId: 'run-stuck' })
      const startedAt = new Date(Date.now() - 30 * 60_000).toISOString()
      db.prepare<[string, string], unknown>('UPDATE bot_step SET started_at = ? WHERE id = ?').run(startedAt, step.id)

      const cancelled: string[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(),
        log: () => {},
        taskRunner: {
          async startTask() { return { runId: 'run-stuck' } },
          async getTask() { return { status: 'running' as const } },
          async cancelTask(runId) { cancelled.push(runId) },
        },
      })

      await host.tick(bot.id)

      // The stuck run is cancelled, its attempt fails and a fresh attempt is
      // queued while the item keeps its state.
      assert.deepEqual(cancelled, ['run-stuck'])
      assert.equal(store.findStepByIdemKey(verifyKey)?.status, 'failed')
      assert.notEqual(store.findStepByIdemKey(`${item.id}:1:verify:2`), undefined)
      assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'watchdog.task_stuck').length, 1)
      assert.equal(store.getItem(bot.id, item.id).state, 'verifying')
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('an item past its maxItemHours budget is parked and escalated', async () => {
  const root = `${WORKSPACE}-maxhours`
  const fixture = await writeBotFixture({
    name: 'aged',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'aged', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'in_progress', project: 'alpha' })
      // Dispatched ten hours ago; the config budget is eight.
      store.patchItem(item.id, { counters: { dispatchedAtMs: Date.now() - 10 * 3_600_000 } })

      const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
      await host.tick(bot.id)

      const parked = store.getItem(bot.id, item.id)
      assert.equal(parked.state, 'parked')
      assert.equal(parked.parkedFrom, 'in_progress')
      assert.match(parked.question ?? '', /item exceeded maxItemHours \(10 h\)/)
      const log = store.listLog(bot.id, 0)
      assert.equal(log.some(entry => entry.code === 'watchdog.maxItemHours'), true)
      assert.equal(log.some(entry => entry.code === 'escalation'), true)
    })
  } finally {
    await removeFixture(fixture)
  }
})

// ── answer delivery to a bound session ─────────────────────────────────────

/** A parked `in_progress` item whose dispatch send already happened. */
function parkedWithSession(
  store: ReturnType<typeof createBotStore>,
  botId: string,
  sourceId: string,
): ReturnType<ReturnType<typeof createBotStore>['createItem']> {
  const item = store.createItem({ botId, sourceId, state: 'parked', project: 'alpha' })
  store.patchItem(item.id, {
    parkedFrom: 'in_progress',
    sessionId: 'session-1',
    worktreeId: 'wt-answer',
    question: 'which button?',
  })
  const dispatch = store.beginStep({ itemId: item.id, kind: 'session.send', idemKey: `${item.id}:1:session.send:1` })
  store.finishStep(dispatch.step.id, { status: 'done', output: { turn: 1 } })
  return store.getItem(botId, item.id)
}

/** The pre-answer ledger: one finished turn whose reply leaves the item blocked. */
function blockedLedger(at: string): ReturnType<BotTestSession['readLedger']> {
  return [
    { seq: 1, at, type: 'turn.started', turn: 1, id: 't1', text: 'the dispatch brief', model: { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' } },
    { seq: 2, at, type: 'reply.sent', turn: 1, text: 'BOT-BLOCKED which button?' },
    { seq: 3, at, type: 'turn.finished', turn: 1, id: 't1', status: 'completed' },
  ]
}

test('answering a parked item delivers exactly one follow-up turn with the answer and its marker', async () => {
  const root = `${WORKSPACE}-answer`
  const fixture = await writeBotFixture({
    name: 'answerer',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'answerer', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = parkedWithSession(store, bot.id, 'source-1')

      const ledger = blockedLedger(new Date().toISOString())
      const sent: { text: string; model: unknown }[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(
          async (_sessionId, input) => { sent.push({ text: input.text, model: input.model }); return { turn: 2 } },
          () => ledger,
        ),
        log: () => {},
      })

      const resumed = await host.itemAction(bot.id, item.id, 'answer', '  use the blue button  ')
      assert.equal(resumed.state, 'in_progress')
      assert.equal(resumed.answer, 'use the blue button')
      assert.equal(resumed.counters?.answerPending, 1)
      assert.equal(resumed.counters?.answerSeq, 3)
      // The follow-up is queued durably, carrying the exact trimmed answer.
      const answerKey = `${item.id}:1:session.send:2`
      const queued = store.findStepByIdemKey(answerKey)
      assert.equal(queued?.status, 'pending')
      assert.match(String(queued?.input ?? ''), /use the blue button/)

      await host.tick(bot.id)

      // Exactly one turn, the trimmed answer verbatim, its marker, the
      // session's own model (never the bot's default).
      assert.equal(sent.length, 1)
      assert.ok((sent[0]?.text ?? '').includes('use the blue button'))
      assert.equal((sent[0]?.text ?? '').includes('  use the blue button  '), false)
      assert.ok((sent[0]?.text ?? '').includes(`[bot:${answerKey}]`))
      assert.deepEqual(sent[0]?.model, { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' })
      assert.equal(store.findStepByIdemKey(answerKey)?.status, 'done')
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'item.answered'), true)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('an answer follow-up is never delivered twice and a restart probes its marker', async () => {
  const root = `${WORKSPACE}-answer-once`
  const fixture = await writeBotFixture({
    name: 'once',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'once', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = parkedWithSession(store, bot.id, 'source-1')

      let ledger = blockedLedger(new Date().toISOString())
      let sends = 0
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(async () => { sends += 1; return { turn: 2 } }, () => ledger),
        log: () => {},
      })

      await host.itemAction(bot.id, item.id, 'answer', 'use the blue button')
      await host.tick(bot.id)
      assert.equal(sends, 1)

      // Re-entry: a later tick does not send a second turn.
      await host.tick(bot.id)
      assert.equal(sends, 1)

      // Restart: a started-but-unfinished answer send whose marker is already in
      // the ledger is proven done by the probe and never re-sent.
      const second = parkedWithSession(store, bot.id, 'source-2')
      const answerKey = `${second.id}:1:session.send:2`
      const pending = store.beginStep({ itemId: second.id, kind: 'session.send', idemKey: answerKey, input: { botAnswer: 'use the blue button' } })
      store.markStepStarted(pending.step.id)
      const at = new Date().toISOString()
      ledger = [
        ...blockedLedger(at),
        {
          seq: 4,
          at,
          type: 'turn.started',
          turn: 2,
          id: 't2',
          text: `Bot item ${second.id}: the user answered your question:\n\nuse the blue button\n\n[bot:${answerKey}]`,
          model: { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' },
        },
      ]

      await host.reconcile()

      assert.equal(sends, 1)
      assert.equal(store.findStepByIdemKey(answerKey)?.status, 'done')
      // The answer send never moves the item out of the state it parked from.
      assert.equal(store.getItem(bot.id, second.id).state, 'parked')
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('review waits for the answer turn and never parks from the pre-answer reply', async () => {
  const root = `${WORKSPACE}-answer-review`
  const fixture = await writeBotFixture({
    name: 'answerreview',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'answerreview', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = parkedWithSession(store, bot.id, 'source-1')

      let ledger = blockedLedger(new Date().toISOString())
      const started: { task: string; recentTurns: string }[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(async () => ({ turn: 2 }), () => ledger),
        projectManager: { diff: async () => '' } as unknown as ProjectManager,
        log: () => {},
        taskRunner: {
          async startTask(run) {
            const payload = run.input as { recentTurns?: unknown }
            started.push({ task: run.task, recentTurns: String(payload.recentTurns ?? '') })
            return { runId: `run-${started.length}` }
          },
          async getTask() {
            return { status: 'done' as const, output: { verdict: 'continue', reason: 'still working on it' } }
          },
        },
      })

      await host.itemAction(bot.id, item.id, 'answer', 'use the blue button')
      // The pre-answer reply still says BOT-BLOCKED, but no review may run and
      // re-park the item before the answer turn finishes.
      await host.tick(bot.id)
      await host.tick(bot.id)
      assert.equal(started.length, 0)
      assert.equal(store.getItem(bot.id, item.id).state, 'in_progress')

      // The answer turn starts and finishes; the review now sees only the
      // post-answer reply, never the pre-answer BOT-BLOCKED.
      const at = new Date().toISOString()
      const answerKey = `${item.id}:1:session.send:2`
      ledger = [
        ...blockedLedger(at),
        { seq: 4, at, type: 'turn.started', turn: 2, id: 't2', text: `answered\n\n[bot:${answerKey}]`, model: { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' } },
        { seq: 5, at, type: 'reply.sent', turn: 2, text: 'I will verify with the browser component.' },
        { seq: 6, at, type: 'turn.finished', turn: 2, id: 't2', status: 'completed' },
      ]
      await host.tick(bot.id)

      const review = started.find(entry => entry.task === 'bot-review')
      assert.notEqual(review, undefined)
      assert.match(review?.recentTurns ?? '', /verify with the browser component/)
      assert.equal((review?.recentTurns ?? '').includes('BOT-BLOCKED'), false)
      assert.equal(store.getItem(bot.id, item.id).state, 'in_progress')
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a review that raced an answer discards its pre-answer park verdict', async () => {
  const root = `${WORKSPACE}-answer-race`
  const fixture = await writeBotFixture({
    name: 'race',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'race', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'in_progress', project: 'alpha' })
      // The review sampled the ledger at seq 3; the answer arrived at seq 3, so
      // the in-flight verdict is based on the pre-answer reply.
      store.patchItem(item.id, {
        sessionId: 'session-1',
        worktreeId: 'wt-race',
        counters: { answerPending: 1, answerSeq: 3, reviewSampledSeq: 3 },
      })
      const review = store.beginStep({ itemId: item.id, kind: 'review', idemKey: `${item.id}:1:review:1` })
      store.markStepStarted(review.step.id)
      store.recordStepOutput(review.step.id, { runId: 'run-race' })

      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(async () => ({ turn: 2 }), () => []),
        log: () => {},
        taskRunner: {
          async startTask() { return { runId: 'run-race' } },
          async getTask() {
            return { status: 'done' as const, output: { verdict: 'park', reason: 'who should verify?', question: 'who should verify this?' } }
          },
        },
      })

      await host.tick(bot.id)

      const after = store.getItem(bot.id, item.id)
      assert.equal(after.state, 'in_progress')
      assert.equal(after.question, undefined)
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'review.deferred_answer'), true)
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'review_parked'), false)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('an unbound intake answer resumes the item and queues no session follow-up', async () => {
  const root = `${WORKSPACE}-answer-intake`
  const fixture = await writeBotFixture({
    name: 'intake',
    mode: 'live',
    inboxBehavior: { list: { items: [] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'intake', state: 'running', mode: 'live', configPath: fixture.configPath })
      // An intake item parked before any session was bound.
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'parked', project: 'alpha' })
      store.patchItem(item.id, { parkedFrom: 'verifying', question: 'which branch?' })

      let sends = 0
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(async () => { sends += 1; return { turn: 1 } }),
        log: () => {},
      })

      const resumed = await host.itemAction(bot.id, item.id, 'answer', 'the target is main')
      assert.equal(resumed.state, 'verifying')
      assert.equal(resumed.answer, 'the target is main')
      assert.equal(resumed.counters?.answerPending, undefined)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:session.send:1`), undefined)
      assert.equal(sends, 0)
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('an interrupted answer turn clears the barrier without a second send or judging partial replies', async () => {
  const root = `${WORKSPACE}-answer-interrupted`
  const fixture = await writeBotFixture({
    name: 'interrupted',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'interrupted', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = parkedWithSession(store, bot.id, 'source-1')

      let ledger = blockedLedger(new Date().toISOString())
      const sent: string[] = []
      const started: { task: string; recentTurns: string }[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(async (_sessionId, input) => { sent.push(input.text); return { turn: 2 } }, () => ledger),
        projectManager: { diff: async () => '' } as unknown as ProjectManager,
        log: () => {},
        taskRunner: {
          async startTask(run) {
            const payload = run.input as { recentTurns?: unknown }
            started.push({ task: run.task, recentTurns: String(payload.recentTurns ?? '') })
            return { runId: `run-${started.length}` }
          },
          async getTask() {
            return { status: 'done' as const, output: { verdict: 'continue', reason: 'keep going' } }
          },
        },
      })

      await host.itemAction(bot.id, item.id, 'answer', 'use the blue button')
      await host.tick(bot.id)

      // The answer turn starts, then the session is interrupted: the ledger writes
      // `turn.interrupted` and then the matching interrupted `turn.finished`.
      const at = new Date().toISOString()
      const answerKey = `${item.id}:1:session.send:2`
      ledger = [
        ...blockedLedger(at),
        { seq: 4, at, type: 'turn.started', turn: 2, id: 't2', text: `answered\n\n[bot:${answerKey}]`, model: { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' } },
        { seq: 5, at, type: 'reply.sent', turn: 2, text: 'partial answer before the interrupt' },
        { seq: 6, at, type: 'turn.interrupted', turn: 2, parent: 't2', reason: 'shutdown' },
        { seq: 7, at, type: 'turn.finished', turn: 2, id: 't2', status: 'interrupted' },
      ]
      await host.tick(bot.id)

      // The barrier cleared and a fresh review ran, but the answer step was never
      // sent again and the review judged neither the interrupted turn's partial
      // reply nor the pre-answer reply.
      const review = started.find(entry => entry.task === 'bot-review')
      assert.notEqual(review, undefined)
      assert.ok((review?.recentTurns ?? '').includes('ended without completing'))
      assert.equal((review?.recentTurns ?? '').includes('partial answer before the interrupt'), false)
      assert.equal((review?.recentTurns ?? '').includes('BOT-BLOCKED'), false)
      assert.equal(store.getItem(bot.id, item.id).state, 'in_progress')
      assert.equal(sent.filter(text => text.includes(`[bot:${answerKey}]`)).length, 1)
      assert.equal(store.findStepByIdemKey(`${item.id}:1:session.send:3`), undefined)
      assert.equal(store.findStepByIdemKey(answerKey)?.status, 'done')
    })
  } finally {
    await removeFixture(fixture)
  }
})

test('a delayed pre-answer reply appended after the answer turn started is never eligible', async () => {
  const root = `${WORKSPACE}-answer-delayed`
  const fixture = await writeBotFixture({
    name: 'delayed',
    mode: 'live',
    inboxBehavior: { list: { items: [{ id: 'source-1', title: 'Ship the thing' }] } },
  })
  try {
    await withConfigHome(fixture.home, async () => {
      const db = initDb(':memory:')
      const store = createBotStore({ db, workspaceRoot: root })
      const bot = store.createBot({ name: 'delayed', state: 'running', mode: 'live', configPath: fixture.configPath })
      const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'in_progress', project: 'alpha' })
      const answerKey = `${item.id}:1:session.send:2`
      store.patchItem(item.id, {
        sessionId: 'session-1',
        worktreeId: 'wt-delayed',
        counters: { answerPending: 1, answerSeq: 3 },
      })
      // The dispatch send happened first, then the answer send: its turn 2 is the
      // answer turn and completed with a plain reply.
      const dispatch = store.beginStep({ itemId: item.id, kind: 'session.send', idemKey: `${item.id}:1:session.send:1` })
      store.finishStep(dispatch.step.id, { status: 'done', output: { turn: 1 } })
      const answer = store.beginStep({ itemId: item.id, kind: 'session.send', idemKey: answerKey, input: { botAnswer: 'use the blue button' } })
      store.finishStep(answer.step.id, { status: 'done', output: { turn: 2, answer: true } })

      const at = new Date().toISOString()
      const ledger: ReturnType<BotTestSession['readLedger']> = [
        { seq: 1, at, type: 'turn.started', turn: 1, id: 't1', text: 'the dispatch brief', model: { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' } },
        { seq: 2, at, type: 'reply.sent', turn: 1, text: 'BOT-BLOCKED which button?' },
        { seq: 3, at, type: 'turn.finished', turn: 1, id: 't1', status: 'completed' },
        { seq: 4, at, type: 'turn.started', turn: 2, id: 't2', text: `answered\n\n[bot:${answerKey}]`, model: { provider: 'ledger', model: 'ledger-model', reasoningEffort: 'high' } },
        { seq: 5, at, type: 'reply.sent', turn: 2, text: 'still working on it' },
        { seq: 6, at, type: 'turn.finished', turn: 2, id: 't2', status: 'completed' },
        // A delayed reply from the pre-answer turn, appended after the answer turn
        // started: only its higher seq would make a seq-only filter admit it.
        { seq: 7, at, type: 'reply.sent', turn: 1, text: 'BOT-BLOCKED delayed old reply' },
      ]

      const sent: string[] = []
      const started: { task: string; recentTurns: string }[] = []
      const host = createBotHost({
        db,
        workspaceRoot: root,
        session: botSession(async (_sessionId, input) => { sent.push(input.text); return { turn: 3 } }, () => ledger),
        projectManager: { diff: async () => '' } as unknown as ProjectManager,
        log: () => {},
        taskRunner: {
          async startTask(run) {
            const payload = run.input as { recentTurns?: unknown }
            started.push({ task: run.task, recentTurns: String(payload.recentTurns ?? '') })
            return { runId: `run-${started.length}` }
          },
          async getTask() {
            return { status: 'done' as const, output: { verdict: 'continue', reason: 'no closing marker yet' } }
          },
        },
      })

      await host.tick(bot.id)
      // The review run is detached: its verdict is applied on the next tick.
      await host.tick(bot.id)

      // The review read only the completed answer turn's reply, and the stalled
      // nudge judged that same reply, so the delayed pre-answer reply was never
      // eligible for either.
      const review = started.find(entry => entry.task === 'bot-review')
      assert.notEqual(review, undefined)
      assert.ok((review?.recentTurns ?? '').includes('still working on it'))
      assert.equal((review?.recentTurns ?? '').includes('delayed old reply'), false)
      assert.equal((review?.recentTurns ?? '').includes('which button?'), false)
      assert.equal(store.listLog(bot.id, 0).some(entry => entry.code === 'review.nudge'), true)
      assert.equal(sent.length, 1)
      assert.ok((sent[0] ?? '').includes('ended without BOT-READY'))
    })
  } finally {
    await removeFixture(fixture)
  }
})
