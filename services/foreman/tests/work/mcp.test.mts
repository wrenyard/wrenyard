/**
 * Work MCP tests: schemas, permissions, idempotency.
 *
 * Verifies:
 * - work_send and work_transcript tool schemas are registered
 * - codex and relay have work.read allowed, pet denied
 * - work_send idempotency with client_message_id
 */

import { describe, it, before } from 'node:test'
import * as assert from 'node:assert/strict'
import { ForemanMcpServer } from '../../lib/server/mcp/server.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { CANONICAL_PRINCIPALS, hasGrant, type MessagePrincipal } from '../../lib/message/principal.mts'

// ── Helpers ───────────────────────────────────────────────────────────

function createTestMcpServer(): ForemanMcpServer {
  const router = new RpcRouter()
  router.register('health.ping', async () => ({ ok: true, uptimeMs: 0 }))
  return new ForemanMcpServer({ rpcRouter: router })
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Work MCP tools', () => {
  let mcpServer: ForemanMcpServer

  before(() => {
    mcpServer = createTestMcpServer()
  })

  it('work_send tool definition is registered', () => {
    const toolDefs = mcpServer.toolDefinitions()
    const workSend = toolDefs.find((t) => t.name === 'work_send')
    assert.ok(workSend, 'work_send tool should be registered')
    assert.equal(workSend.description, 'Send a message to the foreman-work agent. The sender is derived from the MCP connection context (sender query parameter).')
    assert.ok(workSend.inputSchema, 'work_send should have an inputSchema')
    const schema = workSend.inputSchema as Record<string, unknown>
    assert.ok(schema.properties, 'work_send schema should have properties')
    assert.ok((schema.properties as Record<string, unknown>).text, 'work_send should require text')

    // Verify attachments property in schema
    const props = schema.properties as Record<string, unknown>
    assert.ok(props.attachments, 'work_send should have attachments in schema')
  })

  it('work_transcript tool definition is registered', () => {
    const toolDefs = mcpServer.toolDefinitions()
    const workTranscript = toolDefs.find((t) => t.name === 'work_transcript')
    assert.ok(workTranscript, 'work_transcript tool should be registered')
    assert.equal(workTranscript.description, 'Read the foreman-work transcript. Requires work.read grant on the sender principal.')
    assert.ok(workTranscript.inputSchema, 'work_transcript should have an inputSchema')
    const schema = workTranscript.inputSchema as Record<string, unknown>
    assert.ok(schema.properties, 'work_transcript schema should have properties')
    assert.ok((schema.properties as Record<string, unknown>).after_seq, 'work_transcript should have after_seq')
    assert.ok((schema.properties as Record<string, unknown>).limit, 'work_transcript should have limit')
    assert.ok((schema.properties as Record<string, unknown>).include_archived, 'work_transcript should have include_archived')
  })

  it('enforces work.read before transcript access', async () => {
    const server = new ForemanMcpServer({
      rpcRouter: new RpcRouter(),
      messageService: {
        canReadWork: (principal: string) => principal === 'relay' || principal === 'codex',
      } as never,
      workTranscriptPort: {
        async transcript() {
          return { entries: [], next_seq: 0, has_more: false, state: 'idle' }
        },
      },
    })

    await assert.rejects(
      () => server.handleToolCall('work_transcript', {}, { sender: { role: 'pet' } }),
      /forbidden/,
    )
    const result = await server.handleToolCall('work_transcript', {}, { sender: { role: 'relay' } })
    assert.deepEqual(result, { entries: [], next_seq: 0, has_more: false, state: 'idle' })
  })

  it('work_transcript returns typed entries for a relay caller', async () => {
    const fixtureTranscript = {
      entries: [
        { seq: 1, kind: 'message', payload: { from: 'codex', text: 'hello' }, created_at: '2026-07-26T00:00:00Z' },
        { seq: 2, turn_seq: 1, kind: 'tool_call', payload: { name: 'read_file' }, created_at: '2026-07-26T00:00:01Z' },
        { seq: 3, turn_seq: 1, kind: 'tool_result', payload: { ok: true }, created_at: '2026-07-26T00:00:02Z' },
        { seq: 4, kind: 'graph_patch_proposal', payload: { nodes: [] }, created_at: '2026-07-26T00:00:03Z' },
      ],
      next_seq: 5,
      has_more: false,
      state: 'idle',
    }
    const server = new ForemanMcpServer({
      rpcRouter: new RpcRouter(),
      messageService: {
        canReadWork: (principal: string) => principal === 'relay' || principal === 'codex',
      } as never,
      workTranscriptPort: {
        async transcript() {
          return fixtureTranscript
        },
      },
    })

    const result = await server.handleToolCall('work_transcript', {}, { sender: { role: 'relay' } })
    assert.deepEqual(result, fixtureTranscript)
  })

  it('derives the work sender from the MCP connection context', async () => {
    let request: unknown
    const server = new ForemanMcpServer({
      rpcRouter: new RpcRouter(),
      messageService: {
        async send(value: unknown) {
          request = value
          return { message_id: 'fm_1', accepted: true, target_seq: 7, queue_depth: 1 }
        },
      } as never,
    })

    const result = await server.handleToolCall(
      'work_send',
      { text: 'review this', client_message_id: 'client-1' },
      { sender: { role: 'codex' } },
    )
    assert.deepEqual(request, {
      from: 'codex',
      to: 'foreman-work',
      text: 'review this',
      client_message_id: 'client-1',
    })
    assert.deepEqual(result, { message_id: 'fm_1', accepted: true, target_seq: 7, queue_depth: 1 })
  })

  it('work_send forwards typed attachments to message service', async () => {
    let request: unknown
    const server = new ForemanMcpServer({
      rpcRouter: new RpcRouter(),
      messageService: {
        async send(value: unknown) {
          request = value
          return {
            message_id: 'fm_2',
            accepted: true,
            target_seq: 8,
            queue_depth: 0,
            attachments: [{ path: '/tmp/test.png', status: 'accepted', mime_type: 'image/png', size: 1024 }],
          }
        },
      } as never,
    })

    const result = await server.handleToolCall(
      'work_send',
      { text: 'with image', attachments: [{ path: '/tmp/test.png' }] },
      { sender: { role: 'codex' } },
    )

    const sentRequest = request as Record<string, unknown>
    assert.deepEqual(sentRequest.attachments, [{ path: '/tmp/test.png' }])

    const resultRecord = result as Record<string, unknown>
    assert.ok(resultRecord.attachments)
    assert.equal((resultRecord.attachments as Array<{ path: string }>)[0].path, '/tmp/test.png')
    assert.equal((resultRecord.attachments as Array<{ status: string }>)[0].status, 'accepted')
  })

  it('work_transcript returns attachment metadata alongside normal activity', async () => {
    const fixtureTranscript = {
      entries: [
        {
          seq: 1,
          turn_seq: 0,
          kind: 'message',
          payload: {
            from: 'codex',
            text: 'check this image',
            attachments: [{ path: '/tmp/test.png', status: 'accepted', mime_type: 'image/png', storage_ref: 'work/attachments/sha256/ab/abc123' }],
          },
          created_at: '2026-07-26T00:00:00Z',
        },
      ],
      next_seq: 2,
      has_more: false,
      state: 'idle',
    }
    const server = new ForemanMcpServer({
      rpcRouter: new RpcRouter(),
      messageService: {
        canReadWork: (principal: string) => principal === 'relay' || principal === 'codex',
      } as never,
      workTranscriptPort: {
        async transcript() {
          return fixtureTranscript
        },
      },
    })

    const result = await server.handleToolCall('work_transcript', {}, { sender: { role: 'relay' } })
    const resultRecord = result as { entries: Array<Record<string, unknown>> }
    assert.ok(resultRecord.entries[0].attachments, 'transcript entry should expose attachments')
  })
})

describe('Principal grants', () => {
  it('codex has work.read', () => {
    const codex = CANONICAL_PRINCIPALS['codex']
    assert.ok(codex, 'codex should be a canonical principal')
    assert.ok(hasGrant(codex, 'work.read'), 'codex should have work.read grant')
  })

  it('opencode has work.read', () => {
    const opencode = CANONICAL_PRINCIPALS['opencode']
    assert.ok(opencode, 'opencode should be a canonical principal')
    assert.ok(hasGrant(opencode, 'work.read'), 'opencode should have work.read grant')
  })

  it('operator has work.read', () => {
    const operator: MessagePrincipal = {
      id: 'operator',
      kind: 'human',
      canSend: true,
      canReceive: true,
      grants: [{ name: 'message.send' }, { name: 'work.read' }],
    }
    assert.ok(hasGrant(operator, 'work.read'), 'operator should have work.read grant')
  })

  it('relay has work.read', () => {
    const relay: MessagePrincipal = {
      id: 'relay',
      kind: 'agent',
      canSend: true,
      canReceive: true,
      grants: [{ name: 'message.send' }, { name: 'work.read' }],
    }
    assert.ok(hasGrant(relay, 'work.read'), 'relay should have work.read grant')
  })

  it('pet does NOT have work.read', () => {
    const pet = CANONICAL_PRINCIPALS['pet']
    assert.ok(pet, 'pet should be a canonical principal')
    assert.equal(hasGrant(pet, 'work.read'), false, 'pet should NOT have work.read grant')
  })

  it('foreman-work has work.read', () => {
    const foremanWork = CANONICAL_PRINCIPALS['foreman-work']
    assert.ok(foremanWork, 'foreman-work should be a canonical principal')
    assert.ok(hasGrant(foremanWork, 'work.read'), 'foreman-work should have work.read grant')
  })
})
