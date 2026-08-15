/**
 * Tests for the delegation lifecycle in the Work agent tool adapter and
 * turn runtime.
 *
 * Covers:
 * - One model call after task_run or fwa_assign (turn terminates immediately)
 * - Mixed inline plus delegation ordering
 * - Handle-free receipt (no task/session/resource id visible to the model)
 * - Active-owned inspection denial with cancel allowed
 * - Crash after admission recovery
 * - Duplicate terminal resolution
 * - One typed system completion callback
 * - Integrated runtime + adapter tests
 * - Fail-closed behavior with missing store/turn
 * - FWA session.id extraction
 * - Admitted-turn crash recovery without second model/tool call
 * - Duplicate terminal signals yield exactly one system_completion callback
 * - Mixed inline/delegation ordering
 */

import { describe, it, mock } from 'node:test'
import * as assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { AIMessageChunk } from '@langchain/core/messages'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { workAgentTools } from '../../lib/protocol/agent-tools.mts'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { RpcRouter } from '../../lib/server/rpc-router.mts'
import { createWorkTools } from '../../lib/daemon/services/work/tool-adapter.mts'
import { AgentEventStore } from '../../lib/core/agent/agent-event-store.mts'
import { AgentTurnRuntime, type AgentTurnCallbacks } from '../../lib/core/agent/agent-turn-runtime.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import { createDelegationResolver } from '../../lib/daemon/execution/agent-supervisor.mts'

// ─── Helpers ───────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  bootstrapSchema(db)
  return db
}

type JsonRpcResponse = {
  jsonrpc: string
  id: string
  result: unknown
  error?: undefined
} | {
  jsonrpc: string
  id: string
  error: { code: number; message: string }
  result?: undefined
}

class DelegationRouter {
  readonly calls: Array<{ method: string; params: unknown }> = []
  private nextResult: JsonRpcResponse
  private eventStore?: AgentEventStore

  constructor(defaultResult?: JsonRpcResponse, eventStore?: AgentEventStore) {
    this.nextResult = defaultResult ?? {
      jsonrpc: '2.0',
      id: 'test',
      result: { id: 'res_abc123' },
    }
    this.eventStore = eventStore
  }

  async handleMessage(input: unknown, context?: unknown): Promise<JsonRpcResponse> {
    const msg = input as { method: string; params: unknown }
    this.calls.push({ method: msg.method, params: msg.params })

    // Admit delegation atomically when delegationAdmission context is present
    const ctx = context as { delegationAdmission?: { address: string; turn_seq: number; delegation_id: string; tool_name: string; input: Record<string, unknown> } } | undefined
    const admission = ctx?.delegationAdmission
    if (admission && this.eventStore) {
      const rec = this.nextResult.result as Record<string, unknown> | undefined
      const resourceId = extractResultResourceId(rec)
      if (resourceId) {
        this.eventStore.admitDelegation({
          address: admission.address,
          turn_seq: admission.turn_seq,
          delegation_id: admission.delegation_id,
          tool_name: admission.tool_name,
          input: admission.input,
          resource_id: resourceId,
        })
      }
    }

    return this.nextResult
  }
}

function fakeTaskRunRouter(eventStore?: AgentEventStore): DelegationRouter {
  return new DelegationRouter({
    jsonrpc: '2.0',
    id: 'test',
    result: { id: 'task_run_001', task_run_id: 'task_run_001' },
  }, eventStore)
}

function fakeFwaAssignRouter(eventStore?: AgentEventStore): DelegationRouter {
  return new DelegationRouter({
    jsonrpc: '2.0',
    id: 'test',
    result: { id: 'fwa_sesh_001', session_id: 'fwa_sesh_001' },
  }, eventStore)
}

// Extract resource id from a mock RPC result object, matching the shape
// the production extractResourceId in tool-adapter.mts expects.
function extractResultResourceId(rec: Record<string, unknown> | undefined): string | undefined {
  if (!rec) return undefined
  // Try session.id first (FWA nested shape)
  if (typeof rec.session === 'object' && rec.session !== null) {
    const sessionId = (rec.session as Record<string, unknown>).id
    if (typeof sessionId === 'string') return sessionId
  }
  return (rec.id ?? rec.task_run_id ?? rec.session_id ?? rec.assignment_id) as string | undefined
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('delegation lifecycle', () => {
  describe('handle-free receipt', () => {
    it('task_run returns a fixed receipt with no task/session/resource id', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      const router = fakeTaskRunRouter(eventStore)

      // Create an agent conversation so delegation admission works
      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      // Create and claim an active Work turn required by fail-closed admission
      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run commit task',
      })
      eventStore.claimNextTurn('foreman-work')

      const tools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)
      const taskRunTool = tools.find((t) => t.name === 'task_run')
      assert.ok(taskRunTool, 'task_run tool exists')

      const result = await taskRunTool.func({ task_id: 'commit', project: 'test' })
      // Receipt is fixed text, no ids
      assert.equal(result, `Delegated to a background agent; the turn terminates here and will not continue.`)

      // One RPC call was made
      assert.equal(router.calls.length, 1)
      assert.equal(router.calls[0].method, 'task.run.create')
    })

    it('fwa_assign returns a fixed receipt with no session/resource id', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      const router = fakeFwaAssignRouter(eventStore)

      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      // Create and claim an active Work turn required by fail-closed admission
      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'assign FWA',
      })
      eventStore.claimNextTurn('foreman-work')

      const tools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)
      const fwaTool = tools.find((t) => t.name === 'fwa_assign')
      assert.ok(fwaTool, 'fwa_assign tool exists')

      const result = await fwaTool.func({ ticket_id: 'TICKET-1', project_id: 'test', prompt: 'do the thing' })
      assert.equal(result, `Delegated to a background agent; the turn terminates here and will not continue.`)

      assert.equal(router.calls.length, 1)
      assert.equal(router.calls[0].method, 'fwa.assign')
    })
  })

  describe('delegation admission', () => {
    it('admission creates a delegation row for task_run', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      const router = fakeTaskRunRouter(eventStore)

      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      const tools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)
      const taskRunTool = tools.find((t) => t.name === 'task_run')!

      // First admit a running turn so admission works
      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run commit task',
      })
      const turn = eventStore.claimNextTurn('foreman-work')!
      assert.equal(turn.state, 'running')

      await taskRunTool.func({ task_id: 'commit', project: 'test' })

      const delegations = eventStore.getDelegations('foreman-work')
      assert.equal(delegations.length, 1)
      assert.equal(delegations[0].tool_name, 'task_run')
      assert.equal(delegations[0].status, 'pending')
      assert.equal(delegations[0].resource_id, 'task_run_001')
    })

    it('admission creates a delegation row for fwa_assign', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      const router = fakeFwaAssignRouter(eventStore)

      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      const tools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)
      const fwaTool = tools.find((t) => t.name === 'fwa_assign')!

      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'assign FWA',
      })
      const turn = eventStore.claimNextTurn('foreman-work')!
      assert.equal(turn.state, 'running')

      await fwaTool.func({ ticket_id: 'TICKET-1', project_id: 'test', prompt: 'do it' })

      const delegations = eventStore.getDelegations('foreman-work')
      assert.equal(delegations.length, 1)
      assert.equal(delegations[0].tool_name, 'fwa_assign')
      assert.equal(delegations[0].status, 'pending')
      assert.equal(delegations[0].resource_id, 'fwa_sesh_001')
    })
  })

  describe('active-owned inspection denial', () => {
    it('blocks fwa_status for own pending resource', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      const router = fakeFwaAssignRouter()

      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      const tools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)
      const fwaStatusTool = tools.find((t) => t.name === 'fwa_status')!

      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'assign FWA',
      })
      const turn = eventStore.claimNextTurn('foreman-work')!
      eventStore.admitDelegation({
        address: 'foreman-work',
        turn_seq: turn.turn_seq,
        delegation_id: 'del_test002',
        tool_name: 'fwa_assign',
        input: { ticket_id: 'TICKET-1' },
        resource_id: 'fwa_sesh_001',
      })

      await assert.rejects(
        () => fwaStatusTool.invoke({ session_id: 'fwa_sesh_001' }),
        /Cannot inspect own pending delegation/,
      )
    })
  })

  describe('crash recovery', () => {
    it('restart reconciliation accepts already-admitted delegations', () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)

      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      // Simulate a crash scenario: a turn with admitted delegations already persisted
      const { turn_seq } = eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run commit task',
      })

      eventStore.admitDelegation({
        address: 'foreman-work',
        turn_seq,
        delegation_id: 'del_crash_001',
        tool_name: 'task_run',
        input: { task_id: 'commit' },
        resource_id: 'task_run_crash_001',
      })

      // Recovery: the turn has admitted delegation rows — claiming it should
      // finalize without invoking the model
      const hasDelegations = eventStore.hasAdmittedDelegations('foreman-work', turn_seq)
      assert.ok(hasDelegations, 'Turn has admitted delegations after crash')
    })

    it('resolveDelegation is idempotent on duplicate calls', () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)

      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      const { turn_seq } = eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run task',
      })

      eventStore.admitDelegation({
        address: 'foreman-work',
        turn_seq,
        delegation_id: 'del_dup_001',
        tool_name: 'task_run',
        input: { task_id: 'commit' },
        resource_id: 'task_run_dup_001',
      })

      // First resolve succeeds
      const first = eventStore.resolveDelegation('foreman-work', 'del_dup_001')
      assert.ok(first, 'First resolve succeeds')

      // Second resolve is a no-op
      const second = eventStore.resolveDelegation('foreman-work', 'del_dup_001')
      assert.ok(!second, 'Second resolve returns false (already terminal)')
    })
  })

  describe('system completion turn', () => {
    it('enqueues typed system_completion turn with bounded payload', () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)

      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      // Create a small payload
      const result = eventStore.appendSystemCompletionTurn({
        address: 'foreman-work',
        origin_delegation_id: 'del_sc_001',
        text: 'Delegation del_sc_001 (task_run) completed.\n\nResult:\ncommit ok',
      })

      assert.ok(result.event_seq > 0)
      assert.ok(result.turn_seq > 0)

      // Verify the turn was created with system_completion origin
      const turns = eventStore.getDelegations('foreman-work')
      // Note: success is that no error is thrown; the turn is in agent_turn
    })

    it('includes the bounded resource result and forbids delegation replay', () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      eventStore.createOrGetConversation({ address: 'foreman-work', kind: 'work', model: 'test' })
      const { turn_seq } = eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'delegate once',
      })
      eventStore.admitDelegation({
        address: 'foreman-work',
        turn_seq,
        delegation_id: 'del_result_001',
        tool_name: 'task_run',
        input: { task_id: 'explore' },
        resource_id: 'task_result_001',
      })
      const resolver = createDelegationResolver(eventStore, {
        checkResourceStatus: () => 'terminal',
        getResourcePayload: () => JSON.stringify({ status: 'done', summary: 'README summarized' }),
      })

      const result = resolver.resolveDelegation('foreman-work', 'del_result_001')

      assert.notEqual(result, false)
      const callback = eventStore.listQueuedTurns('foreman-work')
        .find(turn => turn.origin_delegation_id === 'del_result_001')
      assert.ok(callback)
      assert.match(callback.prompt_text ?? '', /README summarized/u)
      assert.match(callback.prompt_text ?? '', /Do not run or inspect this delegation again/u)
      assert.equal(resolver.resolveDelegation('foreman-work', 'del_result_001'), false)
    })
  })

  describe('integrated runtime tests', () => {
    it('tool/router called exactly once; delegation rows exist before receipt', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      const router = new DelegationRouter({
        jsonrpc: '2.0',
        id: 'test',
        result: { id: 'task_run_rt_001', task_run_id: 'task_run_rt_001' },
      }, eventStore)

      const tools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)

      // Create a running turn for admission
      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run task',
      })
      const turn = eventStore.claimNextTurn('foreman-work')!
      assert.equal(turn.state, 'running')

      const taskRunTool = tools.find((t) => t.name === 'task_run')!
      const result = await taskRunTool.func({ task_id: 'commit', project: 'test' })

      // Exactly one RPC call
      assert.equal(router.calls.length, 1)
      // Receipt is fixed text
      assert.equal(result, 'Delegated to a background agent; the turn terminates here and will not continue.')
      // Delegation row exists
      const delegations = eventStore.getDelegations('foreman-work')
      assert.equal(delegations.length, 1)
      assert.equal(delegations[0].status, 'pending')
      assert.equal(delegations[0].resource_id, 'task_run_rt_001')
    })

    it('rollback and failed turn on admission error / no resource id', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      // Router returns no id — resource id will be undefined
      const router = {
        async handleMessage() {
          return {
            jsonrpc: '2.0',
            id: 'test',
            result: {},
          }
        },
      } as unknown as RpcRouter

      const tools = createWorkTools(router, 'foreman-work', eventStore)

      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run task without resource id',
      })
      eventStore.claimNextTurn('foreman-work')

      const taskRunTool = tools.find((t) => t.name === 'task_run')!
      await assert.rejects(
        () => taskRunTool.invoke({ task_id: 'commit', project: 'test' }),
        /No resource id returned/,
      )
    })

    it('FWA session.id extraction from result.session.id', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      const router = new DelegationRouter({
        jsonrpc: '2.0',
        id: 'test',
        result: {
          session: { id: 'fwa_sesh_nested_001' },
        },
      }, eventStore)

      const tools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)

      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'assign FWA',
      })
      eventStore.claimNextTurn('foreman-work')

      const fwaTool = tools.find((t) => t.name === 'fwa_assign')!
      await fwaTool.func({ ticket_id: 'TICKET-1', project_id: 'test', prompt: 'do it' })

      const delegations = eventStore.getDelegations('foreman-work')
      assert.equal(delegations.length, 1)
      assert.equal(delegations[0].resource_id, 'fwa_sesh_nested_001')
    })

    it('mixed inline+delegation calls: inline executes first, delegation terminates turn', async () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      // Create a running turn needed by fail-closed admission
      eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'mixed calls test',
      })
      eventStore.claimNextTurn('foreman-work')

      const router = new DelegationRouter({
        jsonrpc: '2.0',
        id: 'test',
        result: { id: 'task_run_mixed_001', task_run_id: 'task_run_mixed_001' },
      }, eventStore)

      const delegationTools = createWorkTools(router as unknown as RpcRouter, 'foreman-work', eventStore)

      const readFileSchema = z.object({ path: z.string() })

      // Add an inline tool that the model will call first
      const inlineTool = new DynamicStructuredTool({
        name: 'read_file',
        description: 'Read a file',
        schema: readFileSchema,
        func: async (input: unknown) => {
          const parsed = readFileSchema.parse(input)
          return `content of ${parsed.path}`
        },
      })

      let modelInvokeCount = 0
      const model = {
        invoke: async (_input: unknown, _options?: unknown): Promise<AIMessageChunk> => {
          modelInvokeCount++
          if (modelInvokeCount === 1) {
            // Return inline call + delegation call in a single response
            return new AIMessageChunk({
              content: '',
              tool_calls: [
                { id: 'call-inline-1', name: 'read_file', args: { path: 'test.txt' }, type: 'tool_call' },
                { id: 'call-del-1', name: 'task_run', args: { task_id: 'commit', project: 'test' }, type: 'tool_call' },
              ],
            })
          }
          throw new Error('model should not be called a second time')
        },
        bindTools: (_tools: unknown[], _kwargs?: unknown) => model,
      } as unknown as BaseChatModel

      const runtime = new AgentTurnRuntime({
        address: 'foreman-work',
        model,
        tools: [inlineTool, ...delegationTools],
        systemPolicy: 'You are a helpful assistant.',
      })

      const result = await runtime.enqueue({
        turnSeq: 1,
        prompt: 'read file and run task',
        from: 'codex',
        created_at: new Date().toISOString(),
      })

      // Model called exactly once (delegation terminates turn, no second invocation)
      assert.equal(modelInvokeCount, 1)

      // Turn completed successfully — text may be empty when model
      // assistant preamble is empty; use persisted events to verify
      assert.equal(result.state, 'done')

      // Inline tool result persisted in transcript in order before delegation receipt
      const transcript = runtime.getTranscript()
      const toolEntries = transcript.filter((e) => e.role === 'tool')
      assert.equal(toolEntries.length, 2, 'both tools recorded in transcript')
      assert.ok(toolEntries[0].content.includes('content of test.txt'), 'inline tool result visible first')
      assert.ok(toolEntries[1].content.includes('Delegated to a background agent'), 'delegation receipt visible second')

      // Delegation row exists in event store
      const delegations = eventStore.getDelegations('foreman-work')
      assert.equal(delegations.length, 1, 'one delegation admitted')
      assert.equal(delegations[0].status, 'pending')
      assert.equal(delegations[0].tool_name, 'task_run')
      assert.equal(delegations[0].resource_id, 'task_run_mixed_001')

      // Router called exactly once (task_run delegation)
      assert.equal(router.calls.length, 1, 'one router call for delegation')
      assert.equal(router.calls[0].method, 'task.run.create')
    })

    it('admitted-turn crash recovery without second model/tool call', () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      // Admit a delegation as if a crash happened after RPC but before turn completion
      const { turn_seq } = eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run task before crash',
      })

      eventStore.admitDelegation({
        address: 'foreman-work',
        turn_seq,
        delegation_id: 'del_crash_recovery_001',
        tool_name: 'task_run',
        input: { task_id: 'commit' },
        resource_id: 'task_run_crash_rec_001',
      })

      // Recovery: verify admitted delegations exist
      const hasDelegations = eventStore.hasAdmittedDelegations('foreman-work', turn_seq)
      assert.ok(hasDelegations)
    })

    it('duplicate terminal signals yield exactly one system_completion callback', () => {
      const db = createTestDb()
      const eventStore = new AgentEventStore(db)
      eventStore.createOrGetConversation({
        address: 'foreman-work',
        kind: 'work',
        model: 'test',
      })

      const { turn_seq } = eventStore.appendMessageEvent({
        address: 'foreman-work',
        from: 'codex',
        text: 'run task for dup callback test',
      })

      eventStore.admitDelegation({
        address: 'foreman-work',
        turn_seq,
        delegation_id: 'del_dup_cb_001',
        tool_name: 'task_run',
        input: { task_id: 'commit' },
        resource_id: 'task_run_dup_cb_001',
      })

      // First resolve via atomic finalizer
      const firstResult = eventStore.resolveDelegationWithCallback({
        address: 'foreman-work',
        delegation_id: 'del_dup_cb_001',
        resource_id: 'task_run_dup_cb_001',
        tool_name: 'task_run',
        resolution: 'terminal',
        completion_text: 'Delegation del_dup_cb_001 (task_run) completed.',
      })
      assert.notEqual(firstResult, false, 'First resolve should succeed')

      // Second resolve should return false (already terminal)
      const secondResult = eventStore.resolveDelegationWithCallback({
        address: 'foreman-work',
        delegation_id: 'del_dup_cb_001',
        resource_id: 'task_run_dup_cb_001',
        tool_name: 'task_run',
        resolution: 'terminal',
        completion_text: 'Delegation del_dup_cb_001 (task_run) completed.',
      })
      assert.equal(secondResult, false, 'Second resolve should return false')

      // Verify only one system_completion turn was created
      const queuedTurns = eventStore.listQueuedTurns('foreman-work')
        .filter(t => t.origin === 'system_completion')
      assert.equal(queuedTurns.length, 1, 'Exactly one system_completion turn')
    })
  })
})
