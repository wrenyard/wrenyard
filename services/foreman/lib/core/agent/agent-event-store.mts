/**
 * AgentEventStore — durable event/turn store on top of agent_event, agent_turn,
 * and agent_conversation tables. Manages per-address monotonic event seq,
 * turn seq, cursor sync with bounded long-poll, compact, and recovery.
 */

import type { ForemanDatabase } from '../../db/types.mts'

// ─── Record types ─────────────────────────────────────────────────────

export interface AgentConversationRecord {
  address: string
  kind: 'fwa' | 'work'
  status: 'idle' | 'running' | 'failed' | 'closed'
  model: string
  next_event_seq: number
  next_turn_seq: number
  system_policy: string | null
  created_at: string
  updated_at: string
}

export interface AgentTurnRecord {
  address: string
  turn_seq: number
  message_id: string | null
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  prompt_text: string | null
  origin: 'human' | 'system_completion'
  origin_delegation_id: string | null
  started_at: string | null
  ended_at: string | null
  error: string | null
  created_at: string
}

export interface AgentEventRecord {
  address: string
  seq: number
  turn_seq: number | null
  kind: 'message' | 'assistant' | 'tool_call' | 'tool_result' | 'compact'
    | 'graph_snapshot' | 'graph_patch_proposal' | 'graph_patch_status' | 'delegation_terminal'
    | 'turn_completed' | 'turn_forked' | 'turn_merged' | 'turn_failed'
  payload_json: string
  compact_covers_through_seq: number | null
  compact_summary: string | null
  created_at: string
}

// ─── Delegation types ────────────────────────────────────────────────

export type TurnOrigin = 'human' | 'system_completion'

export interface AgentDelegationRecord {
  address: string
  turn_seq: number
  delegation_id: string
  tool_name: string
  input_json: string
  resource_id: string
  status: 'pending' | 'terminal'
  created_at: string
}

// ─── Memory types ────────────────────────────────────────────────────

export interface AgentMemoryRecord {
  address: string
  seq: number
  version: string
  corpus_json: string
  min_event_seq: number
  max_event_seq: number
  token_estimate: number | null
  created_at: string
}

// ─── Cursor / sync types ──────────────────────────────────────────────

export interface SyncResult {
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
}

export interface CompactResult {
  compact_seq: number
  covers_through_seq: number
}

// ─── Wake / long-poll ─────────────────────────────────────────────────

interface WakeWatcher {
  resolve: () => void
  timeout: NodeJS.Timeout
}

// ─── Store ────────────────────────────────────────────────────────────

export class AgentEventStore {
  private readonly db: ForemanDatabase
  private readonly watchers = new Map<string, WakeWatcher[]>()

  constructor(db: ForemanDatabase) {
    this.db = db
  }

  // ─── Conversation ───────────────────────────────────────────────────

  getConversation(address: string): AgentConversationRecord | undefined {
    return this.db.prepare<[string], AgentConversationRecord>(
      `SELECT * FROM agent_conversation WHERE address = ?`,
    ).get(address) ?? undefined
  }

  listConversations(): AgentConversationRecord[] {
    return this.db.prepare<[], AgentConversationRecord>(
      `SELECT * FROM agent_conversation ORDER BY created_at DESC`,
    ).all()
  }

  createOrGetConversation(params: {
    address: string
    kind: 'fwa' | 'work'
    model: string
    system_policy?: string
    created_at?: string
  }): AgentConversationRecord {
    const existing = this.getConversation(params.address)
    if (existing) return existing
    const now = params.created_at ?? new Date().toISOString()
    this.db.prepare(
      `INSERT OR IGNORE INTO agent_conversation (address, kind, status, model, next_event_seq, next_turn_seq, system_policy, created_at, updated_at)
       VALUES (?, ?, 'idle', ?, 1, 1, ?, ?, ?)`,
    ).run(params.address, params.kind, params.model, params.system_policy ?? null, now, now)
    return this.getConversation(params.address)!
  }

  updateConversationStatus(address: string, status: AgentConversationRecord['status']): void {
    this.db.prepare(
      `UPDATE agent_conversation SET status = ?, updated_at = ? WHERE address = ?`,
    ).run(status, new Date().toISOString(), address)
  }

  /**
   * Persist a runtime model switch on the conversation row.
   */
  updateConversationModel(address: string, model: string): void {
    this.db.prepare(
      `UPDATE agent_conversation SET model = ?, updated_at = ? WHERE address = ?`,
    ).run(model, new Date().toISOString(), address)
  }

  // ─── Recovery ───────────────────────────────────────────────────────

  /**
   * On daemon startup, scan for any agent_turn rows with state='running'
   * that have no terminal event (done/failed/cancelled). Reset them to
   * 'queued' so the runtime can claim and retry them.
   */
  recoverStaleTurns(): AgentTurnRecord[] {
    const stale = this.db.prepare<[], AgentTurnRecord>(
      `SELECT * FROM agent_turn WHERE state = 'running'`,
    ).all()

    if (stale.length === 0) return []

    this.db.transaction(() => {
      for (const turn of stale) {
        this.db.prepare(
          `UPDATE agent_turn SET state = 'queued', started_at = NULL WHERE address = ? AND turn_seq = ?`,
        ).run(turn.address, turn.turn_seq)
        this.db.prepare(
          `UPDATE agent_conversation SET status = 'idle', updated_at = ? WHERE address = ?`,
        ).run(new Date().toISOString(), turn.address)
      }
    })()

    return stale
  }

  // ─── Atomic inbound acceptance ──────────────────────────────────────

  /**
   * Write a message event and a queued turn atomically in the same
   * transaction. Returns the event seq and turn seq.
   * Optional attachment_results are serialized in the event payload.
   */
  appendMessageEvent(params: {
    address: string
    from: string
    text: string
    message_id?: string
    attachment_results?: Array<{
      path: string
      status: string
      mime_type?: string
      size?: number
      sha256?: string
      storage_ref?: string
      error?: string
    }>
  }): { event_seq: number; turn_seq: number } {
    return this.db.transaction(() => {
      const conv = this.getConversation(params.address)
      if (!conv) throw new Error(`unknown agent address: ${params.address}`)

      const eventSeq = conv.next_event_seq
      const turnSeq = conv.next_turn_seq

      const payload: Record<string, unknown> = {
        role: 'human',
        content: params.text,
        from: params.from,
      }
      if (params.attachment_results && params.attachment_results.length > 0) {
        // Only persist non-raw metadata: no bytes, base64, or absolute paths
        payload.attachments = params.attachment_results.map((a) => ({
          path: a.path,
          status: a.status,
          ...(a.mime_type ? { mime_type: a.mime_type } : {}),
          ...(a.size !== undefined ? { size: a.size } : {}),
          ...(a.sha256 ? { sha256: a.sha256 } : {}),
          ...(a.storage_ref ? { storage_ref: a.storage_ref } : {}),
          ...(a.error ? { error: a.error } : {}),
        }))
      }

      const now = new Date().toISOString()
      this.db.prepare(
        `INSERT INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
         VALUES (?, ?, ?, 'message', ?, ?)`,
      ).run(params.address, eventSeq, turnSeq, JSON.stringify(payload), now)

      this.db.prepare(
        `INSERT INTO agent_turn (address, turn_seq, message_id, state, prompt_text, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      ).run(params.address, turnSeq, params.message_id ?? null, params.text, now)

      this.db.prepare(
        `UPDATE agent_conversation SET next_event_seq = ?, next_turn_seq = ?, updated_at = ? WHERE address = ?`,
      ).run(eventSeq + 1, turnSeq + 1, now, params.address)

      // Wake any pollers
      this.wakeWatchers(params.address)

      return { event_seq: eventSeq, turn_seq: turnSeq }
    })()
  }

  // ─── Turn lifecycle ─────────────────────────────────────────────────

  /**
   * Claim the next queued turn atomically (claim → running).
   * Returns the claimed turn or undefined if none are queued.
   */
  claimNextTurn(address: string): AgentTurnRecord | undefined {
    return this.db.transaction(() => {
      const turn = this.db.prepare<[string], AgentTurnRecord>(
        `SELECT * FROM agent_turn WHERE address = ? AND state = 'queued' ORDER BY turn_seq ASC LIMIT 1`,
      ).get(address)

      if (!turn) return undefined

      const now = new Date().toISOString()
      this.db.prepare(
        `UPDATE agent_turn SET state = 'running', started_at = ? WHERE address = ? AND turn_seq = ?`,
      ).run(now, address, turn.turn_seq)

      this.db.prepare(
        `UPDATE agent_conversation SET status = 'running', updated_at = ? WHERE address = ?`,
      ).run(now, address)

      return { ...turn, state: 'running' as const, started_at: now }
    })() ?? undefined
  }

  getTurn(address: string, turnSeq: number): AgentTurnRecord | undefined {
    return this.db.prepare<[string, number], AgentTurnRecord>(
      `SELECT * FROM agent_turn WHERE address = ? AND turn_seq = ?`,
    ).get(address, turnSeq) ?? undefined
  }

  /**
   * Durable seq of the first 'message' event belonging to a turn. Used as the
   * fork point (forked_at_seq / answer_to_seq) for branch turns.
   */
  getTurnMessageSeq(address: string, turnSeq: number): number | undefined {
    const row = this.db.prepare<[string, number], { seq: number }>(
      `SELECT seq FROM agent_event WHERE address = ? AND turn_seq = ? AND kind = 'message' ORDER BY seq ASC LIMIT 1`,
    ).get(address, turnSeq)
    return row?.seq
  }

  completeTurn(address: string, turnSeq: number, error?: string): void {
    const state = error ? 'failed' : 'done'
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE agent_turn SET state = ?, ended_at = ?, error = ? WHERE address = ? AND turn_seq = ?`,
      ).run(state, now, error ?? null, address, turnSeq)
      this.db.prepare(
        `UPDATE agent_conversation SET status = ?, updated_at = ? WHERE address = ?`,
      ).run(error ? 'failed' : 'idle', now, address)
    })()
  }

  cancelTurn(address: string, turnSeq: number): void {
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE agent_turn SET state = 'cancelled', ended_at = ? WHERE address = ? AND turn_seq = ?`,
      ).run(now, address, turnSeq)
      this.db.prepare(
        `UPDATE agent_conversation SET status = 'idle', updated_at = ? WHERE address = ?`,
      ).run(now, address)
    })()
  }

  // ─── Delegation admission ──────────────────────────────────────────

  /**
   * Admit a delegation row atomically. Resource_id uniqueness is enforced
   * by the agent_delegation UNIQUE index, ensuring exactly-once binding.
   * Must be called inside the caller's transaction alongside resource
   * creation for atomicity.
   */
  admitDelegation(params: {
    address: string
    turn_seq: number
    delegation_id: string
    tool_name: string
    input: Record<string, unknown>
    resource_id: string
  }): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO agent_delegation (address, turn_seq, delegation_id, tool_name, input_json, resource_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(params.address, params.turn_seq, params.delegation_id, params.tool_name,
      JSON.stringify(params.input), params.resource_id, now)
  }

  /**
   * List delegations for an address, optionally filtered by turn_seq.
   */
  getDelegations(address: string, turnSeq?: number): AgentDelegationRecord[] {
    if (turnSeq !== undefined) {
      return this.db.prepare<[string, number], AgentDelegationRecord>(
        `SELECT * FROM agent_delegation WHERE address = ? AND turn_seq = ? ORDER BY delegation_id ASC`,
      ).all(address, turnSeq)
    }
    return this.db.prepare<[string], AgentDelegationRecord>(
      `SELECT * FROM agent_delegation WHERE address = ? ORDER BY turn_seq ASC, delegation_id ASC`,
    ).all(address)
  }

  /**
   * Returns true if the given turn has at least one admitted delegation row.
   */
  hasAdmittedDelegations(address: string, turnSeq: number): boolean {
    const row = this.db.prepare<[string, number], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM agent_delegation WHERE address = ? AND turn_seq = ?`,
    ).get(address, turnSeq)
    return (row?.cnt ?? 0) > 0
  }

  /**
   * Look up delegation by resource id. Returns undefined if not found.
   */
  getDelegationByResource(resourceId: string): AgentDelegationRecord | undefined {
    return this.db.prepare<[string], AgentDelegationRecord>(
      `SELECT * FROM agent_delegation WHERE resource_id = ?`,
    ).get(resourceId) ?? undefined
  }

  /**
   * Mark a delegation as terminal. Returns true if the row existed and was updated.
   */
  resolveDelegation(address: string, delegationId: string): boolean {
    const result = this.db.prepare(
      `UPDATE agent_delegation SET status = 'terminal' WHERE address = ? AND delegation_id = ? AND status = 'pending'`,
    ).run(address, delegationId)
    return result.changes === 1
  }

  /**
   * Mark all pending delegations for an address as terminal (used during restart recovery).
   * Returns the count of marked rows.
   */
  resolveAllPendingDelegations(address: string): number {
    const result = this.db.prepare(
      `UPDATE agent_delegation SET status = 'terminal' WHERE address = ? AND status = 'pending'`,
    ).run(address)
    return result.changes
  }

  /**
   * Atomic delegation finalizer. Within one transaction:
   * 1. Resolves the pending delegation to terminal (no-op if already terminal)
   * 2. Appends a delegation_terminal agent event
   * 3. Creates a typed system_completion message/turn
   * 4. Advances conversation sequences
   *
   * Returns the created turn { turn_seq, event_seq } or false if the delegation
   * was already terminal (not found as pending).
   */
  resolveDelegationWithCallback(params: {
    address: string
    delegation_id: string
    resource_id: string
    tool_name: string
    resolution: 'terminal' | 'lost'
    completion_text: string
  }): { turn_seq: number; event_seq: number } | false {
    return this.db.transaction(() => {
      const conv = this.getConversation(params.address)
      if (!conv) throw new Error(`unknown agent address: ${params.address}`)

      // Resolve delegation — returns false if already terminal or not found
      const updateResult = this.db.prepare(
        `UPDATE agent_delegation SET status = 'terminal' WHERE address = ? AND delegation_id = ? AND status = 'pending'`,
      ).run(params.address, params.delegation_id)
      if (updateResult.changes !== 1) return false

      const eventSeq = conv.next_event_seq
      const turnSeq = conv.next_turn_seq
      const now = new Date().toISOString()

      // Append delegation_terminal event
      this.db.prepare(
        `INSERT INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
         VALUES (?, ?, ?, 'delegation_terminal', ?, ?)`,
      ).run(params.address, eventSeq, null, JSON.stringify({
        delegation_id: params.delegation_id,
        resource_id: params.resource_id,
        tool_name: params.tool_name,
        resolution: params.resolution,
        resolved_at: now,
      }), now)

      // Create system_completion turn
      const turnEventSeq = eventSeq + 1
      this.db.prepare(
        `INSERT INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
         VALUES (?, ?, ?, 'message', ?, ?)`,
      ).run(params.address, turnEventSeq, turnSeq, JSON.stringify({
        role: 'human',
        content: params.completion_text,
        from: 'system',
        origin: 'system_completion',
      }), now)

      this.db.prepare(
        `INSERT INTO agent_turn (address, turn_seq, message_id, state, origin, origin_delegation_id, prompt_text, created_at)
         VALUES (?, ?, NULL, 'queued', 'system_completion', ?, ?, ?)`,
      ).run(params.address, turnSeq, params.delegation_id, params.completion_text, now)

      // Advance conversation sequences
      this.db.prepare(
        `UPDATE agent_conversation SET next_event_seq = ?, next_turn_seq = ?, updated_at = ? WHERE address = ?`,
      ).run(turnEventSeq + 1, turnSeq + 1, now, params.address)

      this.wakeWatchers(params.address)

      return { turn_seq: turnSeq, event_seq: eventSeq }
    })()
  }

  // ─── System completion turns ───────────────────────────────────────

  /**
   * Append a system-originated completion turn for a delegation callback.
   * Atomically writes a message event and a queued turn with origin='system_completion'.
   * Returns the event seq and turn seq.
   */
  appendSystemCompletionTurn(params: {
    address: string
    origin_delegation_id: string
    text: string
  }): { event_seq: number; turn_seq: number } {
    return this.db.transaction(() => {
      const conv = this.getConversation(params.address)
      if (!conv) throw new Error(`unknown agent address: ${params.address}`)

      const eventSeq = conv.next_event_seq
      const turnSeq = conv.next_turn_seq

      const payload: Record<string, unknown> = {
        role: 'human',
        content: params.text,
        from: 'system',
        origin: 'system_completion',
      }

      const now = new Date().toISOString()
      this.db.prepare(
        `INSERT INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
         VALUES (?, ?, ?, 'message', ?, ?)`,
      ).run(params.address, eventSeq, turnSeq, JSON.stringify(payload), now)

      this.db.prepare(
        `INSERT INTO agent_turn (address, turn_seq, message_id, state, origin, origin_delegation_id, prompt_text, created_at)
         VALUES (?, ?, NULL, 'queued', 'system_completion', ?, ?, ?)`,
      ).run(params.address, turnSeq, params.origin_delegation_id, params.text, now)

      this.db.prepare(
        `UPDATE agent_conversation SET next_event_seq = ?, next_turn_seq = ?, updated_at = ? WHERE address = ?`,
      ).run(eventSeq + 1, turnSeq + 1, now, params.address)

      this.wakeWatchers(params.address)

      return { event_seq: eventSeq, turn_seq: turnSeq }
    })()
  }

  // ─── Event append ───────────────────────────────────────────────────

  appendEvent(params: {
    address: string
    turn_seq?: number
    kind: AgentEventRecord['kind']
    payload: Record<string, unknown>
  }): number {
    return this.db.transaction(() => {
      const conv = this.getConversation(params.address)
      if (!conv) throw new Error(`unknown agent address: ${params.address}`)
      const seq = conv.next_event_seq
      const now = new Date().toISOString()
      this.db.prepare(
        `INSERT INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(params.address, seq, params.turn_seq ?? null, params.kind, JSON.stringify(params.payload), now)
      this.db.prepare(
        `UPDATE agent_conversation SET next_event_seq = ?, updated_at = ? WHERE address = ?`,
      ).run(seq + 1, now, params.address)

      // Wake any pollers
      this.wakeWatchers(params.address)

      return seq
    })()
  }

  // ─── Cursor sync with bounded long-poll ─────────────────────────────

  async sync(params: {
    address: string
    after_seq?: number
    limit?: number
    wait_ms?: number
  }): Promise<SyncResult> {
    const conv = this.getConversation(params.address)
    const afterSeq = params.after_seq ?? 0
    const limit = Math.min(params.limit ?? 200, 500)
    const waitMs = Math.min(params.wait_ms ?? 30000, 60000)

    const fetchBatch = (): SyncResult => {
      // Include archived events by default unless a compact happened
      const events = this.db.prepare<[string, number, number], AgentEventRecord>(
        `SELECT * FROM agent_event WHERE address = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      ).all(params.address, afterSeq, limit + 1) // fetch one extra to detect has_more

      const hasMore = events.length > limit
      const batch = hasMore ? events.slice(0, limit) : events
      const nextSeq = batch.length > 0 ? batch[batch.length - 1].seq : afterSeq
      const state = this.getConversation(params.address)?.status ?? 'unknown'

      return {
        events: batch.map((e) => ({
          seq: e.seq,
          ...(e.turn_seq !== null ? { turn_seq: e.turn_seq } : {}),
          kind: e.kind,
          payload: JSON.parse(e.payload_json) as unknown,
          created_at: e.created_at,
        })),
        next_seq: nextSeq,
        has_more: hasMore,
        state,
      }
    }

    // Try immediate fetch
    const batch = fetchBatch()
    if (batch.events.length > 0 || waitMs <= 0) return batch

    // Wait for new events
    return this.waitForEvents(params.address, waitMs).then(() => fetchBatch())
  }

  // ─── Compact ────────────────────────────────────────────────────────

  compact(params: { address: string; summary?: string }): CompactResult {
    return this.db.transaction(() => {
      const conv = this.getConversation(params.address)
      if (!conv) throw new Error(`unknown agent address: ${params.address}`)

      const coversThroughSeq = conv.next_event_seq > 1 ? conv.next_event_seq - 1 : 0
      if (coversThroughSeq === 0) {
        // Nothing to compact
        return { compact_seq: 0, covers_through_seq: 0 }
      }

      const seq = conv.next_event_seq
      const now = new Date().toISOString()
      const payload: Record<string, unknown> = {
        kind: 'compact',
        covers_through_seq: coversThroughSeq,
        summary: params.summary ?? `Compact of ${coversThroughSeq} events`,
      }

      this.db.prepare(
        `INSERT INTO agent_event (address, seq, kind, payload_json, compact_covers_through_seq, compact_summary, created_at)
         VALUES (?, ?, 'compact', ?, ?, ?, ?)`,
      ).run(params.address, seq, JSON.stringify(payload), coversThroughSeq, params.summary ?? null, now)

      this.db.prepare(
        `UPDATE agent_conversation SET next_event_seq = ?, updated_at = ? WHERE address = ?`,
      ).run(seq + 1, now, params.address)

      // Wake any pollers
      this.wakeWatchers(params.address)

      return { compact_seq: seq, covers_through_seq: coversThroughSeq }
    })()
  }

  /**
   * Get visible projection: events starting after the latest compact event
   * (the compact boundary event itself is excluded). When include_archived
   * is true, all events including those before the latest compact are returned.
   */
  getVisibleAfterCompact(address: string, afterSeq: number = 0, limit: number = 200): {
    events: Array<{ seq: number; turn_seq?: number; kind: string; payload: unknown; created_at: string }>
    next_seq: number
    has_more: boolean
  } {
    // Find latest compact
    const latestCompact = this.db.prepare<[string], { seq: number; covers_through_seq: number }>(
      `SELECT seq, compact_covers_through_seq FROM agent_event
       WHERE address = ? AND kind = 'compact'
       ORDER BY seq DESC LIMIT 1`,
    ).get(address)

    const effectiveAfterSeq = latestCompact
      ? Math.max(afterSeq, latestCompact.seq)
      : afterSeq

    const events = this.db.prepare<[string, number, number], AgentEventRecord>(
      `SELECT * FROM agent_event WHERE address = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    ).all(address, effectiveAfterSeq, limit + 1)

    const hasMore = events.length > limit
    const batch = hasMore ? events.slice(0, limit) : events
    const nextSeq = batch.length > 0 ? batch[batch.length - 1].seq : effectiveAfterSeq

    return {
      events: batch.map((e) => ({
        seq: e.seq,
        ...(e.turn_seq !== null ? { turn_seq: e.turn_seq } : {}),
        kind: e.kind,
        payload: JSON.parse(e.payload_json) as unknown,
        created_at: e.created_at,
      })),
      next_seq: nextSeq,
      has_more: hasMore,
    }
  }

  getQueueDepth(address: string): number {
    const row = this.db.prepare<[string], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM agent_turn WHERE address = ? AND state = 'queued'`,
    ).get(address)
    return row?.cnt ?? 0
  }

  getCompletedTurnSeqs(address: string): ReadonlySet<number> {
    const rows = this.db.prepare<[string], { turn_seq: number }>(
      `SELECT turn_seq FROM agent_turn WHERE address = ? AND state = 'done'`,
    ).all(address)
    return new Set(rows.map(row => row.turn_seq))
  }

  // ─── Memory corpus ──────────────────────────────────────────────────

  /**
   * Write a versioned memory corpus record atomically alongside a
   * boundary marker. Returns the assigned memory seq.
   */
  writeMemory(params: {
    address: string
    version: string
    corpus_json: string
    min_event_seq: number
    max_event_seq: number
    token_estimate?: number
  }): number {
    return this.db.transaction(() => {
      const memSeq = this.getNextMemorySeq(params.address)

      // Write boundary marker (compact event) that does NOT hide events
      const now = new Date().toISOString()
      this.db.prepare(
        `INSERT INTO agent_event (address, seq, kind, payload_json, compact_covers_through_seq, compact_summary, created_at)
         VALUES (?, ?, 'compact', ?, ?, NULL, ?)`,
      ).run(
        params.address,
        this.getConversation(params.address)!.next_event_seq,
        JSON.stringify({ kind: 'compact', covers_through_seq: params.max_event_seq, boundary: true }),
        params.max_event_seq,
        now,
      )

      this.db.prepare(
        `UPDATE agent_conversation SET next_event_seq = next_event_seq + 1, updated_at = ? WHERE address = ?`,
      ).run(now, params.address)

      // Write memory record
      this.db.prepare(
        `INSERT INTO agent_memory (address, seq, version, corpus_json, min_event_seq, max_event_seq, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.address, memSeq, params.version, params.corpus_json,
        params.min_event_seq, params.max_event_seq,
        params.token_estimate ?? null, now,
      )

      // Wake any pollers so sync clients see the new compact event
      this.wakeWatchers(params.address)

      return memSeq
    })()
  }

  /**
   * Write a memory record with compare-and-swap semantics for background
   * writers. Returns the memory seq on success, or -1 if CAS check fails
   * (another writer wrote a newer memory first).
   */
  writeMemoryWithCas(params: {
    address: string
    version: string
    corpus_json: string
    min_event_seq: number
    max_event_seq: number
    token_estimate?: number
    expected_latest_version: string | null
  }): number {
    return this.db.transaction(() => {
      const memSeq = this.getNextMemorySeq(params.address)

      // Atomic CAS: read the latest stored version under the transaction
      // lock, then INSERT only if it matches expected_latest_version.
      // Within a transaction, no concurrent writer can race between the
      // SELECT and INSERT.
      const latestVersion = this.db.prepare(
        `SELECT version FROM agent_memory WHERE address = ? ORDER BY seq DESC LIMIT 1`,
      ).pluck().get(params.address) as string | undefined

      if (params.expected_latest_version !== (latestVersion ?? null)) return -1

      const now = new Date().toISOString()
      this.db.prepare(
        `INSERT INTO agent_memory (address, seq, version, corpus_json, min_event_seq, max_event_seq, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.address, memSeq, params.version, params.corpus_json,
        params.min_event_seq, params.max_event_seq,
        params.token_estimate ?? null, now,
      )

      // Write boundary marker (compact event)
      this.db.prepare(
        `INSERT INTO agent_event (address, seq, kind, payload_json, compact_covers_through_seq, compact_summary, created_at)
         VALUES (?, ?, 'compact', ?, ?, NULL, ?)`,
      ).run(
        params.address,
        this.getConversation(params.address)!.next_event_seq,
        JSON.stringify({ kind: 'compact', covers_through_seq: params.max_event_seq, boundary: true }),
        params.max_event_seq,
        now,
      )

      this.db.prepare(
        `UPDATE agent_conversation SET next_event_seq = next_event_seq + 1, updated_at = ? WHERE address = ?`,
      ).run(now, params.address)

      this.wakeWatchers(params.address)

      return memSeq
    })()
  }

  /**
   * Get all memory versions for an address, newest first.
   */
  getMemoryVersions(address: string, limit?: number): AgentMemoryRecord[] {
    return this.db.prepare<[string, number], AgentMemoryRecord>(
      `SELECT * FROM agent_memory WHERE address = ? ORDER BY seq DESC LIMIT ?`,
    ).all(address, limit ?? 100)
  }

  /**
   * Get the latest memory version for an address, or undefined if none.
   */
  getLatestMemory(address: string): AgentMemoryRecord | undefined {
    return this.db.prepare<[string], AgentMemoryRecord>(
      `SELECT * FROM agent_memory WHERE address = ? ORDER BY seq DESC LIMIT 1`,
    ).get(address) ?? undefined
  }

  /**
   * Get all events belonging to complete (done) turns within a seq range.
   * Returns raw event records for the context assembler.
   */
  getCompleteTurnEvents(address: string, afterSeq: number, limit: number = 10000): AgentEventRecord[] {
    const doneTurns = this.db.prepare<[string], { turn_seq: number }>(
      `SELECT turn_seq FROM agent_turn WHERE address = ? AND state = 'done'`,
    ).all(address)
    if (doneTurns.length === 0) return []

    const turnSeqs = doneTurns.map(t => t.turn_seq)
    const placeholders = turnSeqs.map(() => '?').join(',')
    return this.db.prepare<[string, number, ...number[]], AgentEventRecord>(
      `SELECT * FROM agent_event WHERE address = ? AND seq > ? AND turn_seq IN (${placeholders}) ORDER BY seq ASC LIMIT ?`,
    ).all(address, afterSeq, ...turnSeqs, limit)
  }

  /**
   * Authoritative pending delegation ledger for an address.
   * Returns all delegation rows with status = 'pending'.
   */
  getPendingDelegationLedger(address: string): AgentDelegationRecord[] {
    return this.db.prepare<[string], AgentDelegationRecord>(
      `SELECT * FROM agent_delegation WHERE address = ? AND status = 'pending' ORDER BY turn_seq ASC, delegation_id ASC`,
    ).all(address)
  }

  private getNextMemorySeq(address: string): number {
    const latest = this.db.prepare<[string], { seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM agent_memory WHERE address = ?`,
    ).get(address)
    return latest?.seq ?? 1
  }

  getActiveTurn(address: string): AgentTurnRecord | undefined {
    return this.db.prepare<[string], AgentTurnRecord>(
      `SELECT * FROM agent_turn WHERE address = ? AND state = 'running' ORDER BY turn_seq ASC LIMIT 1`,
    ).get(address) ?? undefined
  }

  /**
   * List all queued turns for an address, ordered FIFO.
   */
  listQueuedTurns(address: string): AgentTurnRecord[] {
    return this.db.prepare<[string], AgentTurnRecord>(
      `SELECT * FROM agent_turn WHERE address = ? AND state = 'queued' ORDER BY turn_seq ASC`,
    ).all(address)
  }

  // ─── Wake / long-poll internals ─────────────────────────────────────

  private wakeWatchers(address: string): void {
    const list = this.watchers.get(address)
    if (!list || list.length === 0) return
    for (const w of list) {
      clearTimeout(w.timeout)
      w.resolve()
    }
    this.watchers.delete(address)
  }

  private waitForEvents(address: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const watcher: WakeWatcher = {
        resolve,
        timeout: setTimeout(() => resolve(), timeoutMs),
      }
      const list = this.watchers.get(address) ?? []
      list.push(watcher)
      this.watchers.set(address, list)
    })
  }
}
