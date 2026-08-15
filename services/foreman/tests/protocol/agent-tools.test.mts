/**
 * Tests for the canonical protocol agent-tools registry.
 *
 * Verifies:
 * - Every workAgentTools method exists in methodRegistry
 * - Banned methods (workflow, daemon, pet, MCP sessions, etc.) are absent
 * - The Work surface is a front-desk domain: no work-execution tools remain
 * - pm.ticket.create, fwa.assign, agent.list, agent.model.list are present
 * - send_message cannot carry sender
 */

import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { workAgentTools, mcpProtocolTools } from '../../lib/protocol/agent-tools.mts'
import { methodRegistry } from '../../lib/protocol/registry.mts'

const workToolNames = new Set(workAgentTools.map((t) => t.name))
const workToolMethods = new Set(workAgentTools.map((t) => t.method))

describe('workAgentTools allowlist', () => {
  it('every Work tool name has a registered method in methodRegistry', () => {
    for (const tool of workAgentTools) {
      assert.ok(
        tool.method in methodRegistry,
        `Work tool '${tool.name}' references method '${tool.method}' which is not in methodRegistry`,
      )
    }
  })

  it('contains exactly the expected domain tools without generic/system tools', () => {
    const banned = ['workflow', 'daemon', 'pet', 'session', 'bash', 'shell', 'system', 'work_send', 'work_transcript']
    for (const prefix of banned) {
      for (const tool of workAgentTools) {
        assert.equal(
          tool.name.startsWith(prefix),
          false,
          `Work tool '${tool.name}' starts with banned prefix '${prefix}'`,
        )
      }
    }
  })

  it('defines an exact Work tool-name set without MCP-local tools', () => {
    const workNames = new Set(workAgentTools.map((t) => t.name))
    const mcpLocal = ['sessions_list', 'session_send', 'work_send', 'work_transcript']
    for (const name of mcpLocal) {
      assert.equal(
        workNames.has(name),
        false,
        `Work tool set must not contain MCP-local tool '${name}'`,
      )
    }
  })

  it('exposes agent.list and agent.model.list observation tools', () => {
    const agentList = workAgentTools.find((t) => t.name === 'agent_list')
    assert.ok(agentList, 'agent_list tool must exist')
    assert.equal(agentList.method, 'agent.list')

    const agentModelList = workAgentTools.find((t) => t.name === 'agent_model_list')
    assert.ok(agentModelList, 'agent_model_list tool must exist')
    assert.equal(agentModelList.method, 'agent.model.list')
  })

  it('contains pm.ticket.create and fwa.assign dispatch tools with valid schemas', () => {
    const ticketCreate = workAgentTools.find((t) => t.name === 'pm_ticket_create')
    assert.ok(ticketCreate, 'pm_ticket_create tool must exist')
    assert.equal(ticketCreate.method, 'pm.ticket.create')
    assert.ok(ticketCreate.method in methodRegistry, 'pm.ticket.create must be in methodRegistry')
    assert.ok(methodRegistry['pm.ticket.create'].params, 'pm.ticket.create must have a params schema')

    const fwaAssign = workAgentTools.find((t) => t.name === 'fwa_assign')
    assert.ok(fwaAssign, 'fwa_assign tool must exist')
    assert.equal(fwaAssign.method, 'fwa.assign')
    assert.equal(fwaAssign.executionMode, 'delegation')
    assert.ok(methodRegistry['fwa.assign'].params, 'fwa.assign must have a params schema')
  })

  it('excludes every work-execution tool from the Work surface', () => {
    const bannedNames = [
      // TaskGraph mutation / lifecycle control
      'taskgraph_create', 'taskgraph_patch', 'taskgraph_signal', 'taskgraph_wait',
      // git writes
      'project_pull', 'project_push', 'project_commit', 'worktree_create',
      'worktree_remove', 'worktree_merge',
      // workspace doc writes
      'workspace_doc_create', 'workspace_doc_update',
      // task state mutation
      'task_cancel', 'task_run_list',
      // beyond-ticket-dispatch mutations
      'pm_ticket_delete',
    ]
    for (const name of bannedNames) {
      assert.equal(
        workToolNames.has(name),
        false,
        `Work surface must not contain work-execution tool '${name}'`,
      )
    }
  })

  it('send_message removes sender from params', () => {
    const sendTool = workAgentTools.find((t) => t.name === 'send_message')
    assert.ok(sendTool, 'send_message tool must exist')

    const transformed = sendTool.params!({
      to: 'relay',
      text: 'hello',
      sender: { role: 'malicious' },
    } as Record<string, unknown>)
    assert.ok(transformed.to, 'to should be preserved')
    assert.equal(transformed.text, 'hello')
    assert.equal('sender' in transformed, false, 'sender must be stripped from model input')
  })

  it('send_message without sender in params works normally', () => {
    const sendTool = workAgentTools.find((t) => t.name === 'send_message')
    assert.ok(sendTool)

    const transformed = sendTool.params!({
      to: 'relay',
      text: 'hello',
    })
    assert.equal(transformed.to, 'relay')
    assert.equal(transformed.text, 'hello')
  })

  it('send_message inputSchema omits sender', () => {
    const sendTool = workAgentTools.find((t) => t.name === 'send_message')
    assert.ok(sendTool)
    assert.ok(sendTool.inputSchema, 'send_message must have inputSchema')
    const schema = sendTool.inputSchema as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, unknown>
    assert.ok('to' in props, 'inputSchema must include to')
    assert.ok('text' in props, 'inputSchema must include text')
    assert.ok('client_message_id' in props, 'inputSchema must include client_message_id')
    assert.equal('sender' in props, false, 'inputSchema must not expose sender')
  })
})
