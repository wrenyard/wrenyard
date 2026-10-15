import assert from 'node:assert/strict'
import { test } from 'node:test'
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
  assert.equal(log.filter(entry => entry.code === 'step.unavailable').length, 1)
  assert.equal(log.some(entry => entry.code === 'step.failed'), false)
  // The item itself is left exactly where it was.
  assert.equal(store.getItem(bot.id, item.id).state, 'completing')
  // A second reconciliation does not re-log or change anything.
  await host.reconcile()
  assert.equal(store.findStepByIdemKey(idemKey)?.status, 'unknown')
  assert.equal(store.listLog(bot.id, 0).filter(entry => entry.code === 'step.unavailable').length, 1)
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
  const item = store.createItem({ botId: bot.id, sourceId: 'source-1', state: 'accepting', project: 'alpha' })
  assert.equal(store.acquireLane({ project: 'alpha', botId: bot.id, itemId: item.id }), true)
  // The merge handler throws for an item without a worktree, so the step fails
  // while the item holds the lane.
  store.beginStep({ itemId: item.id, kind: 'merge', idemKey: `${item.id}:1:merge:1` })

  const host = createBotHost({ db, workspaceRoot: root, session: botSession(), log: () => {} })
  await host.tick(bot.id)

  const parked = store.getItem(bot.id, item.id)
  assert.equal(parked.state, 'parked')
  assert.equal(parked.parkedFrom, 'accepting')
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
