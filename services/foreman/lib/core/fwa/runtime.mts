/**
 * FWARuntime: FWA adapter over AgentTurnRuntime.
 *
 * Wraps the transport-neutral AgentTurnRuntime while adding FWA-specific
 * metadata (ticket_id, project_id, created_at, updated_at) and persistence
 * callbacks. The actual FIFO queue, single-flight turn loop, tool execution,
 * timeout, max iterations, cancel, and shutdown drain live exclusively in
 * AgentTurnRuntime — this adapter never duplicates the tool loop.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DynamicStructuredTool } from '@langchain/core/tools'
import {
  AgentTurnRuntime,
  type AgentTurnCallbacks,
  type QueuedTurn,
  type TurnResult,
  type AgentTranscriptEntry,
  type AgentTurnState,
} from '../agent/agent-turn-runtime.mts'
import type { FwaSession, FwaSessionStatus, FwaPendingTurn, FwaTranscriptEntry, FwaInspectableQueue, FwaInspectableStatus, FwaTurnTrigger } from './types.mts'
import { sessionIdToAddress } from '../../message/address.mts'

export interface PersistCallbacks {
  onTranscriptEntry: (entry: FwaTranscriptEntry) => Promise<void>
  onTypedEvent?: (entry: { kind: string; payload: Record<string, unknown>; turnSeq: number }) => Promise<void>
  onStatusTransition: (
    status: FwaSessionStatus,
    lastError?: string,
    turnSeq?: number,
    state?: AgentTurnState,
  ) => Promise<void>
  onRefs: (graphRefs: string[], taskRefs: string[]) => Promise<void>
}

export interface FWARuntimeOptions {
  model: BaseChatModel
  tools: DynamicStructuredTool[]
  sessionId: string
  systemPolicy: string
  persistCallbacks?: PersistCallbacks
  restoredTranscript?: FwaTranscriptEntry[]
  restoredTicketId?: string
  restoredProjectId?: string
  restoredGraphRefs?: string[]
  restoredTaskRefs?: string[]
  restoredStatus?: FwaSessionStatus
  restoredLastError?: string | null
  restoredCreatedAt?: string
  restoredUpdatedAt?: string
}

export class FWARuntime {
  private readonly inner: AgentTurnRuntime
  private readonly sessionId: string
  private readonly persistCallbacks?: PersistCallbacks

  private ticketId: string = ''
  private projectId: string = ''
  private createdAt: string = ''
  private updatedAt: string = ''
  private status: FwaSessionStatus = 'idle'
  private lastError: string | null = null

  constructor(options: FWARuntimeOptions) {
    this.sessionId = options.sessionId
    this.persistCallbacks = options.persistCallbacks
    this.ticketId = options.restoredTicketId ?? ''
    this.projectId = options.restoredProjectId ?? ''

    const address = sessionIdToAddress(options.sessionId)

    // Map restored FwaTranscriptEntry → AgentTranscriptEntry
    const restoredAgentTranscript: AgentTranscriptEntry[] = (options.restoredTranscript ?? []).map((e) => ({
      seq: e.seq,
      role: e.role,
      content: e.content,
      tool_calls: e.tool_calls,
      tool_call_id: e.tool_call_id,
      tool_name: e.tool_name,
      created_at: e.created_at,
    }))

    this.status = options.restoredStatus ?? 'idle'
    this.lastError = options.restoredLastError ?? null
    this.createdAt = options.restoredCreatedAt ?? new Date().toISOString()
    this.updatedAt = options.restoredUpdatedAt ?? this.createdAt

    const callbacks: AgentTurnCallbacks = {
      onEvent: async (entry) => {
        await this.persistCallbacks?.onTypedEvent?.({
          kind: entry.kind,
          payload: entry.payload,
          turnSeq: entry.turnSeq,
        })
        if (this.persistCallbacks?.onTranscriptEntry) {
          if (entry.kind === 'tool_call') return
          const fwaEntry: FwaTranscriptEntry = {
            seq: entry.seq,
            role: entry.payload.role as FwaTranscriptEntry['role'],
            content: entry.payload.content as string,
            tool_calls: entry.payload.tool_calls as FwaTranscriptEntry['tool_calls'],
            tool_call_id: entry.payload.tool_call_id as string | undefined,
            tool_name: entry.payload.tool_name as string | undefined,
            created_at: new Date().toISOString(),
          }
          await this.persistCallbacks.onTranscriptEntry(fwaEntry)
        }
      },
      onTurnState: async (turnSeq, state, error) => {
        const effectiveState = state === 'done' && this.inner.getStatus() === 'failed'
          ? 'failed'
          : state
        this.status = agentTurnStateToFwaStatus(effectiveState)
        if (error !== undefined) {
          this.lastError = error
        } else if (effectiveState === 'done') {
          this.lastError = null
        }
        this.updatedAt = new Date().toISOString()
        await this.persistCallbacks?.onStatusTransition(
          this.status,
          this.lastError ?? undefined,
          turnSeq,
          effectiveState,
        )
      },
      onRefs: async (graphRefs, taskRefs) => {
        await this.persistCallbacks?.onRefs(graphRefs, taskRefs)
      },
    }

    this.inner = new AgentTurnRuntime({
      address,
      model: options.model,
      tools: options.tools,
      systemPolicy: options.systemPolicy,
      callbacks,
      restoredTranscript: restoredAgentTranscript,
      restoredGraphRefs: options.restoredGraphRefs,
      restoredTaskRefs: options.restoredTaskRefs,
      restoredStatus: fwaStatusToAgentStatus(this.status),
      restoredLastError: this.lastError,
    })
  }

  getStatus(): string {
    return this.status
  }

  setSessionMeta(ticketId: string, projectId: string): void {
    this.ticketId = ticketId
    this.projectId = projectId
  }

  inspectStatus(): FwaInspectableStatus {
    return {
      session_id: this.sessionId,
      message_address: this.inner.getAddress(),
      ticket_id: this.ticketId,
      project_id: this.projectId,
      status: this.status,
      queue_depth: this.inner.getQueueDepth(),
      active_turn_seq: this.inner.getActiveTurnSeq(),
      last_error: this.lastError,
      graph_refs: this.inner.getGraphRefs(),
      task_refs: this.inner.getTaskRefs(),
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    }
  }

  inspectQueue(): FwaInspectableQueue {
    return {
      pending: [],
    }
  }

  getTranscripts(): FwaTranscriptEntry[] {
    return this.inner.getTranscript().map((e) => ({
      seq: e.seq,
      role: e.role as FwaTranscriptEntry['role'],
      content: e.content,
      tool_calls: e.tool_calls,
      tool_call_id: e.tool_call_id,
      tool_name: e.tool_name,
      created_at: e.created_at,
    }))
  }

  getGraphRefs(): string[] {
    return this.inner.getGraphRefs()
  }

  getTaskRefs(): string[] {
    return this.inner.getTaskRefs()
  }

  async mergeRefs(graphRefs: string[], taskRefs: string[]): Promise<void> {
    await this.inner.mergeRefs(graphRefs, taskRefs)
    this.updatedAt = new Date().toISOString()
  }

  async enqueue(turn: FwaPendingTurn): Promise<string> {
    const result = await this.inner.enqueue({
      turnSeq: turn.seq,
      prompt: turn.prompt,
      from: turn.trigger,
      created_at: turn.created_at,
    })
    if (result.state === 'done' && result.text) return result.text
    if (result.state === 'failed') throw new Error(result.error ?? 'turn failed')
    throw new Error(`turn ended with state: ${result.state}`)
  }

  fail(error: string): void {
    this.inner.fail(error)
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown()
  }

  async close(): Promise<void> {
    await this.inner.close()
    this.status = 'closed'
  }
}

// ─── Status mapping helpers ───────────────────────────────────────────

function agentTurnStateToFwaStatus(state: AgentTurnState): FwaSessionStatus {
  switch (state) {
    case 'running': return 'running_turn'
    case 'failed': return 'failed'
    case 'queued':
    case 'cancelled':
    case 'done':
    default:
      return 'idle'
  }
}

function fwaStatusToAgentStatus(status: FwaSessionStatus): 'idle' | 'running' | 'failed' | 'closed' {
  switch (status) {
    case 'running_turn': return 'running'
    case 'failed': return 'failed'
    case 'closed': return 'closed'
    case 'idle':
    default:
      return 'idle'
  }
}
