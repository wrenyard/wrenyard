/**
 * Durable TaskGraph projections derived from canonical agent tool events.
 *
 * Work and FWA runtimes persist raw tool_call/tool_result events first, then
 * pass them here. The projector emits typed graph events consumed unchanged
 * by every client. No TUI or MCP client needs to understand tool payloads.
 */

import type { AgentEventStore } from './agent-event-store.mts'

interface ToolCallState {
  name: string
  args: Record<string, unknown>
  callSeq: number
}

interface AddressState {
  hydrated: boolean
  calls: Map<string, ToolCallState>
  graphs: Map<string, Record<string, unknown>>
  pending: Map<string, { graphId: string; graph: Record<string, unknown> }>
}

export class AgentGraphProjector {
  private readonly store: AgentEventStore
  private readonly states = new Map<string, AddressState>()

  constructor(store: AgentEventStore) {
    this.store = store
  }

  observe(params: {
    address: string
    turnSeq?: number
    kind: 'assistant' | 'tool_call' | 'tool_result'
    payload: Record<string, unknown>
    rawSeq: number
  }): void {
    const state = this.stateFor(params.address)
    if (params.kind === 'tool_call') {
      this.rememberCall(state, params.payload, params.rawSeq)
      return
    }
    if (params.kind !== 'tool_result') return

    const callId = stringField(params.payload, 'tool_call_id')
    const call = callId ? state.calls.get(callId) : undefined
    const result = jsonObject(params.payload.content)
    if (!call || !result) return

    if (call.name === 'taskgraph_inspect') {
      const graph = objectField(result, 'graph')
      const graphId = stringField(call.args, 'taskgraph_id') ?? (graph && stringField(graph, 'id'))
      if (!graph || !graphId) return
      state.graphs.set(graphId, graph)
      this.store.appendEvent({
        address: params.address,
        ...(params.turnSeq !== undefined ? { turn_seq: params.turnSeq } : {}),
        kind: 'graph_snapshot',
        payload: {
          graph_id: graphId,
          graph,
          tool_call_id: callId,
          tool_call_seq: call.callSeq,
          tool_result_seq: params.rawSeq,
        },
      })
      return
    }

    if (call.name !== 'taskgraph_patch') return
    const request = requestPatch(call.args)
    const preview = patchPreview(result)
    if (!request || !preview) return
    const before = state.graphs.get(request.graphId)
    if (!before || numberField(before, 'revision') !== request.baseRevision) return

    state.pending.set(preview.patchId, { graphId: request.graphId, graph: preview.graph })
    this.store.appendEvent({
      address: params.address,
      ...(params.turnSeq !== undefined ? { turn_seq: params.turnSeq } : {}),
      kind: 'graph_patch_proposal',
      payload: {
        graph_id: request.graphId,
        before_graph: before,
        after_graph: preview.graph,
        patch_id: preview.patchId,
        tool_call_id: callId,
        tool_call_seq: call.callSeq,
        tool_result_seq: params.rawSeq,
      },
    })
  }

  appendStatus(params: {
    address: string
    graphId: string
    patchId: string
    decision: 'confirm' | 'reject'
    status: string
    clientActionId: string
  }): void {
    const state = this.stateFor(params.address)
    const pending = state.pending.get(params.patchId)
    if (params.status === 'confirmed' && pending?.graphId === params.graphId) {
      state.graphs.set(params.graphId, pending.graph)
    }
    state.pending.delete(params.patchId)
    this.store.appendEvent({
      address: params.address,
      kind: 'graph_patch_status',
      payload: {
        graph_id: params.graphId,
        patch_id: params.patchId,
        decision: params.decision,
        status: params.status,
        client_action_id: params.clientActionId,
      },
    })
  }

  private stateFor(address: string): AddressState {
    const state = this.states.get(address) ?? {
      hydrated: false,
      calls: new Map(),
      graphs: new Map(),
      pending: new Map(),
    }
    this.states.set(address, state)
    if (!state.hydrated) this.hydrate(address, state)
    return state
  }

  private hydrate(address: string, state: AddressState): void {
    state.hydrated = true
    const events = this.store.getVisibleAfterCompact(address, 0, 10_000).events
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>
      if (event.kind === 'tool_call') {
        this.rememberCall(state, payload, event.seq)
      } else if (event.kind === 'tool_result') {
        const callId = stringField(payload, 'tool_call_id')
        const call = callId ? state.calls.get(callId) : undefined
        const result = jsonObject(payload.content)
        if (call?.name === 'taskgraph_inspect' && result) {
          const graph = objectField(result, 'graph')
          const graphId = stringField(call.args, 'taskgraph_id') ?? (graph && stringField(graph, 'id'))
          if (graph && graphId) state.graphs.set(graphId, graph)
        }
      } else if (event.kind === 'graph_snapshot') {
        const graphId = stringField(payload, 'graph_id')
        const graph = objectField(payload, 'graph')
        if (graphId && graph) state.graphs.set(graphId, graph)
      } else if (event.kind === 'graph_patch_proposal') {
        const graphId = stringField(payload, 'graph_id')
        const patchId = stringField(payload, 'patch_id')
        const graph = objectField(payload, 'after_graph')
        if (graphId && patchId && graph) state.pending.set(patchId, { graphId, graph })
      } else if (event.kind === 'graph_patch_status') {
        const graphId = stringField(payload, 'graph_id')
        const patchId = stringField(payload, 'patch_id')
        const status = stringField(payload, 'status')
        const pending = patchId ? state.pending.get(patchId) : undefined
        if (status === 'confirmed' && graphId && pending?.graphId === graphId) {
          state.graphs.set(graphId, pending.graph)
        }
        if (patchId) state.pending.delete(patchId)
      }
    }
  }

  private rememberCall(state: AddressState, payload: Record<string, unknown>, callSeq: number): void {
    const callId = stringField(payload, 'tool_call_id')
    const name = stringField(payload, 'tool_name')
    const args = objectField(payload, 'args')
    if (callId && name && args) state.calls.set(callId, { name, args, callSeq })
  }
}

function requestPatch(args: Record<string, unknown>): { graphId: string; baseRevision: number } | undefined {
  const graphId = stringField(args, 'taskgraph_id')
  const operation = objectField(args, 'operation')
  const patch = operation && objectField(operation, 'patch')
  const baseRevision = patch && numberField(patch, 'base_revision')
  if (!graphId || stringField(operation ?? {}, 'type') !== 'request_patch' || baseRevision === undefined) return undefined
  return { graphId, baseRevision }
}

function patchPreview(result: Record<string, unknown>): { patchId: string; graph: Record<string, unknown> } | undefined {
  const patchId = stringField(result, 'patch_id')
  const graph = objectField(result, 'graph')
  if (stringField(result, 'type') !== 'preview' || !patchId || !graph) return undefined
  return { patchId, graph }
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key]
  return isObject(field) ? field : undefined
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isInteger(field) ? field : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
