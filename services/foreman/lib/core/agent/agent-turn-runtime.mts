/**
 * AgentTurnRuntime — transport-neutral agent turn execution runtime.
 *
 * Provides per-address FIFO, single-flight tool-calling loop using a
 * BaseChatModel, assistant/tool history restore, turn terminal state,
 * turn deadline, no-progress cycle detection, cancel, and shutdown drain.
 * This is the single canonical turn loop shared by Work and FWA adapters.
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import type { AIMessageChunk } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DynamicStructuredTool } from '@langchain/core/tools'
import { Runnable } from '@langchain/core/runnables'
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base'
import type { BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import { createHash } from 'node:crypto'

// Fixed result text recorded for every delegation tool call. It carries no
// tool_call id by design: the turn ends immediately and the model is never
// invoked a second time, so the call is not echoed back as a ToolMessage.
const DELEGATION_RESULT_TEXT = 'Delegated to a background agent; the turn terminates here and will not continue.'

/**
 * System marker text that precedes every merged branch reply on the mainline.
 * Names the answered user message (durable seq + short preview) and states
 * that the reply completed out of order so later model context never mistakes
 * completion order for causality.
 */
function buildBranchMergeMarker(messageSeq: number, preview: string): string {
  return `[System marker: the reply below answers user message #${messageSeq} ("${preview}"). ` +
    'It completed out of order — branch replies are appended to the conversation in completion order, ' +
    'not submission order. Read each reply as answering the message seq named in its preceding marker.]'
}

// ─── Types ────────────────────────────────────────────────────────────

export type AgentTurnState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface AgentTranscriptEntry {
  seq: number
  role: 'human' | 'assistant' | 'tool' | 'system'
  content: string
  tool_calls?: Array<{
    id?: string
    name: string
    args: Record<string, unknown>
    type: 'tool_call'
  }>
  tool_call_id?: string
  tool_name?: string
  created_at: string
}

export interface QueuedTurn {
  turnSeq: number
  prompt: string
  from: string
  created_at: string
  /** Durable event seq of the message event that forked this turn. */
  messageSeq?: number
}

export interface TurnResult {
  turnSeq: number
  state: 'done' | 'failed' | 'cancelled'
  text?: string
  error?: string
}

export interface TurnUsage {
  input_tokens: number
  output_tokens: number
}

export interface TurnMetrics {
  /** Wall-clock turn duration in milliseconds. */
  duration_ms: number
  /** Accumulated token usage across model calls in the turn. Absent when the runtime reported none. */
  usage?: TurnUsage
}

// ─── Callbacks ────────────────────────────────────────────────────────

export interface AgentTurnCallbacks {
  /** Called for every event appended (message, assistant, tool_call, tool_result). */
  onEvent?: (entry: { kind: string; payload: Record<string, unknown>; turnSeq: number; seq: number }) => Promise<void>
  /** Called on turn state transition. */
  onTurnState?: (turnSeq: number, state: AgentTurnState, error?: string) => Promise<void>
  /** Called once when a turn finishes in the 'done' state with per-turn metrics. */
  onTurnCompleted?: (turnSeq: number, metrics: TurnMetrics, branchId?: string) => Promise<void>
  /** Called to persist refs (graph/task) changes. */
  onRefs?: (graphRefs: string[], taskRefs: string[]) => Promise<void>
}

// ─── Runtime options ──────────────────────────────────────────────────

export interface AgentTurnRuntimeOptions {
  /** Address this runtime serves. */
  address: string
  /** The bound model (with bindTools already applied or to be bound). */
  model: BaseChatModel
  /** LangChain tools. */
  tools: DynamicStructuredTool[]
  /** System policy / instruction. */
  systemPolicy: string
  /** Optional turn deadline in ms; covers the entire claimed turn. 0 disables. */
  turnTimeoutMs?: number
  /** Callbacks for persistence and state transitions. */
  callbacks?: AgentTurnCallbacks
  /** Restored transcript entries for context. */
  restoredTranscript?: AgentTranscriptEntry[]
  /** Restored graph refs. */
  restoredGraphRefs?: string[]
  /** Restored task refs. */
  restoredTaskRefs?: string[]
  /** Current conversation status. */
  restoredStatus?: 'idle' | 'running' | 'failed' | 'closed'
  /** Last error message. */
  restoredLastError?: string | null
  /**
   * Maximum concurrent branch turns (Work fork/merge model). 1 (the default)
   * restores exact FIFO serial semantics; > 1 runs each turn as an
   * independent branch that merges its reply into the mainline on completion.
   */
  maxConcurrentTurns?: number
}

// ─── Internal queue entry ─────────────────────────────────────────────

interface QueueEntry {
  turn: QueuedTurn
  resolve: (result: TurnResult) => void
}

// ─── Runtime ──────────────────────────────────────────────────────────

export class AgentTurnRuntime {
  private readonly address: string
  private model: BaseChatModel
  private readonly tools: DynamicStructuredTool[]
  private readonly systemPolicy: string
  private readonly turnTimeoutMs: number
  private readonly callbacks?: AgentTurnCallbacks

  /** Bound runnable (model + tools) for invocations. Rebuilt on setModel(). */
  private boundRunnable: Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions>

  private status: 'idle' | 'running' | 'failed' | 'closed' = 'idle'
  private queue: QueueEntry[] = []
  private transcript: AgentTranscriptEntry[] = []
  private activeTurnSeq: number | null = null
  private lastError: string | null = null
  private graphRefs: string[] = []
  private taskRefs: string[] = []
  private processing = false
  private closing = false
  private shutdownRequested = false
  private drainResolve: (() => void) | null = null
  private drainPromise: Promise<void> | null = null
  private shutdownPromise: Promise<void> | null = null

  private readonly maxConcurrentTurns: number
  /** Number of branch turns currently in flight. */
  private runningBranches = 0
  /** Monotonic mainline transcript seq (branch mode only; never reused). */
  private mainlineSeq = 0
  /** Active concurrent pump (set while flushConcurrent is draining). */
  private concurrentPump: (() => void) | null = null
  /** Resolves when a concurrent drain fully empties the queue. */
  private concurrentDoneResolve: (() => void) | null = null

  constructor(options: AgentTurnRuntimeOptions) {
    this.address = options.address
    this.model = options.model
    this.tools = options.tools
    this.systemPolicy = options.systemPolicy
    this.turnTimeoutMs = options.turnTimeoutMs ?? 0
    this.callbacks = options.callbacks
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? 1

    this.boundRunnable = this.buildBoundRunnable(this.model)

    if (options.restoredTranscript) this.transcript = [...options.restoredTranscript]
    if (options.restoredGraphRefs) this.graphRefs = [...options.restoredGraphRefs]
    if (options.restoredTaskRefs) this.taskRefs = [...options.restoredTaskRefs]
    if (options.restoredStatus) this.status = options.restoredStatus
    if (options.restoredLastError !== undefined && options.restoredLastError !== null) {
      this.lastError = options.restoredLastError
    }
  }

  /**
   * Hot-swap the model used by this runtime. Subsequent model invocations
   * (and subsequent turns) use the new model. Tools are re-bound.
   */
  setModel(model: BaseChatModel): void {
    this.model = model
    this.boundRunnable = this.buildBoundRunnable(model)
  }

  private buildBoundRunnable(model: BaseChatModel): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    if (typeof (model as any).bindTools === 'function') {
      return (model as any).bindTools(this.tools)
    }
    if (this.tools.length === 0) {
      return model as unknown as Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions>
    }
    throw new Error('Model does not support bindTools, cannot bind tools')
  }

  // ─── Public API ─────────────────────────────────────────────────────

  getStatus(): string { return this.status }

  getTranscript(): AgentTranscriptEntry[] { return [...this.transcript] }

  getGraphRefs(): string[] { return [...this.graphRefs] }

  getTaskRefs(): string[] { return [...this.taskRefs] }

  getQueueDepth(): number { return this.queue.length }

  getActiveTurnSeq(): number | null { return this.activeTurnSeq }

  /** Number of branch turns currently running (0 in serial FIFO mode). */
  getRunningBranchCount(): number { return this.runningBranches }

  getLastError(): string | null { return this.lastError }

  getAddress(): string { return this.address }

  /** Resolve how a named tool is executed: 'delegation' iff its tool metadata says so. */
  private getExecutionMode(toolName: string): 'inline' | 'delegation' {
    const tool = this.tools.find((t) => t.name === toolName)
    if (!tool) return 'inline'
    const mode = (tool as unknown as { metadata?: { executionMode?: string } }).metadata?.executionMode
    return mode === 'delegation' ? 'delegation' : 'inline'
  }

  async mergeRefs(graphRefs: string[], taskRefs: string[]): Promise<void> {
    const newGraphRefs = [...new Set(graphRefs)].filter(r => !this.graphRefs.includes(r))
    const newTaskRefs = [...new Set(taskRefs)].filter(r => !this.taskRefs.includes(r))
    if (newGraphRefs.length === 0 && newTaskRefs.length === 0) return
    if (newGraphRefs.length > 0) this.graphRefs.push(...newGraphRefs)
    if (newTaskRefs.length > 0) this.taskRefs.push(...newTaskRefs)
    await this.callbacks?.onRefs?.([...this.graphRefs], [...this.taskRefs])
  }

  /**
   * Enqueue a turn. Returns a promise that resolves with the turn result.
   * If idle, starts processing immediately. If busy, queued for later.
   */
  enqueue(turn: QueuedTurn): Promise<TurnResult> {
    if (this.status === 'closed' || this.closing || this.shutdownRequested) {
      throw new Error(`Runtime ${this.address} is closed, cannot enqueue turn`)
    }
    return new Promise<TurnResult>((resolve) => {
      this.queue.push({ turn, resolve })
      if (this.processing) {
        // A drain is already running. Wake the concurrent pump so the newly
        // queued turn can launch into a free slot immediately (no-op in
        // serial mode, where the serial loop re-checks the queue itself).
        this.concurrentPump?.()
        return
      }
      // A stale 'running' status (restored after restart, or left behind by a
      // completed drain) must not block newly queued turns — start a flush.
      if (this.status === 'failed') {
        this.lastError = null
        this.status = 'idle'
      } else if (this.status === 'running') {
        this.status = 'idle'
      }
      this.flushQueue().catch(() => {})
    })
  }

  /** Mark as failed without a specific error. No-op when closed. */
  fail(error: string): void {
    if (this.status === 'closed') return
    this.status = 'failed'
    this.lastError = error
    this.callbacks?.onTurnState?.(-1, 'failed', error)?.catch(() => {})
    if (!this.processing && this.queue.length > 0) {
      this.flushQueue().catch(() => {})
    }
  }

  /** Shutdown: drain queue, reject new admissions. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.status === 'closed') return
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.#shutdownImpl()
    return this.shutdownPromise
  }

  async #shutdownImpl(): Promise<void> {
    this.shutdownRequested = true
    if (this.queue.length > 0 && !this.processing) {
      this.flushQueue().catch(() => {})
    }
    if (this.processing || this.queue.length > 0) {
      if (!this.drainPromise) {
        this.drainPromise = new Promise<void>((resolve) => { this.drainResolve = resolve })
      }
      await this.drainPromise
    }
    this.closing = true
  }

  /** Close the runtime, draining first. Idempotent. */
  async close(): Promise<void> {
    if (this.status === 'closed') return
    await this.shutdown()
    this.status = 'closed'
  }

  /**
   * Cancel the currently active turn. Sets state to cancelled and
   * removes it from the queue. The model loop will pick up the signal
   * on next iteration or timeout.
   */
  cancelActiveTurn(): void {
    if (this.activeTurnSeq !== null) {
      const entry = this.queue.find(e => e.turn.turnSeq === this.activeTurnSeq)
      if (entry) {
        entry.resolve({ turnSeq: entry.turn.turnSeq, state: 'cancelled', error: 'turn cancelled' })
        this.queue = this.queue.filter(e => e.turn.turnSeq !== this.activeTurnSeq)
      }
      this.activeTurnSeq = null
    }
  }

  // ─── Private: FIFO queue processing ─────────────────────────────────

  private async flushQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      if (this.maxConcurrentTurns > 1) {
        await this.flushConcurrent()
      } else {
        await this.flushSerial()
      }
    } finally {
      this.processing = false
      if (this.queue.length === 0 && this.drainResolve) {
        this.drainResolve()
        this.drainResolve = null
        this.drainPromise = null
      }
    }
  }

  /** Exact legacy FIFO serial drain. */
  private async flushSerial(): Promise<void> {
    let keepFlushing = true
    let hadFailure = false
    while (keepFlushing) {
      while (this.queue.length > 0 && this.status !== 'closed') {
        if (this.status === 'failed') break

        const entry = this.queue.shift()!
        try {
          const result = await this.runTurn(entry)
          entry.resolve(result)
        } catch (error) {
          hadFailure = true
          if ((this.status as string) !== 'failed') {
            this.status = 'failed'
            this.lastError = error instanceof Error ? error.message : String(error)
            this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'failed', this.lastError)?.catch(() => {})
          }
          const errMsg = error instanceof Error ? error.message : String(error)
          entry.resolve({ turnSeq: entry.turn.turnSeq, state: 'failed', error: errMsg })
          this.rejectAllQueued()
          break
        }
      }
      if (this.status === 'failed' && this.queue.length > 0) {
        hadFailure = true
        this.rejectAllQueued()
      }
      keepFlushing = false
      if (!hadFailure && this.status !== 'closed' && (this.status as string) !== 'failed') {
        this.status = 'idle'
        if (this.queue.length > 0) keepFlushing = true
      }
    }
  }

  /**
   * Concurrent branch drain. Launches up to maxConcurrentTurns branch turns at
   * once (FIFO admission order). Each turn runs independently against a
   * snapshot of the mainline transcript; branch failures are isolated and do
   * not abort sibling branches. Branches that throw (callback errors) fail
   * the runtime and reject the remaining queue, mirroring serial semantics.
   */
  private async flushConcurrent(): Promise<void> {
    const max = Math.max(1, this.maxConcurrentTurns)
    const active = new Set<Promise<unknown>>()

    const tryFinish = (): void => {
      if (this.queue.length === 0 && active.size === 0 && this.concurrentDoneResolve) {
        const resolve = this.concurrentDoneResolve
        this.concurrentDoneResolve = null
        resolve()
      }
    }

    const runOne = (entry: QueueEntry): Promise<unknown> => {
      const promise = (async () => {
        try {
          const result = await this.runBranchTurn(entry)
          entry.resolve(result)
        } catch (error) {
          this.status = 'failed'
          this.lastError = error instanceof Error ? error.message : String(error)
          this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'failed', this.lastError)?.catch(() => {})
          entry.resolve({ turnSeq: entry.turn.turnSeq, state: 'failed', error: this.lastError })
        }
      })()
      return promise
    }

    const pump = (): void => {
      while (this.queue.length > 0 && active.size < max && this.status !== 'closed' && this.status !== 'failed') {
        const entry = this.queue.shift()!
        const p = runOne(entry)
        active.add(p)
        const settle = (): void => {
          active.delete(p)
          pump()
          tryFinish()
        }
        p.then(settle, settle)
      }
      tryFinish()
    }

    this.concurrentPump = pump
    try {
      pump()
      if (this.queue.length > 0 || active.size > 0) {
        await new Promise<void>((resolve) => {
          this.concurrentDoneResolve = resolve
          tryFinish()
        })
      }
    } finally {
      this.concurrentPump = null
      this.concurrentDoneResolve = null
    }
    if (this.status === 'failed') {
      this.rejectAllQueued()
    } else if (this.status !== 'closed') {
      this.status = 'idle'
    }
  }

  private rejectAllQueued(): void {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!
      entry.resolve({
        turnSeq: entry.turn.turnSeq,
        state: 'failed',
        error: `Runtime ${this.address} failed, rejecting queued turn`,
      })
    }
  }

  // ─── Private: single turn tool loop ─────────────────────────────────

  private async runTurn(entry: QueueEntry): Promise<TurnResult> {
    this.activeTurnSeq = entry.turn.turnSeq
    this.status = 'running'

    // Snapshot transcript length before adding this turn's entries
    const transcriptSnapshotLen = this.transcript.length

    // Per-turn metrics
    const turnStartedAt = Date.now()
    let turnInputTokens = 0
    let turnOutputTokens = 0

    try {
      await this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'running')

      // Record human turn as a transcript entry
      const humanEntry: AgentTranscriptEntry = {
        seq: this.transcript.length + 1,
        role: 'human',
        content: entry.turn.prompt,
        created_at: entry.turn.created_at,
      }
      this.transcript.push(humanEntry)

      const messages: any[] = [new SystemMessage(this.systemPolicy)]

      // Restore transcript context (excluding the human entry we just added)
      appendRestoredTranscript(messages, this.transcript.slice(0, -1))

      messages.push(new HumanMessage(entry.turn.prompt))

      // One deadline covering the entire claimed turn; 0 disables it.
      const turnDeadlineAt = this.turnTimeoutMs > 0 ? Date.now() + this.turnTimeoutMs : Number.POSITIVE_INFINITY
      const cycleDetector = new NoProgressCycleDetector()

      for (;;) {
        const remainingMs = turnDeadlineAt - Date.now()
        if (remainingMs <= 0) {
          throw new Error(`Turn timed out after ${this.turnTimeoutMs}ms`)
        }

        // Invoke the model, racing against the time left until the turn deadline
        let response: any
        if (Number.isFinite(remainingMs)) {
          let timeoutHandle: NodeJS.Timeout | undefined
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new Error(`Turn timed out after ${this.turnTimeoutMs}ms`))
            }, remainingMs)
            timeoutHandle.unref()
          })
          try {
            response = await Promise.race([this.boundRunnable.invoke(messages), timeoutPromise]) as AIMessage
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle)
          }
        } else {
          response = await this.boundRunnable.invoke(messages) as AIMessage
        }

        // Accumulate runtime-reported token usage for this turn (when present).
        const usageMetadata = (response as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata
        if (usageMetadata) {
          const input = typeof usageMetadata.input_tokens === 'number' ? usageMetadata.input_tokens : 0
          const output = typeof usageMetadata.output_tokens === 'number' ? usageMetadata.output_tokens : 0
          if (input > 0 || output > 0) {
            turnInputTokens += input
            turnOutputTokens += output
          }
        }

        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content)
        const toolCalls = response.tool_calls?.map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          args: typeof tc.args === 'string' ? JSON.parse(tc.args) as Record<string, unknown> : tc.args,
          type: 'tool_call' as const,
        }))

        // Record assistant entry
        const assistantEntry: AgentTranscriptEntry = {
          seq: this.transcript.length + 1,
          role: 'assistant',
          content,
          tool_calls: toolCalls,
          created_at: new Date().toISOString(),
        }
        this.transcript.push(assistantEntry)

        await this.callbacks?.onEvent?.({
          kind: 'assistant',
          payload: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
          turnSeq: entry.turn.turnSeq,
          seq: assistantEntry.seq,
        })

        messages.push(response)

        if (response.tool_calls?.length) {
          // Partition tool calls: inline calls run in-turn (and feed the model
          // again if no delegation occurred), delegation calls hand off and
          // terminate the turn. Inline calls execute first, in order.
          const inlineCalls: any[] = []
          const delegationCalls: any[] = []
          for (const tc of response.tool_calls) {
            if (this.getExecutionMode(tc.name) === 'delegation') {
              delegationCalls.push(tc)
            } else {
              inlineCalls.push(tc)
            }
          }

          // Inline calls execute first, in order.
          for (const tc of inlineCalls) {
            if (!tc.id) {
              throw new Error(`Tool call ${tc.name} is missing an id`)
            }
            const tool = this.tools.find((t) => t.name === tc.name)
            if (!tool) {
              throw new Error(`Unknown tool call: ${tc.name}`)
            }

            let args: Record<string, unknown>
            try {
              args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args
            } catch {
              throw new Error(`Invalid tool args JSON for ${tc.name}: ${tc.args}`)
            }

            await this.callbacks?.onEvent?.({
              kind: 'tool_call',
              payload: {
                role: 'assistant',
                tool_call_id: tc.id,
                tool_name: tc.name,
                args,
              },
              turnSeq: entry.turn.turnSeq,
              seq: this.transcript.length,
            })

            let result: string
            try {
              result = await tool.invoke(args as Record<string, unknown>)
            } catch (error) {
              result = `Error calling ${tc.name}: ${error instanceof Error ? error.message : String(error)}`
            }

            cycleDetector.record(tc.name, args, result)

            // Record tool result
            const toolEntry: AgentTranscriptEntry = {
              seq: this.transcript.length + 1,
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
              tool_name: tc.name,
              created_at: new Date().toISOString(),
            }
            this.transcript.push(toolEntry)

            await this.callbacks?.onEvent?.({
              kind: 'tool_result',
              payload: { role: 'tool', content: result, tool_call_id: tc.id, tool_name: tc.name },
              turnSeq: entry.turn.turnSeq,
              seq: toolEntry.seq,
            })

            messages.push(new ToolMessage({
              content: result,
              tool_call_id: tc.id,
              name: tc.name,
            }))
          }

          // Any delegation call ends the turn immediately. A fixed-text result
          // (without ids) is recorded for every delegation call and the model is
          // not invoked a second time. Delegation tool errors propagate to the
          // outer catch and produce a failed turn.
          if (delegationCalls.length > 0) {
            for (const tc of delegationCalls) {
              if (!tc.id) {
                throw new Error(`Tool call ${tc.name} is missing an id`)
              }
              const tool = this.tools.find((t) => t.name === tc.name)
              if (!tool) {
                throw new Error(`Unknown tool call: ${tc.name}`)
              }

              let args: Record<string, unknown>
              try {
                args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args
              } catch {
                throw new Error(`Invalid tool args JSON for ${tc.name}: ${tc.args}`)
              }

              await this.callbacks?.onEvent?.({
                kind: 'tool_call',
                payload: {
                  role: 'assistant',
                  tool_call_id: tc.id,
                  tool_name: tc.name,
                  args,
                },
                turnSeq: entry.turn.turnSeq,
                seq: this.transcript.length,
              })

              // Await the delegation tool exactly once. Errors propagate to the
              // outer catch (failed turn path).
              const delegationResult = await tool.invoke(args as Record<string, unknown>)

              // On success, record the fixed handle-free receipt (no tool_call_id).
              const toolEntry: AgentTranscriptEntry = {
                seq: this.transcript.length + 1,
                role: 'tool',
                content: DELEGATION_RESULT_TEXT,
                tool_name: tc.name,
                created_at: new Date().toISOString(),
              }
              this.transcript.push(toolEntry)

              await this.callbacks?.onEvent?.({
                kind: 'tool_result',
                payload: { role: 'tool', content: DELEGATION_RESULT_TEXT, tool_name: tc.name },
                turnSeq: entry.turn.turnSeq,
                seq: toolEntry.seq,
              })
            }
            this.activeTurnSeq = null
            await this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'done')
            await this.completeTurnMetrics(entry.turn.turnSeq, turnStartedAt, turnInputTokens, turnOutputTokens)
            return { turnSeq: entry.turn.turnSeq, state: 'done', text: content }
          }
        } else {
          // No tool calls — turn complete
          this.activeTurnSeq = null
          await this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'done')
          await this.completeTurnMetrics(entry.turn.turnSeq, turnStartedAt, turnInputTokens, turnOutputTokens)
          return { turnSeq: entry.turn.turnSeq, state: 'done', text: content }
        }
      }
    } catch (error) {
      this.activeTurnSeq = null
      this.status = 'failed'
      const errMsg = error instanceof Error ? error.message : String(error)
      // Roll back transcript to snapshot to remove failed turn entries from model context
      this.transcript.length = transcriptSnapshotLen
      await this.callbacks?.onEvent?.({
        kind: 'assistant',
        payload: {
          role: 'assistant',
          content: `Turn failed: ${errMsg}`,
          error: true,
        },
        turnSeq: entry.turn.turnSeq,
        seq: this.transcript.length + 1,
      })
      await this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'failed', errMsg)
      return { turnSeq: entry.turn.turnSeq, state: 'failed', error: errMsg }
    }
  }

  /**
   * Emit per-turn completion metrics (duration + accumulated usage) via the
   * onTurnCompleted callback. Usage is included only when the runtime actually
   * reported token numbers — never fabricated.
   */
  private async completeTurnMetrics(
    turnSeq: number,
    turnStartedAt: number,
    inputTokens: number,
    outputTokens: number,
    branchId?: string,
  ): Promise<void> {
    const metrics: TurnMetrics = {
      duration_ms: Date.now() - turnStartedAt,
    }
    if (inputTokens > 0 || outputTokens > 0) {
      metrics.usage = { input_tokens: inputTokens, output_tokens: outputTokens }
    }
    await this.callbacks?.onTurnCompleted?.(turnSeq, metrics, branchId)
  }

  // ─── Private: concurrent branch turn (fork → merge) ─────────────────

  /**
   * Run a single turn as an independent branch.
   *
   * Fork: the branch snapshots the mainline transcript at this moment and
   * appends its own user message; concurrent branches never observe each
   * other. Merge: on completion the final reply is appended to the mainline
   * preceded by a system marker naming the answered message seq, and the
   * reply is annotated with a turn_merged event. Branch-scoped events
   * (assistant/tool_call/tool_result) carry branch_id. A failing branch emits
   * turn_failed and does not touch the mainline beyond the user message it
   * already added.
   */
  private async runBranchTurn(entry: QueueEntry): Promise<TurnResult> {
    const branchId = `b${entry.turn.turnSeq}`
    const messageSeq = entry.turn.messageSeq ?? 0
    const preview = entry.turn.prompt.slice(0, 80)
    const humanEntry: AgentTranscriptEntry = {
      seq: 0,
      role: 'human',
      content: entry.turn.prompt,
      created_at: entry.turn.created_at,
    }
    this.runningBranches++
    try {
      humanEntry.seq = ++this.mainlineSeq
      this.transcript.push(humanEntry)
      // Snapshot synchronously so later forks never see this branch in-flight.
      const local: AgentTranscriptEntry[] = [...this.transcript]

      // Mark the runtime running synchronously so the status is observable
      // (e.g. by transcript readers) as soon as the turn is admitted, matching
      // the serial path where status flips during admission.
      this.activeTurnSeq = entry.turn.turnSeq
      this.status = 'running'

      await this.callbacks?.onEvent?.({
        kind: 'turn_forked',
        payload: {
          turn_seq: entry.turn.turnSeq,
          branch_id: branchId,
          forked_at_seq: messageSeq,
          preview,
        },
        turnSeq: entry.turn.turnSeq,
        seq: humanEntry.seq,
      })

      await this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'running')

      // Per-branch metrics
      const turnStartedAt = Date.now()
      let turnInputTokens = 0
      let turnOutputTokens = 0

      const messages: any[] = [new SystemMessage(this.systemPolicy)]
      appendRestoredTranscript(messages, local.slice(0, -1))
      messages.push(new HumanMessage(entry.turn.prompt))

      const turnDeadlineAt = this.turnTimeoutMs > 0 ? Date.now() + this.turnTimeoutMs : Number.POSITIVE_INFINITY
      const cycleDetector = new NoProgressCycleDetector()
      let finalContent = ''

      for (;;) {
        const remainingMs = turnDeadlineAt - Date.now()
        if (remainingMs <= 0) {
          throw new Error(`Turn timed out after ${this.turnTimeoutMs}ms`)
        }

        let response: any
        if (Number.isFinite(remainingMs)) {
          let timeoutHandle: NodeJS.Timeout | undefined
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new Error(`Turn timed out after ${this.turnTimeoutMs}ms`))
            }, remainingMs)
            timeoutHandle.unref()
          })
          try {
            response = await Promise.race([this.boundRunnable.invoke(messages), timeoutPromise]) as AIMessage
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle)
          }
        } else {
          response = await this.boundRunnable.invoke(messages) as AIMessage
        }

        const usageMetadata = (response as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata
        if (usageMetadata) {
          const input = typeof usageMetadata.input_tokens === 'number' ? usageMetadata.input_tokens : 0
          const output = typeof usageMetadata.output_tokens === 'number' ? usageMetadata.output_tokens : 0
          if (input > 0 || output > 0) {
            turnInputTokens += input
            turnOutputTokens += output
          }
        }

        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content)
        const toolCalls = response.tool_calls?.map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          args: typeof tc.args === 'string' ? JSON.parse(tc.args) as Record<string, unknown> : tc.args,
          type: 'tool_call' as const,
        }))

        const assistantEntry: AgentTranscriptEntry = {
          seq: local.length + 1,
          role: 'assistant',
          content,
          tool_calls: toolCalls,
          created_at: new Date().toISOString(),
        }
        local.push(assistantEntry)

        await this.emitBranchEvent({
          kind: 'assistant',
          payload: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
          turnSeq: entry.turn.turnSeq,
          branchId,
          seq: assistantEntry.seq,
        })

        messages.push(response)

        if (response.tool_calls?.length) {
          const inlineCalls: any[] = []
          const delegationCalls: any[] = []
          for (const tc of response.tool_calls) {
            if (this.getExecutionMode(tc.name) === 'delegation') {
              delegationCalls.push(tc)
            } else {
              inlineCalls.push(tc)
            }
          }

          for (const tc of inlineCalls) {
            if (!tc.id) {
              throw new Error(`Tool call ${tc.name} is missing an id`)
            }
            const tool = this.tools.find((t) => t.name === tc.name)
            if (!tool) {
              throw new Error(`Unknown tool call: ${tc.name}`)
            }

            let args: Record<string, unknown>
            try {
              args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args
            } catch {
              throw new Error(`Invalid tool args JSON for ${tc.name}: ${tc.args}`)
            }

            await this.emitBranchEvent({
              kind: 'tool_call',
              payload: { role: 'assistant', tool_call_id: tc.id, tool_name: tc.name, args },
              turnSeq: entry.turn.turnSeq,
              branchId,
              seq: local.length,
            })

            let result: string
            try {
              result = await tool.invoke(args as Record<string, unknown>)
            } catch (error) {
              result = `Error calling ${tc.name}: ${error instanceof Error ? error.message : String(error)}`
            }

            cycleDetector.record(tc.name, args, result)

            const toolEntry: AgentTranscriptEntry = {
              seq: local.length + 1,
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
              tool_name: tc.name,
              created_at: new Date().toISOString(),
            }
            local.push(toolEntry)

            await this.emitBranchEvent({
              kind: 'tool_result',
              payload: { role: 'tool', content: result, tool_call_id: tc.id, tool_name: tc.name },
              turnSeq: entry.turn.turnSeq,
              branchId,
              seq: toolEntry.seq,
            })

            messages.push(new ToolMessage({
              content: result,
              tool_call_id: tc.id,
              name: tc.name,
            }))
          }

          if (delegationCalls.length > 0) {
            for (const tc of delegationCalls) {
              if (!tc.id) {
                throw new Error(`Tool call ${tc.name} is missing an id`)
              }
              const tool = this.tools.find((t) => t.name === tc.name)
              if (!tool) {
                throw new Error(`Unknown tool call: ${tc.name}`)
              }

              let args: Record<string, unknown>
              try {
                args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args
              } catch {
                throw new Error(`Invalid tool args JSON for ${tc.name}: ${tc.args}`)
              }

              await this.emitBranchEvent({
                kind: 'tool_call',
                payload: { role: 'assistant', tool_call_id: tc.id, tool_name: tc.name, args },
                turnSeq: entry.turn.turnSeq,
                branchId,
                seq: local.length,
              })

              const delegationResult = await tool.invoke(args as Record<string, unknown>)

              const toolEntry: AgentTranscriptEntry = {
                seq: local.length + 1,
                role: 'tool',
                content: DELEGATION_RESULT_TEXT,
                tool_name: tc.name,
                created_at: new Date().toISOString(),
              }
              local.push(toolEntry)

              await this.emitBranchEvent({
                kind: 'tool_result',
                payload: { role: 'tool', content: DELEGATION_RESULT_TEXT, tool_name: tc.name },
                turnSeq: entry.turn.turnSeq,
                branchId,
                seq: toolEntry.seq,
              })
            }
            finalContent = content
            break
          }
        } else {
          finalContent = content
          break
        }
      }

      // ─── Merge into the mainline in completion order ───
      const markerText = buildBranchMergeMarker(messageSeq, preview)
      const markerEntry: AgentTranscriptEntry = {
        seq: ++this.mainlineSeq,
        role: 'system',
        content: markerText,
        created_at: new Date().toISOString(),
      }
      this.transcript.push(markerEntry)

      const replyEntry: AgentTranscriptEntry = {
        seq: ++this.mainlineSeq,
        role: 'assistant',
        content: finalContent,
        created_at: new Date().toISOString(),
      }
      this.transcript.push(replyEntry)

      await this.callbacks?.onEvent?.({
        kind: 'message',
        payload: { role: 'system', content: markerText, from: 'system' },
        turnSeq: entry.turn.turnSeq,
        seq: markerEntry.seq,
      })
      await this.callbacks?.onEvent?.({
        kind: 'assistant',
        payload: { role: 'assistant', content: finalContent },
        turnSeq: entry.turn.turnSeq,
        seq: replyEntry.seq,
      })
      await this.callbacks?.onEvent?.({
        kind: 'turn_merged',
        payload: { turn_seq: entry.turn.turnSeq, branch_id: branchId, answer_to_seq: messageSeq },
        turnSeq: entry.turn.turnSeq,
        seq: replyEntry.seq,
      })

      this.activeTurnSeq = null
      await this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'done')
      await this.completeTurnMetrics(entry.turn.turnSeq, turnStartedAt, turnInputTokens, turnOutputTokens, branchId)
      return { turnSeq: entry.turn.turnSeq, state: 'done', text: finalContent }
    } catch (error) {
      this.activeTurnSeq = null
      const errMsg = error instanceof Error ? error.message : String(error)
      // Remove the branch's own user message from the mainline (mirrors the
      // serial rollback) so a failed branch leaves no orphaned context.
      const humanIdx = this.transcript.indexOf(humanEntry)
      if (humanIdx !== -1) this.transcript.splice(humanIdx, 1)
      await this.callbacks?.onEvent?.({
        kind: 'turn_failed',
        payload: { turn_seq: entry.turn.turnSeq, branch_id: branchId, error: errMsg },
        turnSeq: entry.turn.turnSeq,
        seq: this.transcript.length,
      })
      await this.callbacks?.onTurnState?.(entry.turn.turnSeq, 'failed', errMsg)
      return { turnSeq: entry.turn.turnSeq, state: 'failed', error: errMsg }
    } finally {
      this.runningBranches--
    }
  }

  /** Emit a branch-scoped event carrying branch_id for clients. */
  private async emitBranchEvent(params: {
    kind: string
    payload: Record<string, unknown>
    turnSeq: number
    branchId: string
    seq: number
  }): Promise<void> {
    await this.callbacks?.onEvent?.({
      kind: params.kind,
      payload: { ...params.payload, branch_id: params.branchId },
      turnSeq: params.turnSeq,
      seq: params.seq,
    })
  }
}

// ─── No-progress cycle detector ───────────────────────────────────────

const CYCLE_FINGERPRINT_WINDOW = 16
const CYCLE_MAX_PERIOD = 4
const CYCLE_REPEAT_COUNT = 3
const CYCLE_RESULT_BOUND = 1024

/**
 * Detects deterministic no-progress tool loops. Each tool call is
 * fingerprinted by SHA-256 over the tool name, canonical (key-sorted)
 * args, and a bounded whitespace-normalized result. The detector keeps
 * the last 16 fingerprints and fails the turn when the tail consists of
 * a period-1..4 sequence repeated 3 consecutive times.
 */
class NoProgressCycleDetector {
  private fingerprints: string[] = []

  record(toolName: string, args: Record<string, unknown>, result: string): void {
    this.fingerprints.push(fingerprintToolCall(toolName, args, result))
    if (this.fingerprints.length > CYCLE_FINGERPRINT_WINDOW) {
      this.fingerprints.shift()
    }
    for (let period = 1; period <= CYCLE_MAX_PERIOD; period++) {
      if (this.hasRepeatingPeriod(period)) {
        throw new Error(
          `No-progress cycle detected: tool calls repeat with period ${period} (${CYCLE_REPEAT_COUNT} consecutive repeats)`,
        )
      }
    }
  }

  private hasRepeatingPeriod(period: number): boolean {
    const needed = period * CYCLE_REPEAT_COUNT
    if (this.fingerprints.length < needed) return false
    const tail = this.fingerprints.slice(this.fingerprints.length - needed)
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== tail[i % period]) return false
    }
    return true
  }
}

function fingerprintToolCall(toolName: string, args: Record<string, unknown>, result: string): string {
  const normalizedResult = result.replace(/\s+/g, ' ').trim().slice(0, CYCLE_RESULT_BOUND)
  const hash = createHash('sha256')
  hash.update(toolName)
  hash.update('\n')
  hash.update(canonicalStringify(args))
  hash.update('\n')
  hash.update(normalizedResult)
  return hash.digest('hex')
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`)
  return `{${entries.join(',')}}`
}

// ─── Transcript restore helper ────────────────────────────────────────

function appendRestoredTranscript(messages: any[], transcript: AgentTranscriptEntry[]): void {
  let index = 0
  while (index < transcript.length) {
    const entry = transcript[index]
    if (entry.role === 'system') {
      if (entry.content.trim()) {
        messages.push(new SystemMessage(entry.content))
      }
      index++
      continue
    }

    if (entry.role === 'human') {
      messages.push(new HumanMessage(entry.content))
      index++
      continue
    }

    if (entry.role === 'assistant') {
      const toolCalls = entry.tool_calls ?? []
      if (toolCalls.length === 0) {
        if (entry.content.trim()) {
          messages.push(new AIMessage(entry.content))
        }
        index++
        continue
      }

      const followingTools: AgentTranscriptEntry[] = []
      let next = index + 1
      while (next < transcript.length && transcript[next].role === 'tool') {
        followingTools.push(transcript[next])
        next++
      }
      const expectedIds = new Set(toolCalls.map((call) => call.id).filter((id): id is string => Boolean(id)))
      const actualIds = new Set(followingTools.map((tool) => tool.tool_call_id).filter((id): id is string => Boolean(id)))
      const complete = expectedIds.size === toolCalls.length
        && expectedIds.size === actualIds.size
        && [...expectedIds].every((id) => actualIds.has(id))

      if (complete) {
        messages.push(new AIMessage({
          content: entry.content,
          tool_calls: toolCalls,
        }))
        for (const tool of followingTools) {
          messages.push(new ToolMessage({
            content: tool.content,
            tool_call_id: tool.tool_call_id!,
            ...(tool.tool_name ? { name: tool.tool_name } : {}),
          }))
        }
      }
      index = next
      continue
    }

    index++
  }
}
