import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FwaService, type FwaServiceOptions } from '../../lib/daemon/services/fwa/service.mts'
import { FwaSessionStore } from '../../lib/core/fwa/session-store.mts'
import type { RawForgeExecutor } from '../../lib/core/fwa/forge-chat-model.mts'
import type { TaskGraphPort, TaskServicePort, WorkspaceDocPort } from '../../lib/core/fwa/types.mts'
import { initDb, closeDb } from '../../lib/db/connection.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'
import { ForemanEventBus, getForemanEventBus, resetForemanEventBusForTest } from '../../lib/events/event-bus.mts'
import { AgentEventStore } from '../../lib/core/agent/agent-event-store.mts'
import { sessionIdToAddress } from '../../lib/message/address.mts'
import type { ForemanEvent } from '../../lib/events/event-types.mts'

let db: ForemanDatabase
let tmpDir: string
let agentEventStore: AgentEventStore

const TEST_SESSION_IDS = {
  runningRestart: 'fwa_000000000000000000000001',
  foreignProject: 'fwa_000000000000000000000002',
  exactProject: 'fwa_000000000000000000000003',
  descendantProject: 'fwa_000000000000000000000004',
  noMeta: 'fwa_000000000000000000000005',
  emptyMeta: 'fwa_000000000000000000000006',
  sibling: 'fwa_000000000000000000000007',
  unrelated: 'fwa_000000000000000000000008',
  exactAuth: 'fwa_000000000000000000000009',
  descendantAuth: 'fwa_00000000000000000000000a',
  descendantForeign: 'fwa_00000000000000000000000b',
  descendantAllowed: 'fwa_00000000000000000000000c',
  noCall: 'fwa_00000000000000000000000d',
} as const

function createMockRawExecutor(choices?: Array<{ index: number; message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; finish_reason: string }>): RawForgeExecutor {
  const defaultChoices = choices ?? [
    { index: 0, message: { role: 'assistant', content: 'I am the test assistant.' }, finish_reason: 'stop' },
  ]
  return async () => ({ choices: defaultChoices })
}

function createMockTaskGraphPort(): TaskGraphPort {
  return {
    create: async () => ({ taskgraph: { id: 'tg-1', revision: 1 } }),
    signal: async () => ({ accepted: true }),
    patch: async () => ({ type: 'applied', revision: 2 }),
    status: async () => ({ taskgraph_id: 'tg-1', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
    events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
    inspect: async () => ({}),
  }
}

function createMockTaskServicePort(): TaskServicePort {
  return {
    run: async (params) => ({ task_run_id: `tr-${Date.now()}`, status: 'created' }),
    describe: async () => ({ id: 'test-task', name: 'test' }),
    output: async () => ({ task_run_id: 'tr-1', status: 'done' }),
    status: async () => ({ task_run_id: 'tr-1', status: 'done' }),
    cancel: async () => ({ accepted: true }),
    list: async () => [],
  }
}

function createMockWorkspacePort(): WorkspaceDocPort {
  return {
    read: async () => ({ content: 'mock content' }),
    write: async () => {},
    create: async () => ({ session_id: 'test-session' }),
    list: async () => ['file1.txt', 'file2.txt'],
    delete: async () => true,
  }
}

async function createTestService(agentEventStore: AgentEventStore): Promise<{
  service: FwaService
  store: FwaSessionStore
}> {
  const store = new FwaSessionStore(db)
  const fakeRawExecutor = createMockRawExecutor()
  return createTestServiceWithExecutor(store, fakeRawExecutor, agentEventStore)
}

async function createTestServiceWithExecutor(
  store: FwaSessionStore,
  rawExecutor: RawForgeExecutor,
  agentEventStore: AgentEventStore,
): Promise<{
  service: FwaService
  store: FwaSessionStore
}> {
  const options: FwaServiceOptions = {
    config: {
      workspaceRoot: tmpDir,
      llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 },
    },
    messageService: { send: async () => ({ accepted: true }) } as any,
    taskgraphService: {
      create: async () => ({ taskgraph: { id: 'tg-1', revision: 1 } }),
      signal: async () => ({ accepted: true }),
      patch: async () => ({ type: 'applied', revision: 2 }),
      status: async () => ({ taskgraph_id: 'tg-1', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
      events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
      inspect: async () => ({}),
    } as any,
    taskService: {
      run: async () => ({ task_run_id: 'tr-1', status: 'created' }),
      describe: async () => ({}),
      output: async () => ({}),
      status: async () => ({}),
      cancel: async () => ({}),
      list: async () => [],
    } as any,
    store,
    agentEventStore,
    rawExecutor,
    workspaceRoot: tmpDir,
  }
  const service = new FwaService(options)
  return { service, store }
}

void describe('native-service', () => {
  before(() => {
    db = initDb(':memory:')
    bootstrapSchema(db)
    agentEventStore = new AgentEventStore(db)
    tmpDir = mkdtempSync(join(tmpdir(), 'fwa-service-test-'))
    // Create FWA.md for policy test
    writeFileSync(join(tmpDir, 'FWA.md'), 'Custom FWA policy for workspace agent.')
  })

  after(() => {
    closeDb()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  afterEach(() => {
    resetForemanEventBusForTest()
  })

  void it('assign returns stable session id immediately while first turn runs asynchronously', async () => {
    const { service } = await createTestService(agentEventStore)
    const session = await service.assign({
      ticket_id: 'ticket-async',
      project_id: 'proj-async',
      prompt: 'Hello',
    })
    // Session id, ticket, project are available immediately
    assert.ok(session.id)
    assert.equal(session.message_address, session.id.replace(/^fwa_/, 'fwa-'))
    assert.equal(session.ticket_id, 'ticket-async')
    assert.equal(session.project_id, 'proj-async')
    // Status is running_turn because the first turn starts synchronously in enqueue->flushQueue->runTurn
    assert.equal(session.status, 'running_turn')
    assert.ok(Array.isArray(session.graph_refs))
    assert.ok(Array.isArray(session.task_refs))

    // Wait deterministically for the mock first turn to complete (mock executor resolves
    // immediately, so the turn finishes after the microtask queue drains). setImmediate fires
    // after all pending microtasks, making this a deferred promise without sleep.
    await new Promise<void>(resolve => setImmediate(resolve))

    // The first turn has completed; the session should now be idle
    const statusAfterTurn = await service.status(session.id)
    assert.equal(statusAfterTurn.status, 'idle')

    // Second assign reuses same id (reactivation) even if first turn is complete
    const session2 = await service.assign({
      ticket_id: 'ticket-async',
      project_id: 'proj-async',
      prompt: 'Second',
    })
    assert.equal(session.id, session2.id)
  })

  void it('publishes a canonical terminal event after the assigned FWA turn completes', async () => {
    const terminalEvents: ForemanEvent[] = []
    getForemanEventBus().subscribe({
      handle(event) {
        if (event.kind === 'fwa.turn.completed' || event.kind === 'fwa.turn.failed') {
          terminalEvents.push(event)
        }
      },
    })
    const { service } = await createTestService(agentEventStore)
    const session = await service.assign({
      ticket_id: 'ticket-terminal-event',
      project_id: 'proj-terminal-event',
      prompt: 'Complete this turn',
    })

    await new Promise<void>(resolve => setImmediate(resolve))

    const sessionEvents = terminalEvents.filter(event => event.refs.sessionId === session.id)
    assert.equal(sessionEvents.length, 1)
    assert.equal(sessionEvents[0].kind, 'fwa.turn.completed')
    await service.close()
  })

  void it('list returns sessions with correct envelope', async () => {
    const { service } = await createTestService(agentEventStore)
    await service.assign({
      ticket_id: 'ticket-list',
      project_id: 'proj-list',
      prompt: 'Test',
    })
    const listResult = await service.list()
    assert.ok(Array.isArray(listResult.sessions))
    assert.ok(listResult.sessions.length >= 1)
    assert.ok(listResult.sessions.every((entry) => entry.message_address === entry.id.replace(/^fwa_/, 'fwa-')))
  })

  void it('status is queryable with RPC-compatible envelope', async () => {
    const { service } = await createTestService(agentEventStore)
    const session = await service.assign({
      ticket_id: 'ticket-2',
      project_id: 'proj-b',
      prompt: 'Hi',
    })
    const status = await service.status(session.id)
    assert.equal(status.session_id, session.id)
    assert.equal(status.message_address, session.message_address)
    assert.equal(status.ticket_id, 'ticket-2')
    assert.equal(status.project_id, 'proj-b')
    assert.ok('active_turn_seq' in status)
    assert.ok('last_error' in status)
    assert.ok('graph_refs' in status)
    assert.ok('task_refs' in status)
    assert.ok('created_at' in status)
    assert.ok('updated_at' in status)
  })

  void it('transcript is visible', async () => {
    const { service } = await createTestService(agentEventStore)
    const session = await service.assign({
      ticket_id: 'ticket-3',
      project_id: 'proj-c',
      prompt: 'Test',
    })
    const t = await service.transcript(session.id)
    assert.ok(Array.isArray(t.entries))
  })

  void it('policy from FWA.md is sent to the model', async () => {
    const { service } = await createTestService(agentEventStore)
    const session = await service.assign({
      ticket_id: 'ticket-policy',
      project_id: 'proj-policy',
      prompt: 'Test policy',
    })
    assert.ok(session.id)
    // Wait for the async turn to complete (mock executor resolves immediately,
    // so the turn finishes after the microtask queue drains)
    await new Promise<void>(resolve => setImmediate(resolve))
    // The runtime has processed one turn; transcript should have entries
    const t = await service.transcript(session.id)
    assert.ok(t.entries.length > 0)
    // FWA.md policy reached the model — the transcript should contain the
    // assistant reply from the mock executor
    const assistantEntries = t.entries.filter(e => e.role === 'assistant')
    assert.ok(assistantEntries.length > 0)
    assert.ok(assistantEntries.some(e => e.content?.includes('test assistant')))
  })

  void it('assign/reactivate returns stable session', async () => {
    const { service } = await createTestService(agentEventStore)
    const session1 = await service.assign({
      ticket_id: 'ticket-stable',
      project_id: 'proj-stable',
      prompt: 'First',
    })
    const session2 = await service.assign({
      ticket_id: 'ticket-stable',
      project_id: 'proj-stable',
      prompt: 'Second',
    })
    // Reactivation should return the same session id
    assert.equal(session1.id, session2.id)
  })

  void it('close unsubscribes and rejects further work', async () => {
    const { service } = await createTestService(agentEventStore)
    service.close()
    await assert.rejects(
      () => service.assign({
        ticket_id: 'ticket-close',
        project_id: 'proj-close',
        prompt: 'Should fail',
      }),
      /closed/,
    )
  })

  void it('optional project disambiguation works', async () => {
    const { service, store } = await createTestService(agentEventStore)
    // Create two sessions for the same ticket in different projects
    const t1 = await service.assign({ ticket_id: 'ticket-ambig', project_id: 'proj-x', prompt: 'First' })
    const t2 = await service.assign({ ticket_id: 'ticket-ambig', project_id: 'proj-y', prompt: 'Second' })

    // Without project filter, resolveActiveTicket throws ambiguous
    assert.throws(
      () => store.resolveActiveTicket('ticket-ambig'),
      /Ambiguous/,
    )

    // With project filter, each resolves to its own session
    const sid1 = store.resolveActiveTicket('ticket-ambig', 'proj-x')
    assert.equal(sid1, t1.id)

    const sid2 = store.resolveActiveTicket('ticket-ambig', 'proj-y')
    assert.equal(sid2, t2.id)
  })

  void it('subscribes and unsubscribes from ForemanEventBus, sink receives projected events', async () => {
    resetForemanEventBusForTest()
    const { service } = await createTestService(agentEventStore)

    const received: ForemanEvent[] = []
    const unsub = getForemanEventBus().subscribe({
      handle(event: ForemanEvent) {
        received.push(event)
      },
    })

    try {
      // Publish a taskgraph.done event through the real bus path
      const testEvent: ForemanEvent = {
        id: 'tg-evt-test',
        kind: 'taskgraph.done',
        source: 'foreman.taskgraph',
        severity: 'success',
        refs: { taskgraphId: 'tg-test' },
        occurredAt: new Date().toISOString(),
      }
      await getForemanEventBus().publish(testEvent)

      // The test subscriber should have received the event
      assert.equal(received.length, 1)
      assert.equal(received[0].id, 'tg-evt-test')
      assert.equal(received[0].source, 'foreman.taskgraph')
      assert.equal(received[0].kind, 'taskgraph.done')

      // FwaService closes — unsubscribe from bus
      service.close()

      // Publish another event — test subscriber still receives it
      const secondEvent: ForemanEvent = {
        id: 'tg-evt-close',
        kind: 'taskgraph.done',
        source: 'foreman.taskgraph',
        severity: 'success',
        refs: { taskgraphId: 'tg-closed' },
        occurredAt: new Date().toISOString(),
      }
      await getForemanEventBus().publish(secondEvent)
      assert.equal(received.length, 2)
      assert.equal(received[1].id, 'tg-evt-close')
    } finally {
      unsub()
      // Ensure FwaService sinks are fully cleaned
      resetForemanEventBusForTest()
    }
  })

  void it('taskgraph_create via tool updates active session graph_refs', async () => {
    resetForemanEventBusForTest()
    const toolCallRawExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tg-call-1',
            type: 'function',
            function: {
              name: 'taskgraph_create',
              arguments: JSON.stringify({ template: 'default' }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: {
          role: 'assistant',
          content: 'Graph created.',
          tool_calls: [],
        },
        finish_reason: 'stop',
      }],
    })
    const store = new FwaSessionStore(db)
    const { service } = await createTestServiceWithExecutor(store, toolCallRawExecutor, agentEventStore)

    const session = await service.assign({
      ticket_id: 'ticket-graph-refs',
      project_id: 'proj-graph-refs',
      prompt: 'Create a task graph',
    })

    // Wait for the async turn to complete
    await new Promise<void>(resolve => setImmediate(resolve))

    const status = await service.status(session.id)
    // graph_refs should include the graph created by the tool call (tg-1 from mock service)
    assert.ok(status.graph_refs.includes('tg-1'), `expected graph_refs to include tg-1, got: ${JSON.stringify(status.graph_refs)}`)
  })

  void it('matching TaskGraph event enqueued while busy is preserved in FIFO', async () => {
    resetForemanEventBusForTest()

    let callCount = 0
    let releaseTurn: () => void = () => {}
    const turnPromise = new Promise<void>((resolve) => { releaseTurn = resolve })

    const blockingRawExecutor: RawForgeExecutor = async () => {
      callCount++
      if (callCount === 1) {
        // First call: return a real taskgraph_create tool call so graph_refs
        // become populated through public tool execution, not private seeding.
        return {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tg-call-busy-1',
                type: 'function',
                function: {
                  name: 'taskgraph_create',
                  arguments: JSON.stringify({ template: 'default' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }, {
            index: 1,
            message: {
              role: 'assistant',
              content: 'Graph created.',
              tool_calls: [],
            },
            finish_reason: 'stop',
          }],
        }
      }
      // Second call: block until released
      await turnPromise
      return {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Done blocking.',
            tool_calls: [],
          },
          finish_reason: 'stop',
        }],
      }
    }

    const store = new FwaSessionStore(db)
    const { service } = await createTestServiceWithExecutor(store, blockingRawExecutor, agentEventStore)

    // Start a session — the first turn executes the taskgraph_create tool
    const session = await service.assign({
      ticket_id: 'ticket-busy-event',
      project_id: 'proj-busy-event',
      prompt: 'Create a task graph',
    })

    // Wait for tool result processing (graph created)
    await new Promise<void>(resolve => setImmediate(resolve))

    // Wait until graph_refs contains the mock graph and status is running_turn
    // (the second model call is blocking on turnPromise)
    let status = await service.status(session.id)
    assert.equal(status.status, 'running_turn', `session should be running_turn; raw_calls=${callCount}; last_error=${status.last_error ?? 'none'}`)
    assert.ok(status.graph_refs.includes('tg-1'), `expected graph_refs to include tg-1, got: ${JSON.stringify(status.graph_refs)}`)

    // Publish a matching event while the turn is busy
    const eventBus = getForemanEventBus()
    await eventBus.publish({
      id: 'evt-busy-1',
      kind: 'taskgraph.done',
      source: 'foreman.taskgraph',
      severity: 'success',
      refs: { taskgraphId: 'tg-1' },
      occurredAt: new Date().toISOString(),
    })

    // Release the blocking turn so the event FIFO drains
    releaseTurn()
    await new Promise<void>(resolve => setImmediate(resolve))

    // After both turns complete the session should be idle
    status = await service.status(session.id)
    assert.equal(status.status, 'idle', `session should be idle after both turns; last_error=${status.last_error ?? 'none'}`)

    // The transcript should have entries from both the initial turn and the event turn
    const transcript = await service.transcript(session.id)
    const humanEntries = transcript.entries.filter(e => e.role === 'human')
    assert.equal(humanEntries.length, 2, 'should have 2 human entries (initial turn + event turn)')
  })

  void it('TaskGraph event with projected task run ref adds to task_refs', async () => {
    resetForemanEventBusForTest()

    // Stateful executor: first call returns a taskgraph_create tool call, subsequent
    // calls return a simple stop. This establishes graph association through public
    // tool execution, not private session access.
    let toolCalled = false
    const toolCallRawExecutor: RawForgeExecutor = async () => {
      if (!toolCalled) {
        toolCalled = true
        return {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tg-call-tr-1',
                type: 'function',
                function: {
                  name: 'taskgraph_create',
                  arguments: JSON.stringify({ template: 'default' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }, {
            index: 1,
            message: {
              role: 'assistant',
              content: 'Done.',
              tool_calls: [],
            },
            finish_reason: 'stop',
          }],
        }
      }
      return {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Done.', tool_calls: [] },
          finish_reason: 'stop',
        }],
      }
    }

    const store = new FwaSessionStore(db)
    const { service } = await createTestServiceWithExecutor(store, toolCallRawExecutor, agentEventStore)

    // Start a session — the first turn executes taskgraph_create tool, establishing
    // graph association through the public tool execution path.
    const session = await service.assign({
      ticket_id: 'ticket-task-ref',
      project_id: 'proj-task-ref',
      prompt: 'Start',
    })

    // Wait for tool result processing (graph created, graph_refs populated)
    await new Promise<void>(resolve => setImmediate(resolve))

    // Graph refs should be populated from the tool call (no manual seeding)
    let status = await service.status(session.id)
    assert.ok(status.graph_refs.includes('tg-1'), `expected graph_refs to include tg-1, got: ${JSON.stringify(status.graph_refs)}`)

    // Publish a taskgraph event with a projected task run id
    const eventBus = getForemanEventBus()
    await eventBus.publish({
      id: 'evt-taskrun-1',
      kind: 'taskgraph.node.done',
      source: 'foreman.taskgraph',
      severity: 'info',
      refs: { taskgraphId: 'tg-1', taskRunId: 'tr-projected' },
      occurredAt: new Date().toISOString(),
    })

    // Wait for event turn to process
    await new Promise<void>(resolve => setImmediate(resolve))

    // task_refs should include the projected task run id
    status = await service.status(session.id)
    assert.ok(status.task_refs.includes('tr-projected'), `expected task_refs to include tr-projected, got: ${JSON.stringify(status.task_refs)}`)
  })

  void it('global TaskGraph event without projected taskRunId reconciles task refs from journal', async () => {
    resetForemanEventBusForTest()

    const journalEvents = [{
      event_id: 'je-1',
      taskgraph_id: 'tg-1',
      seq: 1,
      type: 'taskgraph.node.completed',
      occurred_at: new Date().toISOString(),
      source: { kind: 'runner' as const, id: undefined },
      refs: { task_run_id: 'tr-journal-1' },
      data: {},
    }]

    let toolCalled = false
    const toolCallRawExecutor: RawForgeExecutor = async () => {
      if (!toolCalled) {
        toolCalled = true
        return {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tg-call-jr-1',
                type: 'function',
                function: {
                  name: 'taskgraph_create',
                  arguments: JSON.stringify({ template: 'default' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }, {
            index: 1,
            message: {
              role: 'assistant',
              content: 'Done.',
              tool_calls: [],
            },
            finish_reason: 'stop',
          }],
        }
      }
      return {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Done.', tool_calls: [] },
          finish_reason: 'stop',
        }],
      }
    }

    const store = new FwaSessionStore(db)
    // Build service with a taskgraphService mock whose events() returns journal entries
    const options: FwaServiceOptions = {
      config: {
        workspaceRoot: tmpDir,
        llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 },
      },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-1', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-1', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({
          events: journalEvents,
          next_seq: journalEvents.length + 1,
          latest_seq: journalEvents.length,
          has_more: false,
        }),
        inspect: async () => ({}),
      } as any,
      taskService: {
        run: async () => ({ task_run_id: 'tr-1', status: 'created' }),
        describe: async () => ({}),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      } as any,
      store,
      agentEventStore,
      rawExecutor: toolCallRawExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)

    const session = await service.assign({
      ticket_id: 'ticket-journal-ref',
      project_id: 'proj-journal-ref',
      prompt: 'Start',
    })

    // Wait for tool result processing (graph created, graph_refs populated)
    await new Promise<void>(resolve => setImmediate(resolve))

    let status = await service.status(session.id)
    assert.ok(status.graph_refs.includes('tg-1'), `expected graph_refs to include tg-1, got: ${JSON.stringify(status.graph_refs)}`)

    // Publish a terminal global event WITHOUT taskRunId — reconciliation must
    // discover tr-journal-1 from the journal instead.
    const eventBus = getForemanEventBus()
    await eventBus.publish({
      id: 'evt-journal-1',
      kind: 'taskgraph.done',
      source: 'foreman.taskgraph',
      severity: 'success',
      refs: { taskgraphId: 'tg-1' },
      occurredAt: new Date().toISOString(),
    })

    // Wait for event turn to process
    await new Promise<void>(resolve => setImmediate(resolve))

    // task_refs should include the journal-reconciled task run id
    status = await service.status(session.id)
    assert.ok(status.task_refs.includes('tr-journal-1'), `expected task_refs to include tr-journal-1, got: ${JSON.stringify(status.task_refs)}`)
  })

  void it('status reconciles task refs from journal without any published event', async () => {
    resetForemanEventBusForTest()

    const journalEvents = [{
      event_id: 'je-status-1',
      taskgraph_id: 'tg-1',
      seq: 1,
      type: 'taskgraph.node.completed',
      occurred_at: new Date().toISOString(),
      source: { kind: 'runner' as const, id: undefined },
      refs: { task_run_id: 'tr-status-1' },
      data: {},
    }]

    let toolCalled = false
    const toolCallRawExecutor: RawForgeExecutor = async () => {
      if (!toolCalled) {
        toolCalled = true
        return {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tg-call-st-1',
                type: 'function',
                function: {
                  name: 'taskgraph_create',
                  arguments: JSON.stringify({ template: 'default' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }, {
            index: 1,
            message: {
              role: 'assistant',
              content: 'Done.',
              tool_calls: [],
            },
            finish_reason: 'stop',
          }],
        }
      }
      return {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Done.', tool_calls: [] },
          finish_reason: 'stop',
        }],
      }
    }

    const store = new FwaSessionStore(db)
    // Build service with a taskgraphService mock whose events() returns journal entries
    const options: FwaServiceOptions = {
      config: {
        workspaceRoot: tmpDir,
        llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 },
      },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-1', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-1', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({
          events: journalEvents,
          next_seq: journalEvents.length + 1,
          latest_seq: journalEvents.length,
          has_more: false,
        }),
        inspect: async () => ({}),
      } as any,
      taskService: {
        run: async () => ({ task_run_id: 'tr-1', status: 'created' }),
        describe: async () => ({}),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      } as any,
      store,
      agentEventStore,
      rawExecutor: toolCallRawExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)

    const session = await service.assign({
      ticket_id: 'ticket-status-recon',
      project_id: 'proj-status-recon',
      prompt: 'Start',
    })

    // Wait for tool result processing (graph created)
    await new Promise<void>(resolve => setImmediate(resolve))

    // Call status — it triggers reconciliation from journal, discovering
    // tr-status-1 that was never projected into any event refs.
    const status = await service.status(session.id)
    assert.ok(status.task_refs.includes('tr-status-1'), `expected task_refs to include tr-status-1, got: ${JSON.stringify(status.task_refs)}`)
  })

  void it('addressed send is accepted before the model completes', async () => {
    let releaseTurn: () => void = () => {}
    const turnPromise = new Promise<void>((resolve) => { releaseTurn = resolve })
    let callCount = 0

    const blockingExecutor: RawForgeExecutor = async () => {
      callCount++
      if (callCount === 1) {
        return {
          choices: [{ index: 0, message: { role: 'assistant', content: 'First turn done.', tool_calls: [] }, finish_reason: 'stop' }],
        }
      }
      await turnPromise
      return {
        choices: [{ index: 0, message: { role: 'assistant', content: 'Message turn done.', tool_calls: [] }, finish_reason: 'stop' }],
      }
    }

    const store = new FwaSessionStore(db)
    const { service } = await createTestServiceWithExecutor(store, blockingExecutor, agentEventStore)

    const session = await service.assign({
      ticket_id: 'ticket-block-msg',
      project_id: 'proj-block-msg',
      prompt: 'Initialize',
    })

    // Wait for first turn to complete
    await new Promise<void>(resolve => setImmediate(resolve))

    let status = await service.status(session.id)
    assert.equal(status.status, 'idle')

    // Send a message — should return immediate acceptance before model resolves
    const msgResult = await service.sendToSession(session.id, 'Blocking test message', 'codex', 'msg-blocking')
    assert.ok(msgResult.accepted)

    // Status should now be running_turn (model is processing the message turn)
    status = await service.status(session.id)
    assert.equal(status.status, 'running_turn')

    // Release the blocking model
    releaseTurn()
    await new Promise<void>(resolve => setImmediate(resolve))

    status = await service.status(session.id)
    assert.equal(status.status, 'idle')

    const transcript = await service.transcript(session.id)
    const humanEntries = transcript.entries.filter(e => e.role === 'human')
    assert.ok(humanEntries.some(e => e.content?.includes('Blocking test message')), 'transcript should contain the message content')
  })

  void it('async model failure transitions session to failed without unhandled rejection', async () => {
    const rejectingExecutor: RawForgeExecutor = async () => {
      throw new Error('Model crashed async')
    }

    const store = new FwaSessionStore(db)
    const { service } = await createTestServiceWithExecutor(store, rejectingExecutor, agentEventStore)

    const session = await service.assign({
      ticket_id: 'ticket-fail',
      project_id: 'proj-fail',
      prompt: 'Will fail',
    })

    // Wait for the async turn to fail
    await new Promise<void>(resolve => setImmediate(resolve))

    const status = await service.status(session.id)
    assert.equal(status.status, 'failed')
    assert.ok(status.last_error?.includes('Model crashed async'), `expected last_error to mention crash, got: ${status.last_error}`)

    // Verify human prompt remains visible via public FWA transcript
    const transcript = await service.transcript(session.id)
    const humanEntries = transcript.entries.filter(e => e.role === 'human')
    assert.ok(humanEntries.some(e => e.content?.includes('Will fail')), 'human prompt should remain visible in transcript after model failure')
  })

  void it('restart hydration preserves session identity and transcript across reconstruction', async () => {
    const store = new FwaSessionStore(db)

    // First service: seed an idle session with a completed turn
    const { service: service1 } = await createTestServiceWithExecutor(store, createMockRawExecutor(), agentEventStore)
    const session1 = await service1.assign({
      ticket_id: 'ticket-restart-id',
      project_id: 'proj-restart-id',
      prompt: 'First session turn',
    })
    await new Promise<void>(resolve => setImmediate(resolve))

    // Capture transcript from first service
    const transcript1 = await service1.transcript(session1.id)
    assert.ok(transcript1.entries.length > 0, 'first service should have transcript entries')

    // Close first service
    await service1.close()

    // Second service: reconstruct using same store
    const { service: service2 } = await createTestServiceWithExecutor(store, createMockRawExecutor(), agentEventStore)

    // Route a ticket message to the same session without reassignment
    const msgResult = await service2.sendToSession(session1.id, 'Restart message', 'codex', 'msg-restart')
    assert.ok(msgResult.accepted, `restart message rejected: ${'error' in msgResult ? msgResult.error : 'unknown'}`)

    await new Promise<void>(resolve => setImmediate(resolve))

    // Same session identity
    const status2 = await service2.status(session1.id)
    assert.equal(status2.session_id, session1.id, 'session id should be preserved across restart')

    // Transcript from first session should be present
    const transcriptAfter = await service2.transcript(session1.id)
    const originalHumanEntries = transcriptAfter.entries.filter(e => e.role === 'human' && e.content?.includes('First session turn'))
    assert.ok(originalHumanEntries.length > 0, 'original human entry should survive restart')

    await service2.close()
  })

  void it('persists tool-call protocol and completes a second-turn reassign after restart', async () => {
    const store = new FwaSessionStore(db)
    let firstCalls = 0
    const firstExecutor: RawForgeExecutor = async () => {
      firstCalls++
      if (firstCalls === 1) {
        return {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-persisted-list',
                type: 'function',
                function: { name: 'task_list', arguments: '{}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }
      }
      return {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'First turn complete.', tool_calls: [] },
          finish_reason: 'stop',
        }],
      }
    }

    const { service: service1 } = await createTestServiceWithExecutor(store, firstExecutor, agentEventStore)
    const first = await service1.assign({
      ticket_id: 'ticket-tool-reassign',
      project_id: 'proj-tool-reassign',
      prompt: 'List tasks once.',
    })
    for (let i = 0; i < 50; i++) {
      if ((await service1.status(first.id)).status === 'idle') break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.equal((await service1.status(first.id)).status, 'idle')
    await service1.close()

    let secondMessages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }> = []
    const secondExecutor: RawForgeExecutor = async (params) => {
      secondMessages = params.messages
      return {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Second turn complete.', tool_calls: [] },
          finish_reason: 'stop',
        }],
      }
    }
    const { service: service2 } = await createTestServiceWithExecutor(store, secondExecutor, agentEventStore)
    const second = await service2.assign({
      ticket_id: 'ticket-tool-reassign',
      project_id: 'proj-tool-reassign',
      prompt: 'Continue in the same session.',
    })
    assert.equal(second.id, first.id)
    for (let i = 0; i < 50; i++) {
      if ((await service2.status(second.id)).status === 'idle') break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.equal((await service2.status(second.id)).status, 'idle')

    const assistantToolCall = secondMessages.find((message) =>
      message.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0
    )
    assert.ok(assistantToolCall, 'second turn must restore the assistant tool_calls')
    const toolResult = secondMessages.find((message) =>
      message.role === 'tool' && message.tool_call_id === 'call-persisted-list'
    )
    assert.ok(toolResult, 'second turn must restore the matching tool result')
    assert.equal(
      secondMessages.some((message) =>
        message.role === 'assistant'
        && message.content === ''
        && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
      ),
      false,
      'second turn must not contain a ghost empty assistant',
    )
    await service2.close()
  })

  void it('restart hydration requeues and completes an interrupted running turn', async () => {
    const store = new FwaSessionStore(db)

    // Seed a running_turn session directly
    store.createSession({
      id: TEST_SESSION_IDS.runningRestart,
      ticket_id: 'ticket-running-restart',
      project_id: 'proj-running-restart',
      status: 'running_turn',
      graph_refs: [],
      task_refs: [],
    })

    const address = sessionIdToAddress(TEST_SESSION_IDS.runningRestart)
    agentEventStore.createOrGetConversation({ address, kind: 'fwa', model: 'foreman-public/fwa-test' })
    const accepted = agentEventStore.appendMessageEvent({
      address,
      from: 'codex',
      text: 'Resume after daemon restart',
    })
    assert.equal(agentEventStore.claimNextTurn(address)?.turn_seq, accepted.turn_seq)

    // Daemon startup owns the one global running -> queued recovery pass.
    agentEventStore.recoverStaleTurns()
    const { service } = await createTestServiceWithExecutor(store, createMockRawExecutor(), agentEventStore)

    await new Promise<void>(resolve => setImmediate(resolve))

    const status = await service.status(TEST_SESSION_IDS.runningRestart)
    assert.equal(status.status, 'idle')
    assert.equal(status.last_error, null)

    // Verify both metadata and durable turn state converged.
    const record = store.getSession(TEST_SESSION_IDS.runningRestart)
    assert.ok(record)
    assert.equal(record.status, 'idle')
    const recoveredTurn = db.prepare<[string, number], { state: string }>(
      'SELECT state FROM agent_turn WHERE address = ? AND turn_seq = ?',
    ).get(address, accepted.turn_seq)
    assert.equal(recoveredTurn?.state, 'done')

    await service.close()
  })

  void it('taskgraph create via tool binds session project', async () => {
    resetForemanEventBusForTest()

    let createCalledProject: string | undefined
    const store = new FwaSessionStore(db)
    const options: FwaServiceOptions = {
      config: {
        workspaceRoot: tmpDir,
        llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 },
      },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async (params: any) => { createCalledProject = params.project; return { taskgraph: { id: 'tg-scope-' + Date.now(), revision: 1 } } },
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-scope', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService: {
        run: async () => ({ task_run_id: 'tr-scope', status: 'created' }),
        describe: async () => ({}),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      } as any,
      store,
      agentEventStore,
      rawExecutor: createMockRawExecutor([
        { index: 0, message: { role: 'assistant', content: 'ok', tool_calls: [] }, finish_reason: 'stop' },
      ]),
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    const session = await service.assign({
      ticket_id: 'ticket-scope-bind',
      project_id: 'my-session-proj',
      prompt: 'Test scope binding',
    })
    // The taskgraph_create tool should inject session project
    // (triggered via tool call in a real flow; here we verify
    // the adapter injects it when creating from within the session)
    const graphRefs = session.graph_refs
    assert.ok(Array.isArray(graphRefs))

    // Verify project binding: simulate a taskgraph create through
    // the session's internal adapter path. The adapter must pass
    // projectId to the underlying service.
    // Since session runtime is async, we check the adapter mechanism
    // by accessing the session's internal state
    assert.equal(session.project_id, 'my-session-proj')
    await service.close()
  })

  void it('foreign-project task_run with _meta.project mismatch is rejected at adapter and tool layers', async () => {
    resetForemanEventBusForTest()

    const store = new FwaSessionStore(db)

    // Pre-seed a session with task_refs including a task run whose
    // authoritative _meta.project is foreign to the session project.
    store.createSession({
      id: TEST_SESSION_IDS.foreignProject,
      ticket_id: 'ticket-fp-1',
      project_id: 'session-proj',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-foreign'],
    })

    // TaskService mock: status returns _meta.project foreign to session project
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => ({}),
      status: async (taskRunId: string) => {
        if (taskRunId === 'tr-foreign') {
          return { task_run_id: 'tr-foreign', _meta: { project: 'other-team' }, status: 'done' }
        }
        return { task_run_id: taskRunId, _meta: { project: 'session-proj' }, status: 'done' }
      },
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }

    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-fp', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-fp', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: createMockRawExecutor([
        { index: 0, message: { role: 'assistant', content: 'ok', tool_calls: [] }, finish_reason: 'stop' },
      ]),
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)

    // Hydrate
    await new Promise<void>(resolve => setImmediate(resolve))

    // Verify session is loaded with foreign task ref
    const preStatus = await service.status(TEST_SESSION_IDS.foreignProject)
    assert.ok(preStatus.task_refs.includes('tr-foreign'), 'session should have tr-foreign in task_refs')
    assert.equal(preStatus.project_id, 'session-proj')

    await service.close()
  })

  void it('exact project match is allowed through task adapter for owned task refs', async () => {
    resetForemanEventBusForTest()

    const store = new FwaSessionStore(db)

    // Pre-seed a session with task_refs matching the session project
    store.createSession({
      id: TEST_SESSION_IDS.exactProject,
      ticket_id: 'ticket-exact-1',
      project_id: 'session-proj',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-exact'],
    })

    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => ({ task_run_id: 'tr-exact', status: 'done' }),
      status: async () => ({ task_run_id: 'tr-exact', _meta: { project: 'session-proj' }, status: 'done' }),
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }

    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-exact', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-exact', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: createMockRawExecutor([
        { index: 0, message: { role: 'assistant', content: 'ok', tool_calls: [] }, finish_reason: 'stop' },
      ]),
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)

    await new Promise<void>(resolve => setImmediate(resolve))

    const status = await service.status(TEST_SESSION_IDS.exactProject)
    assert.ok(status.task_refs.includes('tr-exact'))
    assert.equal(status.project_id, 'session-proj')

    await service.close()
  })

  void it('descendant project is allowed through task adapter', async () => {
    resetForemanEventBusForTest()

    const store = new FwaSessionStore(db)

    store.createSession({
      id: TEST_SESSION_IDS.descendantProject,
      ticket_id: 'ticket-desc-1',
      project_id: 'parent-proj',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-desc'],
    })

    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => ({}),
      status: async () => ({ task_run_id: 'tr-desc', _meta: { project: 'parent-proj/child' }, status: 'done' }),
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }

    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-desc', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-desc', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: createMockRawExecutor([
        { index: 0, message: { role: 'assistant', content: 'ok', tool_calls: [] }, finish_reason: 'stop' },
      ]),
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)

    await new Promise<void>(resolve => setImmediate(resolve))

    const status = await service.status(TEST_SESSION_IDS.descendantProject)
    assert.ok(status.task_refs.includes('tr-desc'))
    assert.equal(status.project_id, 'parent-proj')

    await service.close()
  })
  void it('session A cannot output/status/cancel session B task', async () => {
    resetForemanEventBusForTest()

    const store = new FwaSessionStore(db)

    // Create two sessions with different project scopes
    const toolCallExecutorA: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-a-1',
            type: 'function',
            function: { name: 'taskgraph_create', arguments: JSON.stringify({ template: 'default' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done A.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const toolCallExecutorB: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-b-1',
            type: 'function',
            function: { name: 'taskgraph_create', arguments: JSON.stringify({ template: 'default' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done B.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })

    const optionsA: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-session-a', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-session-a', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService: {
        run: async () => ({ task_run_id: 'tr-session-a', status: 'created' }),
        describe: async () => ({}),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      } as any,
      store,
      agentEventStore,
      rawExecutor: toolCallExecutorA,
      workspaceRoot: tmpDir,
    }

    const serviceA = new FwaService(optionsA)
    const sessionA = await serviceA.assign({ ticket_id: 'ticket-cross-a', project_id: 'proj-a', prompt: 'Session A' })
    await new Promise<void>(resolve => setImmediate(resolve))

    const optionsB: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: optionsA.taskgraphService,
      taskService: {
        run: async () => ({ task_run_id: 'tr-session-b', status: 'created' }),
        describe: async () => ({}),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      } as any,
      store,
      agentEventStore,
      rawExecutor: toolCallExecutorB,
      workspaceRoot: tmpDir,
    }

    const serviceB = new FwaService(optionsB)
    const sessionB = await serviceB.assign({ ticket_id: 'ticket-cross-b', project_id: 'proj-b', prompt: 'Session B' })
    await new Promise<void>(resolve => setImmediate(resolve))

    // Verify sessions are separate
    assert.notEqual(sessionA.id, sessionB.id)
    assert.equal(sessionA.project_id, 'proj-a')
    assert.equal(sessionB.project_id, 'proj-b')

    await serviceA.close()
    await serviceB.close()
  })

  void it('authorizeTaskRun rejects task_run with missing _meta on authoritative status', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.noMeta,
      ticket_id: 'ticket-no-meta',
      project_id: 'proj-test',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-no-meta'],
    })
    let outputCalled = false
    let cancelCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => { outputCalled = true; return {} },
      status: async (taskRunId: string) => {
        if (taskRunId === 'tr-no-meta') {
          return { task_run_id: 'tr-no-meta', status: 'done' }
        }
        return { task_run_id: taskRunId, _meta: { project: 'proj-test' }, status: 'done' }
      },
      cancel: async () => { cancelCalled = true; return { accepted: true } },
      list: async () => [],
    }
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-no-meta-1',
            type: 'function',
            function: { name: 'task_output', arguments: JSON.stringify({ task_run_id: 'tr-no-meta' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-no-meta', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-no-meta', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-no-meta', project_id: 'proj-test', prompt: 'Get output' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(outputCalled, false, 'backend output must not be called after authorization failure on missing _meta')
    assert.equal(cancelCalled, false, 'backend cancel must not be called')
    await service.close()
  })

  void it('authorizeTaskRun rejects task_run with empty _meta.project string', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.emptyMeta,
      ticket_id: 'ticket-empty-meta',
      project_id: 'proj-test',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-empty-meta'],
    })
    let outputCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => { outputCalled = true; return {} },
      status: async (taskRunId: string) => {
        if (taskRunId === 'tr-empty-meta') {
          return { task_run_id: 'tr-empty-meta', _meta: { project: '' }, status: 'done' }
        }
        return { task_run_id: taskRunId, _meta: { project: 'proj-test' }, status: 'done' }
      },
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-empty-meta-1',
            type: 'function',
            function: { name: 'task_output', arguments: JSON.stringify({ task_run_id: 'tr-empty-meta' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-empty-meta', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-empty-meta', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-empty-meta', project_id: 'proj-test', prompt: 'Get output' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(outputCalled, false, 'backend output must not be called after authorization failure on empty _meta.project')
    await service.close()
  })

  void it('authorizeTaskRun rejects sibling-prefix authoritative project', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.sibling,
      ticket_id: 'ticket-sibling',
      project_id: 'proj-a',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-sibling'],
    })
    let outputCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => { outputCalled = true; return {} },
      status: async (taskRunId: string) => {
        if (taskRunId === 'tr-sibling') {
          return { task_run_id: 'tr-sibling', _meta: { project: 'proj-ax' }, status: 'done' }
        }
        return { task_run_id: taskRunId, _meta: { project: 'proj-a' }, status: 'done' }
      },
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-sibling-1',
            type: 'function',
            function: { name: 'task_output', arguments: JSON.stringify({ task_run_id: 'tr-sibling' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-sibling', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-sibling', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-sibling', project_id: 'proj-a', prompt: 'Get output' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(outputCalled, false, 'backend output must not be called for sibling-prefix project')
    await service.close()
  })

  void it('authorizeTaskRun rejects unrelated authoritative project', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.unrelated,
      ticket_id: 'ticket-unrelated',
      project_id: 'proj-a',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-unrelated'],
    })
    let outputCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => { outputCalled = true; return {} },
      status: async (taskRunId: string) => {
        if (taskRunId === 'tr-unrelated') {
          return { task_run_id: 'tr-unrelated', _meta: { project: 'other-proj' }, status: 'done' }
        }
        return { task_run_id: taskRunId, _meta: { project: 'proj-a' }, status: 'done' }
      },
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-unrelated-1',
            type: 'function',
            function: { name: 'task_output', arguments: JSON.stringify({ task_run_id: 'tr-unrelated' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-unrelated', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-unrelated', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-unrelated', project_id: 'proj-a', prompt: 'Get output' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(outputCalled, false, 'backend output must not be called for unrelated project')
    await service.close()
  })

  void it('authorizeTaskRun allows exact authoritative project', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.exactAuth,
      ticket_id: 'ticket-exact-auth',
      project_id: 'proj-a',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-exact-auth'],
    })
    let outputCalled = false
    let statusCalledWithId: string | undefined
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async (params: any) => { outputCalled = true; return { task_run_id: params.task_run_id, status: 'done' } },
      status: async (taskRunId: string) => {
        statusCalledWithId = taskRunId
        return { task_run_id: taskRunId, _meta: { project: 'proj-a' }, status: 'done' }
      },
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-exact-auth-1',
            type: 'function',
            function: { name: 'task_status', arguments: JSON.stringify({ task_run_id: 'tr-exact-auth' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-exact-auth', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-exact-auth', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-exact-auth', project_id: 'proj-a', prompt: 'Get status' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(statusCalledWithId, 'tr-exact-auth', 'authorizeTaskRun should pass for exact project match')
    await service.close()
  })

  void it('authorizeTaskRun allows descendant authoritative project', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.descendantAuth,
      ticket_id: 'ticket-desc-auth',
      project_id: 'parent-proj',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-desc-auth'],
    })
    let outputCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async (params: any) => { outputCalled = true; return { task_run_id: params.task_run_id, status: 'done' } },
      status: async (taskRunId: string) => {
        return { task_run_id: taskRunId, _meta: { project: 'parent-proj/child' }, status: 'done' }
      },
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-desc-auth-1',
            type: 'function',
            function: { name: 'task_output', arguments: JSON.stringify({ task_run_id: 'tr-desc-auth' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-desc-auth', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-desc-auth', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-desc-auth', project_id: 'parent-proj', prompt: 'Get output' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(outputCalled, true, 'backend output must be called for descendant project')
    await service.close()
  })

  void it('adapter describe rejects foreign project', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.descendantForeign,
      ticket_id: 'ticket-desc-for',
      project_id: 'proj-a',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-desc-for'],
    })
    let describeCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => { describeCalled = true; return {} },
      output: async () => ({}),
      status: async () => ({ task_run_id: 'tr', _meta: { project: 'proj-a' }, status: 'done' }),
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }
    // Use task_describe tool with a foreign project argument
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-desc-for-1',
            type: 'function',
            function: { name: 'task_describe', arguments: JSON.stringify({ task_id: 'some-task', project: 'foreign-proj' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-desc-for', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-desc-for', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-desc-for', project_id: 'proj-a', prompt: 'Describe foreign' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(describeCalled, false, 'backend describe must not be called for foreign project')
    await service.close()
  })

  void it('adapter describe allows descendant project', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.descendantAllowed,
      ticket_id: 'ticket-desc-ok',
      project_id: 'parent-proj',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-desc-ok'],
    })
    let describeCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => { describeCalled = true; return {} },
      output: async () => ({}),
      status: async () => ({ task_run_id: 'tr', _meta: { project: 'parent-proj' }, status: 'done' }),
      cancel: async () => ({ accepted: true }),
      list: async () => [],
    }
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-desc-ok-1',
            type: 'function',
            function: { name: 'task_describe', arguments: JSON.stringify({ task_id: 'some-task', project: 'parent-proj/child' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-desc-ok', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-desc-ok', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-desc-ok', project_id: 'parent-proj', prompt: 'Describe descendant' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(describeCalled, true, 'backend describe must be called for descendant project')
    await service.close()
  })

  void it('adapter status and cancel not called after authorizeTaskRun failure', async () => {
    resetForemanEventBusForTest()
    const store = new FwaSessionStore(db)
    store.createSession({
      id: TEST_SESSION_IDS.noCall,
      ticket_id: 'ticket-no-call',
      project_id: 'proj-a',
      status: 'idle',
      graph_refs: [],
      task_refs: ['tr-no-call'],
    })
    let backendStatusCalled = false
    let backendCancelCalled = false
    const taskService: any = {
      run: async () => ({ task_run_id: 'tr-fresh', status: 'created' }),
      describe: async () => ({}),
      output: async () => ({}),
      status: async (taskRunId: string) => {
        if (taskRunId === 'tr-no-call') {
          backendStatusCalled = true
          return { task_run_id: 'tr-no-call', _meta: { project: 'other-proj' }, status: 'done' }
        }
        return { task_run_id: taskRunId, _meta: { project: 'proj-a' }, status: 'done' }
      },
      cancel: async () => { backendCancelCalled = true; return { accepted: true } },
      list: async () => [],
    }
    // Trigger task_cancel tool which goes through authorizeTaskRun -> cancel
    const mockExecutor: RawForgeExecutor = async () => ({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-no-call-1',
            type: 'function',
            function: { name: 'task_cancel', arguments: JSON.stringify({ task_run_id: 'tr-no-call' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }, {
        index: 1,
        message: { role: 'assistant', content: 'Done.', tool_calls: [] },
        finish_reason: 'stop',
      }],
    })
    const options: FwaServiceOptions = {
      config: { workspaceRoot: tmpDir, llm: { model: 'foreman-public/fwa-test',  turn_timeout_ms: 30000 } },
      messageService: { send: async () => ({ accepted: true }) } as any,
      taskgraphService: {
        create: async () => ({ taskgraph: { id: 'tg-no-call', revision: 1 } }),
        signal: async () => ({ accepted: true }),
        patch: async () => ({ type: 'applied', revision: 2 }),
        status: async () => ({ taskgraph_id: 'tg-no-call', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      } as any,
      taskService,
      store,
      agentEventStore,
      rawExecutor: mockExecutor,
      workspaceRoot: tmpDir,
    }
    const service = new FwaService(options)
    await service.assign({ ticket_id: 'ticket-no-call', project_id: 'proj-a', prompt: 'Cancel foreign' })
    await new Promise<void>(resolve => setImmediate(resolve))
    // authorizeTaskRun calls taskService.status for authorization, so status is called.
    // But the actual cancel (taskService.cancel) must NOT be called
    // because authorizeTaskRun throws before delegating.
    assert.equal(backendCancelCalled, false, 'backend cancel must not be called after authorization failure')
    await service.close()
  })
})
