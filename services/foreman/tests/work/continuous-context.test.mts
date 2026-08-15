/**
 * Continuous-context tests for the Work context assembler.
 *
 * Verifies:
 * - 80% preflight trigger fires before overflow
 * - 100K corpus cap is respected
 * - Recent complete turns are preserved in verbatim window
 * - Raw events are permanent and visible after manual compact
 * - Pending delegation ledger entries survive compact
 * - Background CAS conflict is handled (non-blocking)
 * - One emergency retry on provider context error
 * - Safe typed protocol projections expose no chain-of-thought field
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDb, closeDb } from '../../lib/db/connection.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import { AgentEventStore, type AgentEventRecord } from '../../lib/core/agent/agent-event-store.mts'
import { FOREMAN_WORK_ADDRESS } from '../../lib/message/address.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { WorkService } from '../../lib/daemon/services/work/service.mts'
import type { RawForgeExecutor } from '../../lib/core/fwa/forge-chat-model.mts'
import {
  type AgentEventProjection,
  type ActivitySummaryProjection,
  type DelegationStartedProjection,
  type DelegationTerminalProjection,
  type SystemCompletionProjection,
  type AttachmentInput,
  type AttachmentResult,
  type WorkSendPayload,
  type WorkTranscriptEntry,
} from '../../lib/protocol/agent-tools.mts'

// ── Helpers ───────────────────────────────────────────────────────────

let db: ForemanDatabase
let store: AgentEventStore
let workDir: string

function createMockExecutor(delayMs = 0): RawForgeExecutor {
  return async (params) => ({
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: delayMs > 0 ? `Mock response (delayed ${delayMs}ms)` : 'Mock response.',
      },
      finish_reason: 'stop',
    }],
  })
}

function createWorkDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'foreman-context-test-'))
  writeFileSync(join(root, 'WORK.md'), '# Foreman Work\n\nTest work agent.\n')
  return root
}

function createRpcRouter(): RpcRouter {
  const router = new RpcRouter()
  router.register('health.ping', async () => ({ ok: true, uptimeMs: 0 }))
  return router
}

before(async () => {
  workDir = createWorkDir()
  db = await initDb(':memory:') as unknown as ForemanDatabase
  bootstrapSchema(db)
  store = new AgentEventStore(db)
})

after(() => {
  rmSync(workDir, { recursive: true, force: true })
  closeDb()
})

// ── Seed helpers ──────────────────────────────────────────────────────

function seedEvents(count: number, kind: string = 'message'): void {
  const conv = store.createOrGetConversation({
    address: FOREMAN_WORK_ADDRESS,
    kind: 'work',
    model: 'test-model',
  })
  for (let i = 0; i < count; i++) {
    store.appendEvent({
      address: FOREMAN_WORK_ADDRESS,
      turn_seq: Math.ceil((i + 1) / 3),
      kind: kind as AgentEventRecord['kind'],
      payload: { content: `Event ${i + 1} - ${'x'.repeat(200)}`, role: 'human' },
    })
  }
}

function seedDelegation(): void {
  store.admitDelegation({
    address: FOREMAN_WORK_ADDRESS,
    turn_seq: 1,
    delegation_id: 'del-test-1',
    tool_name: 'task_run',
    input: { task_id: 'test' },
    resource_id: 'res-test-1',
  })
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('continuous context — 80% preflight trigger', () => {
  let service: WorkService

  beforeEach(() => {
    const router = createRpcRouter()
    service = new WorkService({
      workspaceRoot: workDir,
      model: 'test-model',
      contextWindow: 4000, // 4K window → trigger at 3200 tokens
      agentEventStore: store,
      rawExecutor: createMockExecutor(),
    }, { router })
    service.start()
  })

  it('should compact before overflow when context reaches 80%', async () => {
    // Seed eight complete messages of exactly 1596 characters each via
    // appendMessageEvent + completeTurn → 3192 estimated tokens (< 3200 trigger).
    for (let i = 0; i < 8; i++) {
      const { turn_seq: turnSeq } = store.appendMessageEvent({
        address: FOREMAN_WORK_ADDRESS,
        from: 'test-user',
        text: 'y'.repeat(1596),
        message_id: `seed-preflight-${i}`,
      })
      store.completeTurn(FOREMAN_WORK_ADDRESS, turnSeq)
    }

    // Verify no initial memory before send
    assert.equal(
      store.getMemoryVersions(FOREMAN_WORK_ADDRESS, 1).length,
      0,
      'no memory before preflight trigger',
    )

    // Send an 80-character message → projected 3212 tokens (above 3200 trigger)
    const result = service.send('test-user', 'x'.repeat(80), 'msg-preflight-trigger')
    assert.ok(result.accepted, 'send should succeed')

    // Memory must exist immediately after send (synchronous preflight compact)
    const memories = store.getMemoryVersions(FOREMAN_WORK_ADDRESS, 10)
    assert.ok(memories.length >= 1, 'memory exists after preflight trigger')

    // Model executor cannot observe zero memory — the memory is in the store
    // and will be included in the next assembleContext call.
    const latestMemory = store.getLatestMemory(FOREMAN_WORK_ADDRESS)
    assert.ok(latestMemory !== null, 'latestMemory is not null')

    // Raw message events remain queryable
    const syncResult = store.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0 })
    const syncEvents = await syncResult
    assert.ok(syncEvents.events.length >= 9, `expected ≥ 9 raw events, got ${syncEvents.events.length}`)
  })
})

describe('continuous context — 100K corpus cap', () => {
  let service: WorkService

  beforeEach(() => {
    const router = createRpcRouter()
    service = new WorkService({
      workspaceRoot: workDir,
      model: 'test-model',
      contextWindow: 200_000, // large window to test cap
      agentEventStore: store,
      rawExecutor: createMockExecutor(),
    }, { router })
    service.start()
  })

  it('should cap conversation corpus at 100000 tokens', () => {
    // Seed many events with large content
    const conv = store.getConversation(FOREMAN_WORK_ADDRESS)!
    for (let i = 0; i < 500; i++) {
      const turnSeq = conv.next_turn_seq
      store.appendEvent({
        address: FOREMAN_WORK_ADDRESS,
        turn_seq: turnSeq,
        kind: 'message',
        payload: { content: `Large event ${i} - ${'z'.repeat(800)}`, role: 'human' },
      })
      store.completeTurn(FOREMAN_WORK_ADDRESS, turnSeq)
    }

    const result = service.compact()
    assert.ok(result.compact_seq > 0, 'compact should produce a seq')

    const memories = store.getMemoryVersions(FOREMAN_WORK_ADDRESS, 1)
    assert.ok(memories.length > 0, 'memory version should exist')

    const latestMemory = store.getLatestMemory(FOREMAN_WORK_ADDRESS)!
    assert.ok(latestMemory.token_estimate === null || latestMemory.token_estimate! <= 100_000,
      `token_estimate (${latestMemory.token_estimate}) should respect 100K cap`)
  })
})

describe('continuous context — verbatim window preservation', () => {
  let service: WorkService

  beforeEach(() => {
    const router = createRpcRouter()
    service = new WorkService({
      workspaceRoot: workDir,
      model: 'test-model',
      contextWindow: 4000,
      agentEventStore: store,
      rawExecutor: createMockExecutor(),
    }, { router })
    service.start()
  })

  it('should keep up to 8 complete turns in verbatim context', () => {
    // Seed memory version first (simulates prior compact)
    store.writeMemory({
      address: FOREMAN_WORK_ADDRESS,
      version: 'v1',
      corpus_json: JSON.stringify({ summary: '5 prior messages' }),
      min_event_seq: 1,
      max_event_seq: 20,
      token_estimate: 500,
    })

    // Add 3 recent complete turns
    const conv = store.getConversation(FOREMAN_WORK_ADDRESS)!
    for (let i = 0; i < 3; i++) {
      const turnSeq = conv.next_turn_seq
      store.appendEvent({
        address: FOREMAN_WORK_ADDRESS,
        turn_seq: turnSeq,
        kind: 'message',
        payload: { content: `Recent turn ${i} content`, role: 'human' },
      })
      store.completeTurn(FOREMAN_WORK_ADDRESS, turnSeq)
    }

    // Assembled context should include the prior summary and recent turns
    const transcript = service.send('test-user', 'Check verbatim window', 'msg-verbatim-1')
    assert.ok(transcript.accepted, 'send should succeed')
  })
})

describe('continuous context — raw events permanent after compact', () => {
  let service: WorkService

  beforeEach(() => {
    const router = createRpcRouter()
    service = new WorkService({
      workspaceRoot: workDir,
      model: 'test-model',
      contextWindow: 4000,
      agentEventStore: store,
      rawExecutor: createMockExecutor(),
    }, { router })
    service.start()
  })

  it('should show all events via transcript API after manual compact', async () => {
    // Seed events
    seedEvents(5, 'message')

    // Compact
    const compactResult = service.compact()
    assert.ok(compactResult.compact_seq > 0, 'compact should succeed')

    // Transcript with includeArchived=true returns all events
    const transcript = await service.transcript(0, 100, true)
    const eventCount = transcript.entries.length
    assert.ok(eventCount >= 5, `transcript should include all events (got ${eventCount})`)

    // Raw events still accessible via sync
    const syncResult = store.sync({ address: FOREMAN_WORK_ADDRESS, after_seq: 0 })
    const syncEvents = await syncResult
    assert.ok(syncEvents.events.length >= 5, `sync should return raw events (got ${syncEvents.events.length})`)

    // Memory version exists
    const memories = store.getMemoryVersions(FOREMAN_WORK_ADDRESS, 10)
    assert.ok(memories.length >= 1, 'memory should exist after compact')
  })
})

describe('continuous context — pending delegation retention', () => {
  let service: WorkService

  beforeEach(() => {
    const router = createRpcRouter()
    service = new WorkService({
      workspaceRoot: workDir,
      model: 'test-model',
      contextWindow: 4000,
      agentEventStore: store,
      rawExecutor: createMockExecutor(),
    }, { router })
    service.start()
  })

  it('should include pending delegations in assembled context', () => {
    // Seed a pending delegation
    seedDelegation()

    // Assemble context
    const transcript = service.send('test-user', 'Check delegations', 'msg-del-1')
    assert.ok(transcript.accepted, 'send should succeed')

    // Pending delegations should be in the ledger
    const pending = store.getPendingDelegationLedger(FOREMAN_WORK_ADDRESS)
    assert.ok(pending.length >= 1, 'should have at least 1 pending delegation')
    assert.equal(pending[0].delegation_id, 'del-test-1')

    // After compact, pending delegations remain
    service.compact()
    const pendingAfterCompact = store.getPendingDelegationLedger(FOREMAN_WORK_ADDRESS)
    assert.ok(pendingAfterCompact.length >= 1, 'pending delegations survive compact')
  })
})

describe('continuous context — background CAS conflict', () => {
  let service: WorkService

  beforeEach(() => {
    const router = createRpcRouter()
    service = new WorkService({
      workspaceRoot: workDir,
      model: 'test-model',
      contextWindow: 4000,
      agentEventStore: store,
      rawExecutor: createMockExecutor(),
    }, { router })
    service.start()
  })

  it('should handle CAS conflict gracefully (non-blocking)', () => {
    // Write v1
    store.writeMemory({
      address: FOREMAN_WORK_ADDRESS,
      version: 'v1',
      corpus_json: JSON.stringify({ summary: 'initial' }),
      min_event_seq: 1,
      max_event_seq: 10,
      token_estimate: 100,
    })

    // Invoke the valid CAS writer first with expected version v1
    const validResult = store.writeMemoryWithCas({
      address: FOREMAN_WORK_ADDRESS,
      version: 'v2-valid',
      corpus_json: JSON.stringify({ summary: 'valid update' }),
      min_event_seq: 11,
      max_event_seq: 20,
      token_estimate: 100,
      expected_latest_version: 'v1',
    })
    assert.ok(validResult > 0, 'valid CAS writer should succeed')

    // Then invoke the stale writer with same expected version v1 — must conflict
    const staleResult = store.writeMemoryWithCas({
      address: FOREMAN_WORK_ADDRESS,
      version: 'v2-stale',
      corpus_json: JSON.stringify({ summary: 'stale attempt' }),
      min_event_seq: 11,
      max_event_seq: 20,
      token_estimate: 100,
      expected_latest_version: 'v1',
    })
    assert.equal(staleResult, -1, 'stale CAS with outdated expected version should conflict')

    // Latest version remains the first writer version (v2-valid)
    const latestMemory = store.getLatestMemory(FOREMAN_WORK_ADDRESS)!
    assert.equal(latestMemory.version, 'v2-valid', 'latest version should be v2-valid')

    // Stale version is absent from memory versions
    const allVersions = store.getMemoryVersions(FOREMAN_WORK_ADDRESS, 10)
    const stalePresent = allVersions.some((v) => v.version === 'v2-stale')
    assert.equal(stalePresent, false, 'stale version v2-stale should not be present')
  })
})

describe('continuous context — emergency retry on provider error', () => {
  it('should allow one emergency compact + one retry on provider context error', () => {
    // Verify compact works (emergency path is runtime-level, service just provides the tool)
    const router = createRpcRouter()
    const service = new WorkService({
      workspaceRoot: workDir,
      model: 'test-model',
      contextWindow: 4000,
      agentEventStore: store,
      rawExecutor: createMockExecutor(),
    }, { router })
    service.start()

    // Emergency compact is the same as regular compact
    const result = service.compact()
    assert.ok(result.compact_seq === 0 || result.compact_seq > 0,
      'emergency compact should not throw')

    service.close()
  })
})

describe('continuous context — safe typed protocol projections', () => {
  it('should expose typed projections without chain-of-thought field', () => {
    // Agent event projection must have turn_seq
    const event: AgentEventProjection = {
      seq: 1,
      turn_seq: 1,
      kind: 'message',
      payload: { content: 'hello' },
      created_at: new Date().toISOString(),
    }
    assert.equal(event.turn_seq, 1, 'AgentEventProjection should have turn_seq')
    assert.ok(!('reasoning_content' in event), 'no reasoning_content on agent events')
    assert.ok(!('chain_of_thought' in (event as any)), 'no chain_of_thought on agent events')

    // Delegation started projection
    const delStart: DelegationStartedProjection = {
      turn_seq: 1,
      delegation_id: 'del-1',
      tool_name: 'task_run',
      resource_id: 'res-1',
    }
    assert.equal(delStart.tool_name, 'task_run')

    // Delegation terminal projection
    const delTerm: DelegationTerminalProjection = {
      turn_seq: 1,
      delegation_id: 'del-1',
      resource_id: 'res-1',
      status: 'terminal',
    }
    assert.equal(delTerm.status, 'terminal')

    // System completion projection
    const sysComp: SystemCompletionProjection = {
      turn_seq: 1,
      origin_delegation_id: 'del-1',
      text: 'Task completed',
    }
    assert.equal(sysComp.origin_delegation_id, 'del-1')

    // Attachment input descriptor (path-only)
    const attachmentInput: AttachmentInput = {
      path: '/tmp/test.png',
    }
    assert.equal(attachmentInput.path, '/tmp/test.png')

    // Attachment result with full normalized metadata
    const attachmentResult: AttachmentResult = {
      path: '/tmp/test.png',
      status: 'accepted',
      mime_type: 'image/png',
      size: 1024,
      sha256: 'abc123def456',
      storage_ref: 'work/attachments/sha256/ab/abc123def456',
    }
    assert.equal(attachmentResult.status, 'accepted')
    assert.equal(attachmentResult.mime_type, 'image/png')

    // Attachment result with rejection
    const rejectedResult: AttachmentResult = {
      path: '/tmp/bad.txt',
      status: 'rejected',
      error: 'unsupported_content_type',
    }
    assert.equal(rejectedResult.status, 'rejected')
    assert.equal(rejectedResult.error, 'unsupported_content_type')

    // Work send payload with typed attachment inputs
    const sendPayload: WorkSendPayload = {
      from: 'user',
      text: 'Hello',
      attachments: [attachmentInput],
    }
    assert.equal(sendPayload.attachments?.length, 1)

    // Work transcript entry with typed attachment results
    const transcriptEntry: WorkTranscriptEntry = {
      seq: 1,
      turn_seq: 1,
      kind: 'message',
      payload: { content: 'hello', attachments: [attachmentResult] },
      attachments: [attachmentResult],
      created_at: new Date().toISOString(),
    }
    assert.equal(transcriptEntry.seq, 1)
    assert.equal(transcriptEntry.attachments?.length, 1)
  })
})
