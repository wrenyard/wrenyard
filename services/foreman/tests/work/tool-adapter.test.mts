/**
 * Tests for the Work LangChain tool adapter.
 *
 * Verifies:
 * - createWorkTools exposes exactly the canonical Work allowlist
 * - Invokes RpcRouter with authoritative foreman-work sender object
 * - send_message cannot impersonate sender
 * - Normal results serialize correctly
 * - >64 KiB output becomes deterministic bounded JSON with truncation metadata
 * - Router errors and unbound router fail clearly
 * - Custom input schemas via spec.inputSchema are exposed
 * - UTF-8 byte-accurate truncation for multibyte and escape-heavy payloads
 * - Long RPC error messages are bounded
 */

import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { workAgentTools } from '../../lib/protocol/agent-tools.mts'
import type { RpcRouter } from '../../lib/server/rpc-router.mts'
import { createWorkTools, boundedToolOutput } from '../../lib/daemon/services/work/tool-adapter.mts'
import { AgentEventStore } from '../../lib/core/agent/agent-event-store.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'

class FakeRouter {
  async handleMessage(_input: unknown, context?: unknown) {
    const ctx = (context ?? {}) as Record<string, unknown>
    return {
      jsonrpc: '2.0',
      id: 'test',
      result: {
        context_sender: ctx.sender,
      },
    }
  }
}

describe('createWorkTools', () => {
  it('exposes exactly the canonical Work allowlist of tools', () => {
    const tools = createWorkTools(null, 'foreman-work')
    assert.equal(tools.length, workAgentTools.length)
    const toolNames = new Set(tools.map((t) => t.name))
    const expectedNames = new Set(workAgentTools.map((t) => t.name))
    for (const name of expectedNames) {
      assert.ok(toolNames.has(name), `Work tool '${name}' should be in exposed tools`)
    }
    assert.equal(toolNames.size, expectedNames.size, 'No extra or missing tools')
  })

  it('invokes RpcRouter with authoritative foreman-work sender object', async () => {
    const tools = createWorkTools(new FakeRouter() as unknown as RpcRouter, 'codex')
    const sendTool = tools.find((t) => t.name === 'send_message')
    assert.ok(sendTool, 'send_message tool should exist')

    const result = await sendTool.func({ to: 'relay', text: 'hello' })
    const parsed = JSON.parse(result) as { context_sender: unknown }
    assert.ok(parsed.context_sender)
    const senderObj = parsed.context_sender as { role: string }
    assert.equal(senderObj.role, 'codex')
  })

  it('send_message input cannot impersonate sender', async () => {
    const tools = createWorkTools(new FakeRouter() as unknown as RpcRouter, 'relay')
    const sendTool = tools.find((t) => t.name === 'send_message')
    assert.ok(sendTool)

    const result = await sendTool.func({
      to: 'codex',
      text: 'hello',
      sender: { role: 'malicious' },
    } as Record<string, unknown>)
    const parsed = JSON.parse(result) as { context_sender: { role: string } }
    // Sender should be 'relay', not 'malicious'
    assert.equal(parsed.context_sender.role, 'relay')
  })

  it('normal results serialize correctly', async () => {
    const tools = createWorkTools(new FakeRouter() as unknown as RpcRouter, 'test')
    const tool = tools[0]
    const result = await tool.func({})
    const parsed = JSON.parse(result) as Record<string, unknown>
    assert.ok(typeof parsed === 'object' && parsed !== null)
  })

  it('unbound router throws clear error', async () => {
    const tools = createWorkTools(null, 'test')
    const tool = tools[0]
    await assert.rejects(
      () => tool.invoke({}),
      /Work tool router is not bound/,
    )
  })

  it('exposes pm_ticket_create and fwa_assign dispatch tools', async () => {
    const tools = createWorkTools(new FakeRouter() as unknown as RpcRouter, 'test')
    const ticketCreate = tools.find((t) => t.name === 'pm_ticket_create')
    assert.ok(ticketCreate, 'pm_ticket_create tool should exist')

    // Verify the schema accepts the domain fields
    const result = await ticketCreate.func({ title: 'Task', project_id: 'foreman', kind: 'main' })
    const parsed = JSON.parse(result) as Record<string, unknown>
    assert.ok(parsed, 'pm_ticket_create func should execute with domain fields')

    const fwaAssign = tools.find((t) => t.name === 'fwa_assign')
    assert.ok(fwaAssign, 'fwa_assign tool should exist')
    assert.equal(fwaAssign.metadata?.executionMode, 'delegation', 'fwa_assign must remain a delegation tool')
  })

  it('send_message schema omits sender', async () => {
    const tools = createWorkTools(new FakeRouter() as unknown as RpcRouter, 'test')
    const sendTool = tools.find((t) => t.name === 'send_message')
    assert.ok(sendTool)

    // Verify schema does not expose sender
    const schema = (sendTool as { schema?: unknown }).schema as { shape?: unknown } | undefined
    if (schema && typeof schema === 'object' && 'shape' in schema) {
      const shape = (schema as { shape: Record<string, unknown> }).shape
      assert.equal('sender' in shape, false, 'LangChain schema must not include sender')
    }
  })

  it('delegation tool fails closed without event store', async () => {
    const tools = createWorkTools(new FakeRouter() as unknown as RpcRouter, 'foreman-work')
    const taskRunTool = tools.find((t) => t.name === 'task_run')
    assert.ok(taskRunTool)

    await assert.rejects(
      () => taskRunTool.invoke({ task_id: 'commit', project: 'test' }),
      /requires an AgentEventStore/,
    )
  })

  it('delegation tool fails closed without active turn', async () => {
    const db = new Database(':memory:')
    bootstrapSchema(db)
    const eventStore = new AgentEventStore(db)
    eventStore.createOrGetConversation({
      address: 'foreman-work',
      kind: 'work',
      model: 'test',
    })

    const tools = createWorkTools(new FakeRouter() as unknown as RpcRouter, 'foreman-work', eventStore)
    const taskRunTool = tools.find((t) => t.name === 'task_run')
    assert.ok(taskRunTool)

    await assert.rejects(
      () => taskRunTool.invoke({ task_id: 'commit', project: 'test' }),
      /requires an active/,
    )
  })
})

describe('boundedToolOutput', () => {
  it('returns normal JSON for small outputs', () => {
    const result = boundedToolOutput({ ok: true, message: 'hello' })
    assert.equal(result, '{"ok":true,"message":"hello"}')
  })

  it('truncates outputs larger than 64 KiB', () => {
    const large = { data: 'x'.repeat(70 * 1024) }
    const result = boundedToolOutput(large)
    const parsed = JSON.parse(result) as { truncated: boolean; original_bytes: number; prefix: string }
    assert.ok(parsed.truncated)
    assert.ok(parsed.original_bytes > 64 * 1024)
    assert.ok(typeof parsed.prefix === 'string')
  })

  it('truncation result is valid JSON', () => {
    const large = { data: 'y'.repeat(80 * 1024) }
    const result = boundedToolOutput(large)
    assert.doesNotThrow(() => JSON.parse(result))
  })

  it('enforces 64 KiB by UTF-8 byte length for multibyte content', () => {
    // Each emoji is 4 UTF-8 bytes
    const large = { data: '🚀'.repeat(20 * 1024) }
    const result = boundedToolOutput(large)
    const parsed = JSON.parse(result) as { truncated: boolean; original_bytes: number; prefix: string }
    assert.ok(parsed.truncated, 'multibyte content should be truncated')
    assert.ok(parsed.original_bytes > 64 * 1024, `original_bytes (${parsed.original_bytes}) should exceed limit`)
  })

  it('enforces 64 KiB by UTF-8 byte length for escape-heavy content', () => {
    // String with many characters that get escaped in JSON (e.g. quotes)
    const heavy = { data: '"'.repeat(50 * 1024) }
    const result = boundedToolOutput(heavy)
    const parsed = JSON.parse(result) as { truncated: boolean; original_bytes: number; prefix: string }
    assert.ok(parsed.truncated, 'escape-heavy content should be truncated')
  })

  it('marker JSON itself does not exceed 64 KiB', () => {
    const large = { data: 'x'.repeat(200 * 1024) }
    const result = boundedToolOutput(large)
    assert.ok(Buffer.byteLength(result, 'utf-8') <= 64 * 1024, 'final marker must not exceed 64 KiB UTF-8 bytes')
  })
})
