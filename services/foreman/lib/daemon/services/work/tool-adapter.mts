/**
 * In-process projection of the canonical Foreman protocol tool registry for
 * the daemon-owned Work agent. There is deliberately no second tool catalog,
 * per-tool schema, HTTP, MCP, or CLI fallback here.
 */

import { randomBytes } from 'node:crypto'

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'

import { methodRegistry } from '../../../protocol/registry.mts'
import type { RpcRouter } from '../../../server/rpc-router.mts'
import { workAgentTools } from '../../../protocol/agent-tools.mts'
import type { AgentEventStore } from '../../../core/agent/agent-event-store.mts'

export function createWorkTools(
  router: RpcRouter | null,
  senderAddress: string,
  eventStore?: AgentEventStore,
): DynamicStructuredTool[] {
  return workAgentTools.map((spec) => new DynamicStructuredTool({
    name: spec.name,
    description: spec.description,
    schema: z.fromJSONSchema(spec.inputSchema ?? methodRegistry[spec.method].params),
    metadata: { executionMode: spec.executionMode ?? 'inline' },
    func: async (input: Record<string, unknown>) => {
      if (!router) throw new Error('Work tool router is not bound')

      // ── Delegation tools: fail closed, require event store + active turn ──
      if (spec.executionMode === 'delegation' && (spec.name === 'task_run' || spec.name === 'fwa_assign')) {
        // Fail closed: require event store and active Work turn
        if (!eventStore) throw new Error(`${spec.name} requires an AgentEventStore for delegation admission`)
        const activeTurn = eventStore.getActiveTurn(senderAddress)
        if (!activeTurn) throw new Error(`${spec.name} requires an active (running) turn for delegation admission`)

        // Build internal admission descriptor
        const delegationId = `del_${randomBytes(8).toString('hex')}`
        const originalInput = input

        // Pass admission context only in in-process RPC context
        const response = await router.handleMessage({
          jsonrpc: '2.0',
          id: `work_${randomBytes(6).toString('hex')}`,
          method: spec.method,
          params: spec.params ? spec.params(input) : input,
        }, {
          transport: 'mcp',
          sender: { role: senderAddress },
          delegationAdmission: {
            address: senderAddress,
            turn_seq: activeTurn.turn_seq,
            delegation_id: delegationId,
            tool_name: spec.name,
            input: originalInput,
          },
        })

        if (!response) throw new Error(`No RPC response for ${spec.method}`)
        if ('error' in response) throw new Error(boundErrorMessage(response.error.message))

        const result = spec.result ? spec.result(response.result) : response.result
        const resourceId = extractResourceId(spec.name, result)
        if (!resourceId) throw new Error(`No resource id returned for delegation tool '${spec.name}'`)

        // Verify the matching agent_delegation row exists (admitted atomically by the handler)
        const delegation = eventStore.getDelegationByResource(resourceId)
        if (!delegation) throw new Error(`Delegation admission failed: no delegation row for resource '${resourceId}'`)
        if (delegation.address !== senderAddress) throw new Error(`Delegation resource '${resourceId}' belongs to a different address`)

        // Return fixed handle-free receipt
        return `Delegated to a background agent; the turn terminates here and will not continue.`
      }

      // ── Inspection tools: block own-pending resources ──
      if (spec.name === 'task_status' || spec.name === 'task_output' ||
          spec.name === 'fwa_status' || spec.name === 'fwa_transcript') {
        const resourceId = extractInspectionResourceId(spec.name, input)
        if (resourceId && eventStore) {
          const delegation = eventStore.getDelegationByResource(resourceId)
          if (delegation && delegation.address === senderAddress && delegation.status === 'pending') {
            throw new Error(`Cannot inspect own pending delegation resource '${resourceId}'. Use task_cancel to cancel it first.`)
          }
        }
        // Allow for resolved/external resources and cancellation tools
      }

      // ── Regular tools and allowed inspection tools ──
      const response = await router.handleMessage({
        jsonrpc: '2.0',
        id: `work_${randomBytes(6).toString('hex')}`,
        method: spec.method,
        params: spec.params ? spec.params(input) : input,
      }, {
        transport: 'mcp',
        sender: { role: senderAddress },
      })

      if (!response) throw new Error(`No RPC response for ${spec.method}`)
      if ('error' in response) throw new Error(boundErrorMessage(response.error.message))
      return boundedToolOutput(spec.result ? spec.result(response.result) : response.result)
    },
  }))
}

/**
 * Serialize tool output deterministically with a 64 KiB byte limit.
 * Returns a valid JSON object with truncation metadata when oversize.
 * The final marker JSON itself is guaranteed to not exceed 64 KiB.
 */
export function boundedToolOutput(value: unknown): string {
  const serialized = JSON.stringify(value)
  const serializedBytes = Buffer.byteLength(serialized, 'utf-8')
  if (serializedBytes <= 64 * 1024) return serialized

  // Build the truncation marker with a progressively smaller prefix
  // until the marker itself fits in 64 KiB.
  const originalBytes = serializedBytes
  let prefixLen = 60 * 1024
  let prefix: string
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const buf = Buffer.from(serialized, 'utf-8').subarray(0, prefixLen)
    prefix = buf.toString('utf-8') // drops incomplete multi-byte sequences
    const marker = JSON.stringify({ truncated: true, original_bytes: originalBytes, prefix })
    if (Buffer.byteLength(marker, 'utf-8') <= 64 * 1024) break
    prefixLen = Math.floor(prefixLen * 0.9)
  }
  return JSON.stringify({ truncated: true, original_bytes: originalBytes, prefix })
}

/**
 * Bound an error message to 4 KiB (UTF-8) to prevent oversized LangChain errors.
 */
/**
 * Extract the resource id from a delegation tool's result.
 * For task_run: looks for id/task_run_id in the result.
 * For fwa_assign: looks for id/session_id in the result.
 */
function extractResourceId(toolName: string, result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const rec = result as Record<string, unknown>
  if (toolName === 'task_run') {
    return (rec.id ?? rec.task_run_id ?? rec.executionId) as string | undefined
  }
  if (toolName === 'fwa_assign') {
    // Try session.id first (nested result shape), then flat fallbacks
    const session = typeof rec.session === 'object' && rec.session !== null ? (rec.session as Record<string, unknown>) : null
    if (session && typeof session.id === 'string') return session.id
    return (rec.id ?? rec.session_id ?? rec.assignment_id) as string | undefined
  }
  return undefined
}

/**
 * Extract the resource id from an inspection tool's input.
 * task_status/task_output: looks for task_run_id in input
 * fwa_status/fwa_transcript: looks for session_id in input
 */
function extractInspectionResourceId(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'task_status' || toolName === 'task_output') {
    return (input.task_run_id ?? input.id) as string | undefined
  }
  if (toolName === 'fwa_status' || toolName === 'fwa_transcript') {
    return (input.session_id ?? input.id) as string | undefined
  }
  return undefined
}

function boundErrorMessage(message: string): string {
  const maxBytes = 4 * 1024
  const buf = Buffer.from(message, 'utf-8')
  if (buf.length <= maxBytes) return message
  return buf.subarray(0, maxBytes).toString('utf-8')
}
