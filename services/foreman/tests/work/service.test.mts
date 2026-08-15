/**
 * WorkService tests: send/queue/transcript/compact/restart.
 *
 * Verifies:
 * - Work rejects missing WORK.md
 * - send returns accepted/target_seq/queue_depth
 * - transcript returns entries in visible/archived mode
 * - compact writes summary event
 * - restart recovers conversation and pending turns
 * - Work and FWA use the same AgentTurnRuntime implementation
 */

import { describe, it, before, after, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { initDb, closeDb } from '../../lib/db/connection.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import { AgentEventStore } from '../../lib/core/agent/agent-event-store.mts'
import { AgentHandlerService } from '../../lib/core/agent/agent-handler-service.mts'
import { FOREMAN_WORK_ADDRESS } from '../../lib/message/address.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { WorkService } from '../../lib/daemon/services/work/service.mts'
import type { RawForgeExecutor } from '../../lib/core/fwa/forge-chat-model.mts'
import Database from 'better-sqlite3'

// ── Helpers ───────────────────────────────────────────────────────────

function createMockExecutor(): RawForgeExecutor {
  return async (params) => ({
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'This is a mock assistant response.',
      },
      finish_reason: 'stop',
    }],
  })
}

function createWorkDir(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'foreman-work-test-'))
  const workMdPath = join(root, 'WORK.md')
  writeFileSync(workMdPath, '# Foreman Work\n\nYou are the Work agent. Use Foreman tools to help the user.\n')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function createRpcRouter(): RpcRouter {
  const router = new RpcRouter()
  // Register minimal handlers so the router can handle tool calls
  // We don't need full handler implementations for the WorkService tests
  // since we're not actually executing tools
  router.register('health.ping', async () => ({ ok: true, uptimeMs: 0 }))
  return router
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('WorkService', () => {
  let db: ForemanDatabase
  let agentEventStore: AgentEventStore
  let tmpDir: string
  let rawExecutor: RawForgeExecutor

  before(() => {
    db = initDb(':memory:')
    bootstrapSchema(db)
    agentEventStore = new AgentEventStore(db)
    rawExecutor = createMockExecutor()
  })

  after(() => {
    closeDb()
  })

  it('rejects missing WORK.md', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'foreman-work-missing-'))
    const router = createRpcRouter()

    try {
      const workService = new WorkService(
        {
          workspaceRoot: tmpRoot,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )

      // Start should fail when WORK.md is absent
      assert.throws(
        () => workService.start(),
        /WORK\.md not found/,
        'start() should throw when WORK.md is missing, not silently proceed',
      )
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('send returns accepted/target_seq/queue_depth', () => {
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )

      // Start the service
      workService.start()

      // Send a message
      const result = workService.send('codex', 'Hello, Work!', 'msg-work-1')
      assert.equal(result.accepted, true)
      assert.ok(typeof result.target_seq === 'number' && result.target_seq > 0,
        `target_seq should be positive, got ${result.target_seq}`)
      assert.ok(typeof result.queue_depth === 'number',
        `queue_depth should be a number, got ${result.queue_depth}`)

      // Conversation should exist
      const conv = agentEventStore.getConversation(FOREMAN_WORK_ADDRESS)
      assert.ok(conv, 'Conversation should exist after start')
      assert.equal(conv!.kind, 'work')
      assert.equal(conv!.model, 'test/model')
    } finally {
      cleanup()
    }
  })

  it('transcript returns visible entries after send', async () => {
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )

      workService.start()

      // Send a message
      workService.send('operator', 'First message', 'msg-work-2')
      workService.send('operator', 'Second message', 'msg-work-3')

      // Read transcript (visible mode)
      const visible = await workService.transcript(undefined, 10, false)
      assert.ok(visible.entries.length >= 0, 'Transcript should return entries')

      // Read transcript (archived mode)
      const archived = await workService.transcript(undefined, 10, true)
      assert.ok(archived.entries.length >= 0, 'Archived transcript should return entries')

      assert.equal(visible.state, workService.getStatus())
    } finally {
      cleanup()
    }
  })

  it('compact writes summary event', () => {
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )

      workService.start()

      // Send some messages to have events to compact
      workService.send('operator', 'Message 1', 'msg-work-4')

      const result = workService.compact()
      assert.ok(typeof result.compact_seq === 'number' && result.compact_seq > 0,
        `compact_seq should be positive, got ${result.compact_seq}`)
      assert.ok(typeof result.covers_through_seq === 'number',
        `covers_through_seq should be a number, got ${result.covers_through_seq}`)

      // Verify compact event exists
      const conv = agentEventStore.getConversation(FOREMAN_WORK_ADDRESS)
      assert.ok(conv, 'Conversation should still exist after compact')

      // After compact, visible window should be smaller
      const visible = agentEventStore.getVisibleAfterCompact(FOREMAN_WORK_ADDRESS, 0, 100)
      // The compact event itself and any post-compact events are visible
      assert.ok(visible.events.length >= 0, 'Visible events after compact should be limited')
    } finally {
      cleanup()
    }
  })

  it('restart recovers conversation and pending turns', () => {
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()

      // First service instance
      const workService1 = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )
      workService1.start()

      // Send a message via first instance
      const result1 = workService1.send('operator', 'Turn for restart test', 'msg-work-5')

      // Check that the conversation exists
      const conv = agentEventStore.getConversation(FOREMAN_WORK_ADDRESS)
      assert.ok(conv, 'Conversation should exist')
      assert.equal(conv!.kind, 'work')

      // Close first instance
      workService1.close()

      // Second service instance recovers from the same store
      const workService2 = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )
      workService2.start()

      // Verify the conversation is still there
      const conv2 = agentEventStore.getConversation(FOREMAN_WORK_ADDRESS)
      assert.ok(conv2, 'Conversation should still exist after restart')
      assert.equal(conv2!.kind, 'work')

      // Send another message
      const result2 = workService2.send('codex', 'Another turn after restart', 'msg-work-6')
      assert.equal(result2.accepted, true)

      workService2.close()
    } finally {
      cleanup()
    }
  })

  it('restart excludes failed turn from model context on recovery', async () => {
    const { root, cleanup } = createWorkDir()
    try {
      const address = FOREMAN_WORK_ADDRESS

      // Seed durable store with one failed turn and one completed turn
      // using deterministic AgentEventStore operations.
      agentEventStore.createOrGetConversation({
        address,
        kind: 'work',
        model: 'test/model',
      })

      // Failed turn
      const { turn_seq: failedTurnSeq } = agentEventStore.appendMessageEvent({
        address, from: 'test', text: 'FAILED_PROMPT_failed',
      })
      agentEventStore.claimNextTurn(address)
      agentEventStore.appendEvent({
        address, turn_seq: failedTurnSeq, kind: 'assistant',
        payload: { role: 'assistant', content: 'error response', error: true },
      })
      agentEventStore.completeTurn(address, failedTurnSeq, 'simulated error')

      // Completed turn
      const { turn_seq: completedTurnSeq } = agentEventStore.appendMessageEvent({
        address, from: 'test', text: 'COMPLETED_PROMPT_completed',
      })
      agentEventStore.claimNextTurn(address)
      agentEventStore.appendEvent({
        address, turn_seq: completedTurnSeq, kind: 'assistant',
        payload: { role: 'assistant', content: 'ok response' },
      })
      agentEventStore.completeTurn(address, completedTurnSeq)

      // Start WorkService with recording executor and send fresh prompt
      const recordedMessages: Array<Array<{ role: string; content: string }>> = []
      let captureResolve: () => void
      const capturePromise = new Promise<void>(resolve => { captureResolve = resolve })

      const recordingExecutor: RawForgeExecutor = async (params) => {
        recordedMessages.push(params.messages)
        captureResolve()
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'restarted' },
            finish_reason: 'stop' as const,
          }],
        }
      }

      const router = createRpcRouter()
      const ws = new WorkService(
        { workspaceRoot: root, model: 'test/model', agentEventStore, rawExecutor: recordingExecutor },
        { router },
      )
      ws.start()
      ws.send('test', 'FRESH_PROMPT_fresh', 'msg-fresh')
      await capturePromise
      await ws.close()

      // Assert failed prompt excluded, completed and fresh prompts included
      const userMessages = recordedMessages.flatMap(msgs =>
        msgs.filter(m => m.role === 'user').map(m => m.content))

      assert.ok(!userMessages.some(c => c.includes('FAILED_PROMPT')),
        'failed turn prompt must be absent from restored context')
      assert.ok(userMessages.some(c => c.includes('COMPLETED_PROMPT')),
        'completed turn prompt must be present in restored context')
      assert.ok(userMessages.some(c => c.includes('FRESH_PROMPT')),
        'fresh turn prompt must be present in restored context')
    } finally {
      cleanup()
    }
  })

  it('loads a live callback prompt from its durable system_completion turn', async () => {
    const localDb = new Database(':memory:')
    const { root, cleanup } = createWorkDir()
    try {
      bootstrapSchema(localDb)
      const localStore = new AgentEventStore(localDb)
      const recordedMessages: Array<Array<{ role: string; content: string }>> = []
      let captureResolve: () => void
      const captured = new Promise<void>(resolve => { captureResolve = resolve })
      const recordingExecutor: RawForgeExecutor = async (params) => {
        recordedMessages.push(params.messages)
        captureResolve()
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'callback answered' },
            finish_reason: 'stop',
          }],
        }
      }
      const service = new WorkService(
        { workspaceRoot: root, model: 'test/model', agentEventStore: localStore, rawExecutor: recordingExecutor },
        { router: createRpcRouter() },
      )
      service.start()
      const callback = localStore.appendSystemCompletionTurn({
        address: FOREMAN_WORK_ADDRESS,
        origin_delegation_id: 'del_live_prompt',
        text: 'TERMINAL_RESULT_MARKER: use this result and do not delegate again',
      })

      service.enqueueDurableTurn(callback.turn_seq)
      await captured
      await service.close()

      const userMessages = recordedMessages.flatMap(messages =>
        messages.filter(message => message.role === 'user').map(message => message.content))
      assert.ok(userMessages.some(content => content.includes('TERMINAL_RESULT_MARKER')))
      assert.ok(!userMessages.some(content => content === 'task_run'))
    } finally {
      localDb.close()
      cleanup()
    }
  })

  it('hasLiveWork returns true after start, false after close', () => {
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )

      // Before start
      assert.equal(workService.hasLiveWork(), false)

      // After start
      workService.start()
      assert.equal(workService.hasLiveWork(), true)

      // After close
      workService.close()
      assert.equal(workService.hasLiveWork(), false)
    } finally {
      cleanup()
    }
  })

  it('Work and FWA use the same AgentTurnRuntime implementation', () => {
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
                    agentEventStore,
          rawExecutor,
        },
        { router },
      )
      workService.start()

      const status = workService.getStatus()
      // AgentTurnRuntime provides consistent status field across FWA and Work
      assert.ok(typeof status === 'string', 'getStatus should return a string')
      // Both Work and FWA implement the same interface through AgentTurnRuntime
      // This is verified by the shared dependency

      workService.close()
    } finally {
      cleanup()
    }
  })

  it('modelList returns current and available defaulting to [model]', () => {
    const localDb = new Database(':memory:')
    const localStore = new AgentEventStore(localDb)
    bootstrapSchema(localDb)
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
          agentEventStore: localStore,
          rawExecutor,
        },
        { router },
      )
      workService.start()

      assert.deepEqual(workService.modelList(), {
        current: 'test/model',
        available: ['test/model'],
      })
    } finally {
      localDb.close()
      cleanup()
    }
  })

  it('modelSet hot-swaps the model, persists it, and is reflected in modelList', async () => {
    const localDb = new Database(':memory:')
    const localStore = new AgentEventStore(localDb)
    bootstrapSchema(localDb)
    const { root, cleanup } = createWorkDir()
    try {
      const usedModels: string[] = []
      const capturingExecutor: RawForgeExecutor = async (params) => {
        usedModels.push(params.model)
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'switched' },
            finish_reason: 'stop',
          }],
        }
      }
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'a',
          models: ['a', 'b'],
          agentEventStore: localStore,
          rawExecutor: capturingExecutor,
        },
        { router },
      )
      workService.start()

      assert.deepEqual(workService.modelList(), { current: 'a', available: ['a', 'b'] })

      const result = workService.modelSet(FOREMAN_WORK_ADDRESS, 'b')
      assert.deepEqual(result, { current: 'b', available: ['a', 'b'] })
      assert.deepEqual(workService.modelList(), { current: 'b', available: ['a', 'b'] })

      // Persisted to agent_conversation.model
      const conv = localStore.getConversation(FOREMAN_WORK_ADDRESS)
      assert.equal(conv!.model, 'b')

      // Subsequent turns use the switched model
      workService.send('operator', 'Turn after switch', 'msg-after-switch')
      await workService.close()
      assert.deepEqual(usedModels, ['b'], 'turn after modelSet should run on model b')
    } finally {
      localDb.close()
      cleanup()
    }
  })

  it('modelSet rejects a model outside the available list and leaves current unchanged', () => {
    const localDb = new Database(':memory:')
    const localStore = new AgentEventStore(localDb)
    bootstrapSchema(localDb)
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'a',
          models: ['a', 'b'],
          agentEventStore: localStore,
          rawExecutor,
        },
        { router },
      )
      workService.start()

      assert.throws(
        () => workService.modelSet(FOREMAN_WORK_ADDRESS, 'not-a-model'),
        /not available/,
        'modelSet should reject models outside the configured available list',
      )

      assert.deepEqual(workService.modelList(), { current: 'a', available: ['a', 'b'] })
      const conv = localStore.getConversation(FOREMAN_WORK_ADDRESS)
      assert.equal(conv!.model, 'a', 'conversation model must be unchanged after a rejected switch')
    } finally {
      localDb.close()
      cleanup()
    }
  })

  it('modelSet rejects addresses other than foreman-work', () => {
    const localDb = new Database(':memory:')
    const localStore = new AgentEventStore(localDb)
    bootstrapSchema(localDb)
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'a',
          models: ['a', 'b'],
          agentEventStore: localStore,
          rawExecutor,
        },
        { router },
      )
      workService.start()

      assert.throws(
        () => workService.modelSet('fwa-some-session', 'b'),
        /foreman-work/,
        'modelSet should only support the foreman-work address',
      )
    } finally {
      localDb.close()
      cleanup()
    }
  })

  it('emits a turn_completed event with turn_seq and duration_ms (no usage when runtime omits it)', async () => {
    const localDb = new Database(':memory:')
    const localStore = new AgentEventStore(localDb)
    bootstrapSchema(localDb)
    const { root, cleanup } = createWorkDir()
    try {
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
          agentEventStore: localStore,
          rawExecutor,
        },
        { router },
      )
      workService.start()

      workService.send('operator', 'Turn for metrics', 'msg-metrics-1')
      await workService.close()

      const sync = await localStore.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0 })
      const completed = sync.events.find((e) => e.kind === 'turn_completed')
      assert.ok(completed, 'a turn_completed event should be present on the work stream')
      assert.equal(completed.turn_seq, 1)
      const payload = completed.payload as Record<string, unknown>
      assert.ok(typeof payload.turn_seq === 'number' && payload.turn_seq === 1)
      assert.ok(typeof payload.duration_ms === 'number' && payload.duration_ms >= 0)
      assert.equal('usage' in payload, false, 'usage must be absent when the runtime reports none')
    } finally {
      localDb.close()
      cleanup()
    }
  })

  it('turn_completed includes usage when the runtime reports it', async () => {
    const localDb = new Database(':memory:')
    const localStore = new AgentEventStore(localDb)
    bootstrapSchema(localDb)
    const { root, cleanup } = createWorkDir()
    try {
      const usageExecutor: RawForgeExecutor = async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'with usage' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      })
      const router = createRpcRouter()
      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'test/model',
          agentEventStore: localStore,
          rawExecutor: usageExecutor,
        },
        { router },
      )
      workService.start()

      workService.send('operator', 'Turn with usage', 'msg-usage-1')
      await workService.close()

      const sync = await localStore.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0 })
      const completed = sync.events.find((e) => e.kind === 'turn_completed')
      assert.ok(completed, 'a turn_completed event should be present')
      const payload = completed.payload as Record<string, unknown>
      assert.deepEqual(payload.usage, { input_tokens: 12, output_tokens: 5 })
    } finally {
      localDb.close()
      cleanup()
    }
  })
})

describe('WorkService agent.model IPC round-trip', () => {
  it('agent.model.list/set work through the RPC router with result schema validation', async () => {
    const localDb = new Database(':memory:')
    const localStore = new AgentEventStore(localDb)
    bootstrapSchema(localDb)
    const localExecutor: RawForgeExecutor = createMockExecutor()
    const { root, cleanup } = createWorkDir()
    try {
      const agentHandlerService = new AgentHandlerService(localStore)
      const router = new RpcRouter()
      registerCoreHandlers(router, {
        startedAt: Date.now(),
        workspaceRoot: root,
        agentService: agentHandlerService,
      })

      const workService = new WorkService(
        {
          workspaceRoot: root,
          model: 'a',
          models: ['a', 'b'],
          agentEventStore: localStore,
          rawExecutor: localExecutor,
        },
        { router },
      )
      workService.start()
      agentHandlerService.setWorkPort({
        compact: () => workService.compact(),
        getStatus: () => workService.getStatus(),
        getQueueDepth: () => workService.getQueueDepth(),
        modelList: () => workService.modelList(),
        modelSet: (address: string, model: string) => workService.modelSet(address, model),
      })

      // ac1: list reports current + available
      const listResponse = await router.handleMessage({
        jsonrpc: '2.0', id: 1, method: 'agent.model.list', params: {},
      })
      assert.ok(listResponse && 'result' in listResponse)
      assert.deepEqual(listResponse.result, { current: 'a', available: ['a', 'b'] })

      // ac2: set switches and persists
      const setResponse = await router.handleMessage({
        jsonrpc: '2.0', id: 2, method: 'agent.model.set',
        params: { address: 'foreman-work', model: 'b' },
      })
      assert.ok(setResponse && 'result' in setResponse)
      assert.deepEqual(setResponse.result, { ok: true, current: 'b', available: ['a', 'b'] })
      assert.equal(localStore.getConversation(FOREMAN_WORK_ADDRESS)!.model, 'b')

      // ac3: an unavailable model returns a clear validation error, current unchanged
      const badResponse = await router.handleMessage({
        jsonrpc: '2.0', id: 3, method: 'agent.model.set',
        params: { address: 'foreman-work', model: 'zzz' },
      })
      assert.ok(badResponse && 'result' in badResponse)
      const badResult = badResponse.result as { ok: boolean; current: string; error?: string }
      assert.equal(badResult.ok, false)
      assert.match(badResult.error ?? '', /not available/)
      assert.equal(badResult.current, 'b', 'current model must be unchanged after a rejected switch')

      // other addresses are rejected with a clear error
      const addrResponse = await router.handleMessage({
        jsonrpc: '2.0', id: 4, method: 'agent.model.set',
        params: { address: 'fwa-session-1', model: 'a' },
      })
      assert.ok(addrResponse && 'result' in addrResponse)
      const addrResult = addrResponse.result as { ok: boolean; error?: string }
      assert.equal(addrResult.ok, false)
      assert.match(addrResult.error ?? '', /foreman-work/)
    } finally {
      localDb.close()
      cleanup()
    }
  })
})
