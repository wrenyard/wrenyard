/**
 * WorkService — daemon-owned singleton foreman-work agent.
 *
 * Uses AgentTurnRuntime for the turn loop and AgentEventStore for durable
 * conversation/turn/event persistence. The canonical address is forever
 * 'foreman-work' — no session list, no fork, no session picker.
 *
 * Message ingress: MessageService.send(to='foreman-work') → WorkService.send().
 * Tool catalog: full Foreman protocol tool registry projected through the
 * in-process RpcRouter adapter (tool-adapter.mts).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentEventStore, type AgentEventRecord } from '../../../core/agent/agent-event-store.mts'
import { AgentGraphProjector } from '../../../core/agent/agent-graph-projector.mts'
import { AgentTurnRuntime, type AgentTranscriptEntry, type AgentTurnCallbacks } from '../../../core/agent/agent-turn-runtime.mts'
import { ForgeChatModel, type ForgeChatModelConfig, type RawForgeExecutor } from '../../../core/fwa/forge-chat-model.mts'
import { FOREMAN_WORK_ADDRESS } from '../../../message/address.mts'
import type { RpcRouter } from '../../../server/rpc-router.mts'
import { createWorkTools } from './tool-adapter.mts'
import { WorkAttachmentStore, type AttachmentResult } from './attachment-store.mts'

// ─── Types ────────────────────────────────────────────────────────────

export interface WorkServiceOptions {
  /** Workspace root containing WORK.md. */
  workspaceRoot: string
  /** LLM model id (e.g. 'provider/model'). */
  model: string
  /** Optional list of model ids allowed for runtime switching. Defaults to [model]. */
  models?: string[]
  /** Optional turn timeout in ms. */
  turnTimeoutMs?: number
  /** Optional LLM HTTP timeout in ms. */
  httpTimeoutMs?: number
  /** Optional LLM max retries. */
  maxRetries?: number
  /** Optional LLM retry backoff in ms. */
  retryBackoffMs?: number
  /** Optional model context window in tokens. Default 32K. */
  contextWindow?: number
  /** Optional maximum concurrent branch turns (fork/merge). Default 3; 1 = exact FIFO serial. */
  maxConcurrentTurns?: number
  /** Agent event store. */
  agentEventStore: AgentEventStore
  /** Raw Forge executor (same as FWA uses). */
  rawExecutor: RawForgeExecutor
  /** Attachment store for image ingestion. */
  attachmentStore?: WorkAttachmentStore
}

export interface WorkServiceDeps {
  /** Optional RPC router (may be bound after construction). */
  router?: RpcRouter
}

export interface WorkSendResult {
  accepted: boolean
  target_seq: number
  queue_depth: number
  attachment_results?: AttachmentResult[]
}

export interface WorkTranscriptEntry {
  seq: number
  turn_seq?: number
  kind: string
  payload: unknown
  created_at: string
}

export interface WorkTranscriptResult {
  entries: WorkTranscriptEntry[]
  next_seq: number
  has_more: boolean
  state: string
}

export interface WorkModelState {
  current: string
  available: string[]
}

// ─── Service ──────────────────────────────────────────────────────────

export class WorkService {
  private readonly workspaceRoot: string
  private readonly model: string
  private readonly availableModels: string[]
  private readonly turnTimeoutMs: number
  private readonly httpTimeoutMs: number
  private readonly maxRetries: number
  private readonly retryBackoffMs: number
  private readonly store: AgentEventStore
  private readonly rawExecutor: RawForgeExecutor
  private readonly graphProjector: AgentGraphProjector
  private readonly attachmentStore?: WorkAttachmentStore

  /** Currently active model id (hot-swappable at runtime). */
  private currentModel: string

  /** Maximum concurrent branch turns for foreman-work. 1 restores FIFO serial. */
  private readonly maxConcurrentTurns: number

  /** Durable seq of the system marker event emitted per merged branch. */
  private readonly mergeMarkerSeqs = new Map<number, number>()

  /** Model context window in tokens. Conservative 32K default. */
  private readonly contextWindow: number
  /** 80 percent trigger threshold. */
  private readonly compactTriggerThreshold: number
  /** Conversation corpus cap. */
  private readonly corpusCap: number

  private runtime?: AgentTurnRuntime
  private router?: RpcRouter
  private closed = false
  private started = false

  constructor(options: WorkServiceOptions, deps: WorkServiceDeps = {}) {
    this.workspaceRoot = options.workspaceRoot
    this.model = options.model
    this.availableModels = options.models?.length ? [...options.models] : [options.model]
    this.currentModel = options.model
    this.turnTimeoutMs = options.turnTimeoutMs ?? 300_000
    this.httpTimeoutMs = options.httpTimeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    this.retryBackoffMs = options.retryBackoffMs ?? 500
    this.store = options.agentEventStore
    this.rawExecutor = options.rawExecutor
    this.graphProjector = new AgentGraphProjector(this.store)
    this.router = deps.router
    this.contextWindow = options.contextWindow ?? 32_000
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? 3
    this.compactTriggerThreshold = Math.floor(this.contextWindow * 0.8)
    this.corpusCap = Math.min(100_000, this.compactTriggerThreshold - 1000)
    this.attachmentStore = options.attachmentStore
  }

  /**
   * Bind the RPC router after construction (cyclic dependency resolution).
   * Must be called before start() if no router was provided in constructor.
   */
  bindRouter(router: RpcRouter): void {
    if (this.started) {
      throw new Error('WorkService.bindRouter called after start; bind before start')
    }
    this.router = router
  }

  /**
   * Start the Work service: create/restore the foreman-work singleton
   * conversation, recover stale turns, hydrate persisted queued turns,
   * and build the AgentTurnRuntime.
   */
  start(): void {
    if (this.started) return
    if (!this.router) {
      throw new Error('WorkService.start called before router was bound (use bindRouter first)')
    }

    // Read system policy from WORK.md
    const systemPolicy = this.readSystemPolicy()

    // Create or restore the singleton conversation
    const conv = this.store.createOrGetConversation({
      address: FOREMAN_WORK_ADDRESS,
      kind: 'work',
      model: this.model,
      system_policy: systemPolicy,
    })

    // Honor a model persisted by a previous runtime (agent.model.set) when it is
    // still within the configured available set; otherwise keep the configured
    // model and resync the conversation row so agent.list and agent.model.list
    // agree.
    if (this.availableModels.includes(conv.model)) {
      this.currentModel = conv.model
    } else if (conv.model !== this.model) {
      this.store.updateConversationModel(FOREMAN_WORK_ADDRESS, this.model)
    }

    // Create tools from protocol registry → RpcRouter projection
    const tools = createWorkTools(this.router!, FOREMAN_WORK_ADDRESS, this.store)

    // Build the chat model using the same ForgeChatModel as FWA
    const model = this.buildModel(this.currentModel)

    // Assemble context from durable memory corpus and recent turns
    const restoredTranscript = this.assembleContext()

    const callbacks: AgentTurnCallbacks = {
      onEvent: async (entry) => {
        // System marker preceding a merged branch reply. Record its durable
        // seq so the follow-up turn_merged event can reference it.
        if (entry.kind === 'message' && entry.payload.role === 'system') {
          const rawSeq = this.store.appendEvent({
            address: FOREMAN_WORK_ADDRESS,
            turn_seq: entry.turnSeq,
            kind: 'message',
            payload: entry.payload,
          })
          this.mergeMarkerSeqs.set(entry.turnSeq, rawSeq)
          return
        }

        if (entry.kind === 'turn_merged') {
          const markerSeq = this.mergeMarkerSeqs.get(entry.turnSeq)
          this.store.appendEvent({
            address: FOREMAN_WORK_ADDRESS,
            turn_seq: entry.turnSeq,
            kind: 'turn_merged',
            payload: {
              ...entry.payload,
              ...(markerSeq !== undefined ? { merged_at_seq: markerSeq } : {}),
            },
          })
          this.mergeMarkerSeqs.delete(entry.turnSeq)
          return
        }

        const rawSeq = this.store.appendEvent({
          address: FOREMAN_WORK_ADDRESS,
          turn_seq: entry.turnSeq,
          kind: entry.kind as AgentEventRecord['kind'],
          payload: entry.payload,
        })
        if (entry.payload.error !== true) {
          this.graphProjector.observe({
            address: FOREMAN_WORK_ADDRESS,
            turnSeq: entry.turnSeq,
            kind: entry.kind as 'assistant' | 'tool_call' | 'tool_result',
            payload: entry.payload,
            rawSeq,
          })
        }
      },
      onTurnState: async (turnSeq, state, error) => {
        if (state === 'done' || state === 'failed' || state === 'cancelled') {
          if (state === 'cancelled') this.store.cancelTurn(FOREMAN_WORK_ADDRESS, turnSeq)
          else this.store.completeTurn(FOREMAN_WORK_ADDRESS, turnSeq, error)
          // Background post-turn consolidation: no-tools, non-blocking
          this.scheduleBackgroundConsolidation()
        } else if (state === 'running') {
          const claimed = this.store.claimNextTurn(FOREMAN_WORK_ADDRESS)
          if (!claimed || claimed.turn_seq !== turnSeq) {
            throw new Error(`durable FIFO mismatch for ${FOREMAN_WORK_ADDRESS}: expected turn ${turnSeq}, claimed ${claimed?.turn_seq ?? 'none'}`)
          }
        }
      },
      onTurnCompleted: async (turnSeq, metrics, branchId) => {
        this.emitTurnCompleted(turnSeq, metrics, branchId)
      },
    }

    this.runtime = new AgentTurnRuntime({
      address: FOREMAN_WORK_ADDRESS,
      model,
      tools,
      systemPolicy,
      turnTimeoutMs: this.turnTimeoutMs,
      callbacks,
      restoredTranscript,
      restoredStatus: conv.status,
      restoredLastError: null,
      maxConcurrentTurns: this.maxConcurrentTurns,
    })

    // Re-enqueue persisted queued turns (from recovery/restart)
    const queuedTurns = this.store.listQueuedTurns(FOREMAN_WORK_ADDRESS)
    for (const turn of queuedTurns) {
      this.runtime.enqueue({
        turnSeq: turn.turn_seq,
        prompt: turn.prompt_text ?? '',
        from: 'recovery',
        created_at: turn.created_at,
        messageSeq: this.store.getTurnMessageSeq(FOREMAN_WORK_ADDRESS, turn.turn_seq),
      }).catch(() => {
        // Turn errors are handled by runtime callbacks
      })
    }

    this.started = true
  }

  /**
   * Send a message to foreman-work. Creates a durable message event +
   * queued turn atomically, then enqueues in the runtime.
   * Optionally processes attachment descriptors via WorkAttachmentStore.
   */
  send(
    from: string,
    text: string,
    messageId: string,
    attachmentDescriptors?: Array<{ path: string }>,
  ): WorkSendResult {
    if (!this.runtime) {
      throw new Error('WorkService not started')
    }
    if (this.closed) {
      throw new Error('WorkService is closed')
    }

    const runtimeStatus = this.runtime.getStatus()
    if (runtimeStatus === 'closed') {
      throw new Error('WorkService runtime is closed')
    }

    // Ingest attachments via store (if available)
    let attachmentResults: AttachmentResult[] | undefined
    if (attachmentDescriptors && attachmentDescriptors.length > 0 && this.attachmentStore) {
      attachmentResults = this.attachmentStore.ingestBatch(
        attachmentDescriptors.map((d) => ({ path: d.path })),
      )
    }

    // Atomically persist message event + queued turn
    const { event_seq: targetSeq, turn_seq: turnSeq } = this.store.appendMessageEvent({
      address: FOREMAN_WORK_ADDRESS,
      from,
      text,
      message_id: messageId,
      attachment_results: attachmentResults,
    })

    // Preflight compact check: build a snapshot from the store-assembled
    // context plus the just-persisted human input. If the combined context
    // reaches 80% of the model context window, compact synchronously using
    // this exact snapshot so that max_event_seq covers the new message.
    if (this.runtime) {
      const preflightContext: AgentTranscriptEntry[] = [
        ...this.assembleContext(),
        { seq: targetSeq, role: 'human', content: text, created_at: new Date().toISOString() },
      ]
      if (this.estimateTokens(preflightContext) >= this.compactTriggerThreshold) {
        this.compactToMemory(preflightContext)
      }
    }

    // Enqueue in the runtime (fire-and-forget; callbacks handle persistence)
    this.runtime.enqueue({
      turnSeq,
      prompt: text,
      from,
      created_at: new Date().toISOString(),
      messageSeq: targetSeq,
    }).catch(() => {
      // Turn errors are handled by runtime callbacks
    })

    return {
      accepted: true,
      target_seq: targetSeq,
      queue_depth: this.runtime.getQueueDepth(),
      ...(attachmentResults ? { attachment_results: attachmentResults } : {}),
    }
  }

  /**
   * Enqueue an already-durable system_completion turn into the live runtime.
   * Used by the DelegationResolver after atomically persisting a callback turn.
   * The turn must already exist in agent_turn before this call.
   */
  enqueueDurableTurn(turnSeq: number): void {
    if (!this.runtime) {
      throw new Error('WorkService not started')
    }
    const turn = this.store.getTurn(FOREMAN_WORK_ADDRESS, turnSeq)
    if (!turn) {
      throw new Error(`Durable Work turn ${turnSeq} does not exist`)
    }
    if (turn.state !== 'queued') {
      throw new Error(`Durable Work turn ${turnSeq} is ${turn.state}, expected queued`)
    }
    this.runtime.enqueue({
      turnSeq,
      prompt: turn.prompt_text ?? '',
      from: 'system',
      created_at: turn.created_at,
      messageSeq: this.store.getTurnMessageSeq(FOREMAN_WORK_ADDRESS, turnSeq),
    }).catch(() => {
      // Turn errors are handled by runtime callbacks
    })
  }

  /**
   * Read the Work transcript. When includeArchived=false, returns only
   * events after the latest compact boundary (visible window). When true,
   * returns all persisted events via cursor-based sync.
   */
  async transcript(
    afterSeq?: number,
    limit?: number,
    includeArchived?: boolean,
  ): Promise<WorkTranscriptResult> {
    if (!this.runtime) {
      throw new Error('WorkService not started')
    }

    if (includeArchived) {
      // Full history via AgentEventStore.sync
      const result = await this.store.sync({
        address: FOREMAN_WORK_ADDRESS,
        after_seq: afterSeq ?? 0,
        limit: limit ?? 200,
        wait_ms: 0, // no long-poll for transcript reads
      })
      return {
        entries: result.events,
        next_seq: result.next_seq,
        has_more: result.has_more,
        state: result.state,
      }
    }

    // Visible window (after latest compact)
    const visible = this.store.getVisibleAfterCompact(
      FOREMAN_WORK_ADDRESS,
      afterSeq ?? 0,
      Math.min(limit ?? 200, 500),
    )

    return {
      entries: visible.events.map((e) => ({
        seq: e.seq,
        turn_seq: e.turn_seq,
        kind: e.kind,
        payload: e.payload,
        created_at: e.created_at,
      })),
      next_seq: visible.next_seq,
      has_more: visible.has_more,
      state: this.runtime.getStatus(),
    }
  }

  /**
   * Compact the Work conversation. Writes a memory version with a
   * consolidated summary plus a boundary marker. Raw events remain
   * visible — transcript APIs continue to return them. Manual compact
   * invokes the same consolidation path as the automatic trigger.
   */
  compact(): { compact_seq: number; covers_through_seq: number } {
    if (!this.runtime) {
      throw new Error('WorkService not started')
    }

    const result = this.compactToMemory()
    if (!result) {
      return { compact_seq: 0, covers_through_seq: 0 }
    }
    return { compact_seq: result.memory_seq, covers_through_seq: result.covers_through_seq }
  }

  /**
   * Has the sender a live foreman-work conversation?
   */
  hasLiveWork(): boolean {
    return this.started && !this.closed && this.runtime !== undefined
  }

  /**
   * Get event store queue depth snapshot.
   */
  getQueueDepth(): number {
    return this.store.getQueueDepth(FOREMAN_WORK_ADDRESS)
  }

  /**
   * Number of branch turns currently in flight (0 in serial FIFO mode).
   */
  getRunningBranches(): number {
    return this.runtime?.getRunningBranchCount() ?? 0
  }

  /**
   * Get the conversation status.
   */
  getStatus(): string {
    if (!this.runtime) return 'not_started'
    if (this.closed) return 'closed'
    return this.runtime.getStatus()
  }

  /**
   * Current model state for the foreman-work agent.
   */
  modelList(): WorkModelState {
    return { current: this.currentModel, available: [...this.availableModels] }
  }

  /**
   * Switch the foreman-work agent to a different available model. Validates the
   * request, hot-swaps the runtime model used by subsequent turns, and persists
   * the change to the agent_conversation.model column. Returns the new model
   * state.
   */
  modelSet(address: string, modelId: string): WorkModelState {
    if (address !== FOREMAN_WORK_ADDRESS) {
      throw new Error(`agent.model.set only supports address 'foreman-work', got '${address}'`)
    }
    if (!this.runtime || !this.started) {
      throw new Error('WorkService is not started')
    }
    if (!this.availableModels.includes(modelId)) {
      throw new Error(
        `model '${modelId}' is not available; available models: [${this.availableModels.join(', ')}]`,
      )
    }
    if (modelId !== this.currentModel) {
      this.runtime.setModel(this.buildModel(modelId))
      this.currentModel = modelId
      this.store.updateConversationModel(FOREMAN_WORK_ADDRESS, modelId)
    }
    return { current: this.currentModel, available: [...this.availableModels] }
  }

  /**
   * Graceful shutdown: close the runtime, drain pending turns.
   */
  async shutdown(): Promise<void> {
    this.closed = true
    if (this.runtime) {
      await this.runtime.shutdown()
    }
  }

  /**
   * Close the service permanently.
   */
  async close(): Promise<void> {
    this.closed = true
    if (this.runtime) {
      await this.runtime.close()
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /**
   * Build a ForgeChatModel for the given model id using the configured
   * timeouts/retries.
   */
  private buildModel(modelId: string): ForgeChatModel {
    const modelConfig: ForgeChatModelConfig = {
      model: modelId,
      turnTimeoutMs: this.turnTimeoutMs,
      httpTimeoutMs: this.httpTimeoutMs,
      maxRetries: this.maxRetries,
      retryBackoffMs: this.retryBackoffMs,
    }
    return new ForgeChatModel({ config: modelConfig, rawExecutor: this.rawExecutor })
  }

  /**
   * Persist a per-turn completion event on the work stream. Duration is taken
   * from the durable agent_turn started_at/ended_at timestamps when available,
   * falling back to the runtime-computed duration. Usage is included only when
   * the runtime reported real token numbers.
   */
  private emitTurnCompleted(
    turnSeq: number,
    metrics: { duration_ms: number; usage?: { input_tokens: number; output_tokens: number } },
    branchId?: string,
  ): void {
    let durationMs = metrics.duration_ms
    const turn = this.store.getTurn(FOREMAN_WORK_ADDRESS, turnSeq)
    if (turn?.started_at && turn?.ended_at) {
      const started = Date.parse(turn.started_at)
      const ended = Date.parse(turn.ended_at)
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
        durationMs = ended - started
      }
    }

    const payload: Record<string, unknown> = {
      turn_seq: turnSeq,
      duration_ms: durationMs,
    }
    if (branchId !== undefined) {
      payload.branch_id = branchId
    }
    if (metrics.usage && (metrics.usage.input_tokens > 0 || metrics.usage.output_tokens > 0)) {
      payload.usage = {
        input_tokens: metrics.usage.input_tokens,
        output_tokens: metrics.usage.output_tokens,
      }
    }

    this.store.appendEvent({
      address: FOREMAN_WORK_ADDRESS,
      turn_seq: turnSeq,
      kind: 'turn_completed',
      payload,
    })
  }

  /**
   * Assemble context for the single durable Work conversation from:
   * 1. Episodic summary from latest durable memory version
   * 2. Recent verbatim complete turns (max 8 turns or 20K tokens)
   * 3. Pending delegation ledger entries
   *
   * Never includes the current input (that is added by the runtime).
   */
  private assembleContext(): AgentTranscriptEntry[] {
    const entries: AgentTranscriptEntry[] = []

    // 1. Episodic summary from latest durable memory
    const latestMemory = this.store.getLatestMemory(FOREMAN_WORK_ADDRESS)
    if (latestMemory) {
      try {
        const corpus = JSON.parse(latestMemory.corpus_json) as { summary?: string }
        if (corpus.summary) {
          entries.push({
            seq: -1,
            role: 'assistant',
            content: `[Prior context: ${corpus.summary}]`,
            created_at: latestMemory.created_at,
          })
        }
      } catch {
        // Malformed corpus — skip gracefully
      }
    }

    // 2. Recent complete turns (up to 8 turns or 20K tokens).
    // Branch-scoped events (payload.branch_id) and fork/merge metadata are
    // excluded from the mainline context; system markers are kept so the model
    // can interpret out-of-order merged replies.
    const afterSeq = latestMemory ? latestMemory.max_event_seq : 0
    const recentEvents = this.store.getCompleteTurnEvents(FOREMAN_WORK_ADDRESS, afterSeq, 10000)
    const MAX_TURNS = 8
    const MAX_VERBATIM_TOKENS = 20_000
    let tokenCount = 0
    let turnCount = 0

    for (const e of recentEvents) {
      if (turnCount >= MAX_TURNS || tokenCount >= MAX_VERBATIM_TOKENS) break

      const payload = JSON.parse(e.payload_json) as Record<string, unknown>
      if (typeof payload?.branch_id === 'string') continue
      if (e.kind === 'turn_forked' || e.kind === 'turn_merged' || e.kind === 'turn_failed') continue

      const content = typeof payload?.content === 'string' ? payload.content : ''
      tokenCount += Math.ceil(content.length / 4)

      const role = e.kind === 'message'
        ? (payload?.role === 'system' ? 'system' as const : 'human' as const)
        : e.kind === 'assistant'
          ? 'assistant' as const
          : 'tool' as const

      const entry: AgentTranscriptEntry = {
        seq: e.seq,
        role,
        content,
        created_at: e.created_at,
      }
      if (Array.isArray(payload?.tool_calls)) {
        entry.tool_calls = payload.tool_calls as AgentTranscriptEntry['tool_calls']
      }
      if (typeof payload?.tool_call_id === 'string') {
        entry.tool_call_id = payload.tool_call_id
      }
      if (typeof payload?.tool_name === 'string') {
        entry.tool_name = payload.tool_name
      }
      entries.push(entry)
      turnCount++
    }

    // 3. Pending delegation ledger entries
    const pendingDelegations = this.store.getPendingDelegationLedger(FOREMAN_WORK_ADDRESS)
    for (const d of pendingDelegations) {
      entries.push({
        seq: -2,
        role: 'assistant',
        content: `[Pending delegation: ${d.tool_name} (${d.delegation_id})]`,
        created_at: d.created_at,
      })
    }

    return entries
  }

  /**
   * Estimate token count for an array of transcript entries.
   * Uses ~4 chars per token heuristic.
   */
  private estimateTokens(entries: AgentTranscriptEntry[]): number {
    let total = 0
    for (const e of entries) {
      total += Math.ceil(e.content.length / 4)
      if (e.tool_calls) {
        total += Math.ceil(JSON.stringify(e.tool_calls).length / 4)
      }
    }
    return total
  }

  /**
   * Check whether assembled context has reached 80 percent of the
   * configured model context window.
   */
  private shouldCompact(): boolean {
    const transcript = this.runtime?.getTranscript() ?? []
    if (transcript.length > 0) {
      return this.estimateTokens(transcript) >= this.compactTriggerThreshold
    }
    // Runtime transcript may be empty for initial turns (events seeded to store
    // before the runtime processed any). Fall back to store-assembled context.
    const storeContext = this.assembleContext()
    return storeContext.length > 0 && this.estimateTokens(storeContext) >= this.compactTriggerThreshold
  }

  /**
   * Compact the current state to a durable memory version. Writes a
   * memory record plus a boundary compact event. Raw events remain
   * visible. Conversation corpus is capped at corpusCap tokens.
   * Returns memory_seq and covers_through_seq, or null if no state.
   */
  private compactToMemory(explicitTranscript?: AgentTranscriptEntry[]): { memory_seq: number; covers_through_seq: number } | null {
    // Use explicit transcript when provided (preflight path); otherwise prefer
    // runtime transcript and fall back to store-assembled context.
    let transcript: AgentTranscriptEntry[]
    if (explicitTranscript) {
      transcript = explicitTranscript
    } else {
      transcript = this.runtime?.getTranscript() ?? []
      if (transcript.length === 0) {
        transcript = this.assembleContext()
      }
    }
    if (transcript.length === 0) return null

    const conv = this.store.getConversation(FOREMAN_WORK_ADDRESS)
    if (!conv) return null

    const latestMemory = this.store.getLatestMemory(FOREMAN_WORK_ADDRESS)

    // When an explicit snapshot is provided, derive covers_through_seq from the
    // snapshot entries max seq so that the memory covers exactly the events it
    // summarises — no more, no less.
    let coversThroughSeq: number
    if (explicitTranscript) {
      const maxSeq = explicitTranscript.reduce((max, e) => e.seq > max ? e.seq : max, 0)
      coversThroughSeq = maxSeq > 0 ? maxSeq : 0
    } else {
      coversThroughSeq = conv.next_event_seq > 1 ? conv.next_event_seq - 1 : 0
    }
    if (coversThroughSeq === 0) return null

    // Build summary corpus
    const humanCount = transcript.filter((e) => e.role === 'human').length
    const assistantCount = transcript.filter((e) => e.role === 'assistant').length
    const toolCount = transcript.filter((e) => e.role === 'tool').length
    const parts: string[] = []
    if (humanCount > 0) parts.push(`${humanCount} messages`)
    if (assistantCount > 0) parts.push(`${assistantCount} responses`)
    if (toolCount > 0) parts.push(`${toolCount} tool results`)

    // Ensure corpus stays within corpusCap tokens
    const tokenEstimate = this.estimateTokens(transcript)
    const cappedEstimate = Math.min(tokenEstimate, this.corpusCap)

    const corpus = {
      summary: parts.length > 0 ? parts.join(', ') : 'empty',
      turnCount: transcript.length,
      capped: tokenEstimate > this.corpusCap,
    }

    const version = this.computeContextVersion(transcript)
    const memorySeq = this.store.writeMemory({
      address: FOREMAN_WORK_ADDRESS,
      version,
      corpus_json: JSON.stringify(corpus),
      min_event_seq: latestMemory ? latestMemory.max_event_seq + 1 : 1,
      max_event_seq: coversThroughSeq,
      token_estimate: cappedEstimate,
    })

    return { memory_seq: memorySeq, covers_through_seq: coversThroughSeq }
  }

  /**
   * Compute a content-addressable version string for a transcript snapshot.
   */
  private computeContextVersion(transcript: AgentTranscriptEntry[]): string {
    const key = transcript
      .map((e) => `${e.seq}:${e.role}:${e.content.slice(0, 80)}`)
      .join('|')
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash |= 0 // Convert to 32-bit int
    }
    return Math.abs(hash).toString(16).padStart(8, '0')
  }

  /**
   * Schedule non-blocking background consolidation after a turn completes.
   * Runs on next tick, never blocks user response.
   */
  private scheduleBackgroundConsolidation(): void {
    setImmediate(() => {
      this.backgroundConsolidate().catch(() => {
        // Background consolidation errors are non-fatal; swallows silently
      })
    })
  }

  /**
   * No-tools background consolidation. Uses CAS semantics to avoid
   * conflicts with concurrent writers. Never blocks user response.
   */
  private async backgroundConsolidate(): Promise<void> {
    if (!this.shouldCompact()) return

    const latestMemory = this.store.getLatestMemory(FOREMAN_WORK_ADDRESS)
    const conv = this.store.getConversation(FOREMAN_WORK_ADDRESS)
    if (!conv) return

    const transcript = this.runtime?.getTranscript() ?? []
    if (transcript.length === 0) return

    const coversThroughSeq = conv.next_event_seq > 1 ? conv.next_event_seq - 1 : 0
    if (coversThroughSeq === 0) return

    const version = this.computeContextVersion(transcript)
    const tokenEstimate = this.estimateTokens(transcript)
    const cappedEstimate = Math.min(tokenEstimate, this.corpusCap)
    const humanCount = transcript.filter((e) => e.role === 'human').length
    const assistantCount = transcript.filter((e) => e.role === 'assistant').length
    const toolCount = transcript.filter((e) => e.role === 'tool').length

    const corpus = {
      summary: [
        ...(humanCount > 0 ? [`${humanCount} messages`] : []),
        ...(assistantCount > 0 ? [`${assistantCount} responses`] : []),
        ...(toolCount > 0 ? [`${toolCount} tool results`] : []),
      ].join(', ') || 'empty',
      turnCount: transcript.length,
    }

    const result = this.store.writeMemoryWithCas({
      address: FOREMAN_WORK_ADDRESS,
      version,
      corpus_json: JSON.stringify(corpus),
      min_event_seq: latestMemory ? latestMemory.max_event_seq + 1 : 1,
      max_event_seq: coversThroughSeq,
      token_estimate: cappedEstimate,
      expected_latest_version: latestMemory?.version ?? null,
    })

    if (result === -1) {
      // CAS conflict — another writer consolidated first, this is fine
    }
  }

  /**
   * Read WORK.md from the workspace root. Fails clearly if absent.
   */
  private readSystemPolicy(): string {
    const workMdPath = join(this.workspaceRoot, 'WORK.md')
    try {
      return readFileSync(workMdPath, 'utf-8')
    } catch {
      throw new Error(
        `WORK.md not found or unreadable at ${workMdPath}. ` +
        `WorkService startup requires WORK.md at the configured workspace root.`,
      )
    }
  }
}
