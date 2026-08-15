/**
 * WorkService concurrent fork/merge turn model tests.
 *
 * Verifies:
 * - Two concurrent branches with different mock delays append merged replies to
 *   the mainline in COMPLETION order (not submission order), each preceded by a
 *   system marker naming the answered message seq.
 * - turn_forked / turn_merged / turn_failed events carry correct payloads and
 *   running_branches reflects reality during and after execution.
 * - work.max_concurrent_turns = 1 restores exact FIFO serial behavior.
 * - A failing branch emits turn_failed and leaves the mainline consistent.
 * - agent.sync output shape stays backward compatible with running_branches added.
 */

import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import { AgentEventStore, type SyncResult } from '../../lib/core/agent/agent-event-store.mts'
import { AgentHandlerService } from '../../lib/core/agent/agent-handler-service.mts'
import { FOREMAN_WORK_ADDRESS } from '../../lib/message/address.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { WorkService } from '../../lib/daemon/services/work/service.mts'
import type { RawForgeExecutor } from '../../lib/core/fwa/forge-chat-model.mts'

// ── Helpers ───────────────────────────────────────────────────────────

function createWorkDir(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'foreman-concurrency-test-'))
  writeFileSync(join(root, 'WORK.md'), '# Foreman Work\n\nYou are the Work agent.\n')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function createRpcRouter(): RpcRouter {
  const router = new RpcRouter()
  router.register('health.ping', async () => ({ ok: true, uptimeMs: 0 }))
  return router
}

/** Mock executor that delays and responds per the last user message content. */
function delayedExecutor(
  delayByContent: Record<string, number>,
  responseByContent: Record<string, string>,
): RawForgeExecutor {
  return async (params) => {
    const userMessages = params.messages.filter((m) => m.role === 'user')
    const last = userMessages[userMessages.length - 1]
    const text = typeof last?.content === 'string' ? last.content : ''
    const delay = delayByContent[text] ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return {
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: responseByContent[text] ?? `reply: ${text}`,
        },
        finish_reason: 'stop' as const,
      }],
    }
  }
}

async function waitForEvents(
  store: AgentEventStore,
  minCount: number,
  kind: string,
  timeoutMs = 5000,
): Promise<SyncResult['events']> {
  const start = Date.now()
  for (;;) {
    const sync = await store.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0, wait_ms: 0 })
    const matches = sync.events.filter((e) => e.kind === kind)
    if (matches.length >= minCount) return sync.events
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${kind} events (got ${matches.length}/${minCount})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('WorkService concurrent fork/merge', () => {
  it('appends merged replies in completion order with a system marker naming the answered message seq', async () => {
    const db = new Database(':memory:')
    bootstrapSchema(db)
    const store = new AgentEventStore(db)
    const { root, cleanup } = createWorkDir()
    try {
      const executor = delayedExecutor(
        { slow: 120, fast: 20 },
        { slow: 'REPLY_SLOW', fast: 'REPLY_FAST' },
      )
      const ws = new WorkService(
        { workspaceRoot: root, model: 'test/model', agentEventStore: store, rawExecutor: executor, maxConcurrentTurns: 3 },
        { router: createRpcRouter() },
      )
      ws.start()

      const r1 = ws.send('operator', 'slow', 'msg-slow')
      const r2 = ws.send('operator', 'fast', 'msg-fast')
      const slowMsgSeq = r1.target_seq
      const fastMsgSeq = r2.target_seq

      const events = await waitForEvents(store, 2, 'turn_merged')
      await ws.close()

      // Mainline merged replies in COMPLETION order: fast (20ms) before slow (120ms).
      const replies = events.filter(
        (e) => e.kind === 'assistant' && (e.payload as Record<string, unknown>).branch_id === undefined,
      )
      assert.deepEqual(
        replies.map((e) => (e.payload as Record<string, unknown>).content),
        ['REPLY_FAST', 'REPLY_SLOW'],
        'mainline append order must equal completion order',
      )

      // Each merge is preceded by a system marker naming the answered message seq.
      const markers = events.filter(
        (e) => e.kind === 'message' && (e.payload as Record<string, unknown>).role === 'system',
      )
      assert.equal(markers.length, 2, 'one system marker per merged branch')
      const markerByTurn = new Map(markers.map((m) => [m.turn_seq, m.seq]))
      for (const reply of replies) {
        const markerSeq = markerByTurn.get(reply.turn_seq)
        assert.ok(markerSeq !== undefined, 'each merged reply has a preceding marker for its turn')
        assert.ok(markerSeq < reply.seq, 'marker must precede the reply on the mainline')
      }
      const markerTexts = markers.map((m) => (m.payload as Record<string, unknown>).content as string)
      for (const text of markerTexts) {
        assert.match(text, /#\d+/, 'marker names the answered message seq')
        assert.match(text, /out of order/i, 'marker states out-of-order completion')
      }
      // The fast branch (turn 2) merged first and its marker names its own message seq.
      const fastMarker = markers.find((m) => m.turn_seq === 2)!
      assert.ok(
        ((fastMarker.payload as Record<string, unknown>).content as string).includes(`#${fastMsgSeq}`),
        'fast marker names the fast message seq',
      )
      const slowMarker = markers.find((m) => m.turn_seq === 1)!
      assert.ok(
        ((slowMarker.payload as Record<string, unknown>).content as string).includes(`#${slowMsgSeq}`),
        'slow marker names the slow message seq',
      )
    } finally {
      cleanup()
    }
  })

  it('emits turn_forked/turn_merged with correct payloads and running_branches tracks reality', async () => {
    const db = new Database(':memory:')
    bootstrapSchema(db)
    const store = new AgentEventStore(db)
    const { root, cleanup } = createWorkDir()
    try {
      const executor = delayedExecutor(
        { alpha: 300, beta: 100 },
        { alpha: 'REPLY_ALPHA', beta: 'REPLY_BETA' },
      )
      const handlerService = new AgentHandlerService(store)
      const ws = new WorkService(
        { workspaceRoot: root, model: 'test/model', agentEventStore: store, rawExecutor: executor, maxConcurrentTurns: 3 },
        { router: createRpcRouter() },
      )
      ws.start()
      handlerService.setWorkPort({
        compact: () => ws.compact(),
        getStatus: () => ws.getStatus(),
        getQueueDepth: () => ws.getQueueDepth(),
        modelList: () => ws.modelList(),
        modelSet: (address: string, model: string) => ws.modelSet(address, model),
        getRunningBranches: () => ws.getRunningBranches(),
      })

      const alphaSend = ws.send('operator', 'alpha', 'msg-alpha')
      const betaSend = ws.send('operator', 'beta', 'msg-beta')
      const alphaMsgSeq = alphaSend.target_seq
      const betaMsgSeq = betaSend.target_seq

      // Both branches are forked and still running (300/100ms delays).
      const forkEvents = await waitForEvents(store, 2, 'turn_forked')
      const during = await handlerService.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0 })
      assert.equal(during.running_branches, 2, 'two branches in flight after forks')
      assert.equal(during.state, 'running')

      const forkByTurn = new Map(
        forkEvents
          .filter((e) => e.kind === 'turn_forked')
          .map((e) => [e.turn_seq, e.payload as Record<string, unknown>]),
      )
      const f1 = forkByTurn.get(1)!
      assert.equal(f1.branch_id, 'b1')
      assert.equal(f1.forked_at_seq, alphaMsgSeq, 'forked at the durable message seq of turn 1')
      assert.equal(f1.preview, 'alpha')
      const f2 = forkByTurn.get(2)!
      assert.equal(f2.branch_id, 'b2')
      assert.equal(f2.forked_at_seq, betaMsgSeq, 'forked at the durable message seq of turn 2')
      assert.equal(f2.preview, 'beta')

      // Branch-scoped events carry branch_id.
      const branchScoped = forkEvents
        .filter((e) => e.kind === 'turn_forked')
        .map((e) => e.payload as Record<string, unknown>)
      assert.ok(branchScoped.every((p) => typeof p.branch_id === 'string'))

      const mergedEvents = await waitForEvents(store, 2, 'turn_merged')
      const mergedByTurn = new Map(
        mergedEvents
          .filter((e) => e.kind === 'turn_merged')
          .map((e) => [e.turn_seq, e.payload as Record<string, unknown>]),
      )
      const m2 = mergedByTurn.get(2)!
      assert.equal(m2.branch_id, 'b2')
      assert.equal(m2.answer_to_seq, betaMsgSeq)
      assert.ok(typeof m2.merged_at_seq === 'number', 'turn_merged carries the marker event seq')
      const m1 = mergedByTurn.get(1)!
      assert.equal(m1.branch_id, 'b1')
      assert.equal(m1.answer_to_seq, alphaMsgSeq)
      assert.ok(typeof m1.merged_at_seq === 'number')

      // After both merges, no branches remain in flight.
      const after = await handlerService.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0 })
      assert.equal(after.running_branches, 0, 'running_branches drops to 0 after merges')
      assert.equal(ws.getRunningBranches(), 0)

      await ws.close()
    } finally {
      cleanup()
    }
  })

  it('restores exact FIFO serial behavior when maxConcurrentTurns = 1', async () => {
    const db = new Database(':memory:')
    bootstrapSchema(db)
    const store = new AgentEventStore(db)
    const { root, cleanup } = createWorkDir()
    try {
      const executor = delayedExecutor(
        { first: 60, second: 10 },
        { first: 'REPLY_FIRST', second: 'REPLY_SECOND' },
      )
      const ws = new WorkService(
        { workspaceRoot: root, model: 'test/model', agentEventStore: store, rawExecutor: executor, maxConcurrentTurns: 1 },
        { router: createRpcRouter() },
      )
      ws.start()

      ws.send('operator', 'first', 'msg-first')
      ws.send('operator', 'second', 'msg-second')

      // Serial: both replies appear, in submission order, with no branch markers.
      const events = await waitForEvents(store, 2, 'assistant')
      await ws.close()

      const assistants = events.filter((e) => e.kind === 'assistant')
      assert.equal(assistants.length, 2)
      assert.ok(
        assistants.every((e) => (e.payload as Record<string, unknown>).branch_id === undefined),
        'no branch_id in serial mode',
      )
      assert.deepEqual(
        assistants.map((e) => (e.payload as Record<string, unknown>).content),
        ['REPLY_FIRST', 'REPLY_SECOND'],
        'serial mode preserves submission order',
      )
      assert.equal(
        events.filter((e) => ['turn_forked', 'turn_merged', 'turn_failed'].includes(e.kind)).length,
        0,
        'no fork/merge/fail events in serial mode',
      )
      assert.equal(
        events.filter((e) => e.kind === 'message' && (e.payload as Record<string, unknown>).role === 'system').length,
        0,
        'no system markers in serial mode',
      )
      assert.equal(ws.getRunningBranches(), 0)
    } finally {
      cleanup()
    }
  })

  it('emits turn_failed with the error and keeps the mainline consistent', async () => {
    const db = new Database(':memory:')
    bootstrapSchema(db)
    const store = new AgentEventStore(db)
    const { root, cleanup } = createWorkDir()
    try {
      const failingExecutor: RawForgeExecutor = async () => {
        throw new Error('simulated branch failure')
      }
      const ws = new WorkService(
        { workspaceRoot: root, model: 'test/model', agentEventStore: store, rawExecutor: failingExecutor, maxConcurrentTurns: 3 },
        { router: createRpcRouter() },
      )
      ws.start()

      ws.send('operator', 'boom', 'msg-boom')
      const events = await waitForEvents(store, 1, 'turn_failed')
      await ws.close()

      const failed = events.find((e) => e.kind === 'turn_failed')
      assert.ok(failed, 'a turn_failed event is emitted')
      assert.equal(failed.turn_seq, 1)
      const payload = failed.payload as Record<string, unknown>
      assert.equal(payload.branch_id, 'b1')
      assert.match(payload.error as string, /simulated branch failure/)

      // Mainline stays consistent: no merge, no orphan markers/replies.
      assert.equal(events.filter((e) => e.kind === 'turn_merged').length, 0, 'no turn_merged for a failed branch')
      assert.equal(
        events.filter((e) => e.kind === 'message' && (e.payload as Record<string, unknown>).role === 'system').length,
        0,
        'no orphan system markers',
      )
      assert.equal(
        events.filter((e) => e.kind === 'assistant' && (e.payload as Record<string, unknown>).branch_id === undefined).length,
        0,
        'no orphan merged replies',
      )
      assert.equal(ws.getRunningBranches(), 0, 'running_branches clears after failure')

      // Durable turn state reflects the failure.
      const turn = store.getTurn(FOREMAN_WORK_ADDRESS, 1)
      assert.equal(turn?.state, 'failed')
      assert.match(turn?.error ?? '', /simulated branch failure/)
    } finally {
      cleanup()
    }
  })

  it('keeps agent.sync backward compatible with running_branches added', async () => {
    const db = new Database(':memory:')
    bootstrapSchema(db)
    const store = new AgentEventStore(db)
    const { root, cleanup } = createWorkDir()
    try {
      const executor = delayedExecutor({ one: 40 }, { one: 'REPLY_ONE' })
      const handlerService = new AgentHandlerService(store)
      const ws = new WorkService(
        { workspaceRoot: root, model: 'test/model', agentEventStore: store, rawExecutor: executor, maxConcurrentTurns: 3 },
        { router: createRpcRouter() },
      )
      ws.start()
      handlerService.setWorkPort({
        compact: () => ws.compact(),
        getStatus: () => ws.getStatus(),
        getQueueDepth: () => ws.getQueueDepth(),
        modelList: () => ws.modelList(),
        modelSet: (address: string, model: string) => ws.modelSet(address, model),
        getRunningBranches: () => ws.getRunningBranches(),
      })

      ws.send('operator', 'one', 'msg-one')
      await waitForEvents(store, 1, 'turn_merged')

      const result = await handlerService.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0 })
      // Existing fields unchanged.
      assert.ok(Array.isArray(result.events))
      assert.equal(typeof result.next_seq, 'number')
      assert.equal(typeof result.has_more, 'boolean')
      assert.equal(typeof result.state, 'string')
      // New top-level field.
      assert.equal(typeof result.running_branches, 'number')
      assert.equal(result.running_branches, 0)

      // Old fields remain in each event; new event kinds are just extra rows.
      for (const event of result.events) {
        assert.equal(typeof event.seq, 'number')
        assert.equal(typeof event.kind, 'string')
        assert.equal(typeof event.created_at, 'string')
      }

      await ws.close()
    } finally {
      cleanup()
    }
  })
})
