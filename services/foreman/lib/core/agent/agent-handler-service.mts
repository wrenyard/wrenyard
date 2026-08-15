/**
 * AgentHandlerService — RPC-level service for agent.list, agent.sync,
 * agent.compact, and agent.graph.review methods. Wraps the AgentEventStore
 * and delegates only runtime-specific operations through narrow ports.
 *
 * This module lives in lib/core so it can be used by both daemon and
 * protocol layers. It accepts an injectable WorkPort to avoid importing
 * daemon-level service code directly.
 */

import { AgentEventStore } from './agent-event-store.mts'
import { FOREMAN_WORK_ADDRESS } from '../../message/address.mts'
import { AgentGraphProjector } from './agent-graph-projector.mts'

// ─── WorkPort — injectable WorkService surface for cyclic dependency ──

export interface WorkCompactPort {
  /** Compact the foreman-work transcript. */
  compact(): { compact_seq: number; covers_through_seq: number }
  /** Get the conversation status. */
  getStatus(): string
  /** Get queue depth snapshot. */
  getQueueDepth(): number
  /** Current model state for the foreman-work agent. */
  modelList(): { current: string; available: string[] }
  /** Switch the foreman-work agent to a different available model. */
  modelSet(address: string, model: string): { current: string; available: string[] }
  /** Number of branch turns currently in flight. */
  getRunningBranches?(): number
}

export interface GraphReviewPort {
  confirm(graphId: string, patchId: string): Promise<{ type: string }>
  reject(graphId: string, patchId: string): Promise<boolean>
}

// ─── Params / Result types ────────────────────────────────────────────

export interface AgentSyncParams {
  address: string
  after_seq?: number
  limit?: number
  wait_ms?: number
}

export interface AgentCompactParams {
  address: string
}

export interface AgentGraphReviewParams {
  address: string
  graph_id: string
  patch_id: string
  decision: 'confirm' | 'reject'
  client_action_id: string
}

export interface AgentListResult {
  agents: Array<{
    address: string
    kind: string
    status: string
    last_seq: number
    queue_depth: number
    model: string
  }>
}

export interface AgentSyncResult {
  events: Array<{
    seq: number
    turn_seq?: number
    kind: string
    payload: unknown
    created_at: string
  }>
  next_seq: number
  has_more: boolean
  state: string
  /** Number of branch turns currently in flight for the address. */
  running_branches: number
}

export interface AgentCompactResult {
  compact_seq: number
  covers_through_seq: number
}

export interface AgentGraphReviewResult {
  status: string
}

export interface AgentModelListResult {
  current: string
  available: string[]
}

export interface AgentModelSetParams {
  address: string
  model: string
}

export interface AgentModelSetResult {
  ok: boolean
  current: string
  available: string[]
  error?: string
}

// ─── Service ──────────────────────────────────────────────────────────

export class AgentHandlerService {
  private readonly store: AgentEventStore
  private workPort?: WorkCompactPort
  private graphReviewPort?: GraphReviewPort
  private readonly graphProjector: AgentGraphProjector

  constructor(store: AgentEventStore, workPort?: WorkCompactPort) {
    this.store = store
    this.workPort = workPort
    this.graphProjector = new AgentGraphProjector(store)
  }

  /** Set the Work port after construction (for cyclic dependency resolution). */
  setWorkPort(port: WorkCompactPort): void {
    this.workPort = port
  }

  setGraphReviewPort(port: GraphReviewPort): void {
    this.graphReviewPort = port
  }

  async list(): Promise<AgentListResult> {
    const conversations = this.store.listConversations()
    const agents = conversations.map((conv) => ({
      address: conv.address,
      kind: conv.kind,
      status: conv.status,
      last_seq: conv.next_event_seq - 1,
      queue_depth: this.store.getQueueDepth(conv.address),
      model: conv.model,
    }))
    return { agents }
  }

  async sync(params: AgentSyncParams): Promise<AgentSyncResult> {
    const runningBranches = params.address === FOREMAN_WORK_ADDRESS
      ? (this.workPort?.getRunningBranches?.() ?? 0)
      : 0
    if ((params.after_seq ?? 0) === 0) {
      const visible = this.store.getVisibleAfterCompact(
        params.address,
        0,
        params.limit ?? 200,
      )
      return {
        ...visible,
        state: this.store.getConversation(params.address)?.status ?? 'unknown',
        running_branches: runningBranches,
      }
    }
    const result = await this.store.sync({
      address: params.address,
      after_seq: params.after_seq,
      limit: params.limit,
      wait_ms: params.wait_ms,
    })
    return { ...result, running_branches: runningBranches }
  }

  async compact(params: AgentCompactParams): Promise<AgentCompactResult> {
    // Delegate to WorkService when address is foreman-work and workPort is available
    if (params.address === FOREMAN_WORK_ADDRESS && this.workPort) {
      return this.workPort.compact()
    }
    // Native FWA conversations use the generic durable compact operation.
    const result = this.store.compact({ address: params.address })
    return result
  }

  async modelList(): Promise<AgentModelListResult> {
    if (!this.workPort) {
      throw new Error('agent.model.list unavailable: the foreman-work agent is not running')
    }
    return this.workPort.modelList()
  }

  async modelSet(params: AgentModelSetParams): Promise<AgentModelSetResult> {
    if (params.address !== FOREMAN_WORK_ADDRESS) {
      return {
        ok: false,
        current: '',
        available: [],
        error: `agent.model.set only supports address 'foreman-work', got '${params.address}'`,
      }
    }
    if (!this.workPort) {
      return {
        ok: false,
        current: '',
        available: [],
        error: 'agent.model.set unavailable: the foreman-work agent is not running',
      }
    }
    try {
      const state = this.workPort.modelSet(params.address, params.model)
      return { ok: true, current: state.current, available: state.available }
    } catch (error) {
      // Report the unchanged current model state alongside the validation error.
      let state: { current: string; available: string[] } = { current: '', available: [] }
      try {
        state = this.workPort.modelList()
      } catch {
        // state stays empty; the error message is the source of truth
      }
      return {
        ok: false,
        ...state,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async graphReview(params: AgentGraphReviewParams): Promise<AgentGraphReviewResult> {
    if (!this.store.getConversation(params.address)) return { status: 'unknown_agent_address' }
    if (!this.graphReviewPort) return { status: 'unavailable' }

    let status: string
    if (params.decision === 'confirm') {
      const result = await this.graphReviewPort.confirm(params.graph_id, params.patch_id)
      status = result.type === 'applied' ? 'confirmed' : 'rejected'
    } else {
      status = await this.graphReviewPort.reject(params.graph_id, params.patch_id)
        ? 'rejected'
        : 'patch_not_found'
    }

    this.graphProjector.appendStatus({
      address: params.address,
      graphId: params.graph_id,
      patchId: params.patch_id,
      decision: params.decision,
      status,
      clientActionId: params.client_action_id,
    })
    return { status }
  }
}
