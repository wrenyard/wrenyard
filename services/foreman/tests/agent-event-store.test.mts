/**
 * Tests for AgentEventStore — seq starting at 1, atomic append, FIFO claim,
 * recovery, compact visibility, and migration integration.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initDb, closeDb } from '../lib/db/connection.mts'
import { bootstrapSchema } from '../lib/db/schema.mts'
import type { ForemanDatabase } from '../lib/db/types.mts'
import { AgentEventStore } from '../lib/core/agent/agent-event-store.mts'

let db: ForemanDatabase
let store: AgentEventStore

const TEST_ADDRESS = 'fwa-123456789012345678901234'

before(() => {
  db = initDb(':memory:')
  bootstrapSchema(db)
  store = new AgentEventStore(db)
})

after(() => {
  closeDb()
})

void describe('AgentEventStore', () => {
  void describe('seq starting at 1', () => {
    void it('createOrGetConversation starts next_event_seq at 1', () => {
      store.createOrGetConversation({ address: TEST_ADDRESS, kind: 'fwa', model: 'test-model' })
      const conv = store.getConversation(TEST_ADDRESS)
      assert.ok(conv, 'conversation should exist')
      assert.equal(conv!.next_event_seq, 1, 'first event seq should be 1')
      assert.equal(conv!.next_turn_seq, 1, 'first turn seq should be 1')
    })

    void it('appendMessageEvent returns event_seq=1 for first message', () => {
      const result = store.appendMessageEvent({
        address: TEST_ADDRESS,
        from: 'codex',
        text: 'Hello',
      })
      assert.equal(result.event_seq, 1, 'first event seq should be 1')
      assert.equal(result.turn_seq, 1, 'first turn seq should be 1')
    })

    void it('sync(after_seq=0) returns the first event (seq 1)', async () => {
      const result = await store.sync({ address: TEST_ADDRESS, after_seq: 0 })
      assert.ok(result.events.length >= 1, 'should have events')
      assert.equal(result.events[0].seq, 1, 'first event seq should be 1')
    })

    void it('no events with seq 0 in agent_event table', () => {
      const row = db.prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) as cnt FROM agent_event WHERE address = ? AND seq = 0`,
      ).get(TEST_ADDRESS)
      assert.equal(row?.cnt ?? 0, 0, 'should have no seq 0 events')
    })

    void it('no turns with turn_seq 0 in agent_turn table', () => {
      const row = db.prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) as cnt FROM agent_turn WHERE address = ? AND turn_seq = 0`,
      ).get(TEST_ADDRESS)
      assert.equal(row?.cnt ?? 0, 0, 'should have no turn_seq 0 turns')
    })
  })

  void describe('atomic inbound acceptance', () => {
    void it('appendMessageEvent creates both event and queued turn in same transaction', () => {
      const addr = 'fwa-abcdefabcdefabcdefabcdef'
      store.createOrGetConversation({ address: addr, kind: 'fwa', model: 'm' })

      const result = store.appendMessageEvent({ address: addr, from: 'test', text: 'atomic test' })
      assert.equal(result.event_seq, 1)
      assert.equal(result.turn_seq, 1)

      // Verify event exists
      const event = db.prepare<[string, number], { kind: string }>(
        `SELECT kind FROM agent_event WHERE address = ? AND seq = ?`,
      ).get(addr, 1)
      assert.ok(event, 'event should exist')
      assert.equal(event!.kind, 'message')

      // Verify turn exists and is queued
      const turn = db.prepare<[string, number], { state: string; prompt_text: string }>(
        `SELECT state, prompt_text FROM agent_turn WHERE address = ? AND turn_seq = ?`,
      ).get(addr, 1)
      assert.ok(turn, 'turn should exist')
      assert.equal(turn!.state, 'queued')
      assert.equal(turn!.prompt_text, 'atomic test')
    })
  })

  void describe('FIFO claim', () => {
    const addr = 'fwa-bbbbbbbbbbbbbbbbbbbbbbbb'

    void it('claims queued turns in FIFO order', () => {
      assert.equal(store.getQueueDepth(addr), 0, 'queue should be empty before')

      // Create conversation and enqueue two messages
      store.createOrGetConversation({ address: addr, kind: 'fwa', model: 'm' })
      store.appendMessageEvent({ address: addr, from: 'test', text: 'First' })
      store.appendMessageEvent({ address: addr, from: 'test', text: 'Second' })

      assert.equal(store.getQueueDepth(addr), 2, 'should have 2 queued turns')

      // Claim first
      const first = store.claimNextTurn(addr)
      assert.ok(first, 'first turn should be claimable')
      assert.equal(first!.turn_seq, 1)
      assert.equal(first!.state, 'running')
      assert.equal(store.getQueueDepth(addr), 1, 'depth should decrease to 1')

      // Claim second
      const second = store.claimNextTurn(addr)
      assert.ok(second, 'second turn should be claimable')
      assert.equal(second!.turn_seq, 2)
      assert.equal(store.getQueueDepth(addr), 0, 'depth should be 0')

      // No more turns
      const none = store.claimNextTurn(addr)
      assert.equal(none, undefined, 'no more turns to claim')
    })
  })

  void describe('recovery', () => {
    const addr = 'fwa-cccccccccccccccccccccccc'

    void it('recoverStaleTurns resets running turns to queued', () => {
      store.createOrGetConversation({ address: addr, kind: 'fwa', model: 'm' })
      store.appendMessageEvent({ address: addr, from: 'test', text: 'Will run' })

      // Simulate crash: directly set turn to running
      db.prepare(
        `UPDATE agent_turn SET state = 'running', started_at = ? WHERE address = ? AND turn_seq = 1`,
      ).run(new Date().toISOString(), addr)

      const recovered = store.recoverStaleTurns()
      assert.ok(recovered.length >= 1, 'should recover at least 1 stale turn')

      const turn = db.prepare<[string, number], { state: string; started_at: string | null }>(
        `SELECT state, started_at FROM agent_turn WHERE address = ? AND turn_seq = ?`,
      ).get(addr, 1)
      assert.ok(turn, 'turn should exist')
      assert.equal(turn!.state, 'queued', 'should be reset to queued')
      assert.equal(turn!.started_at, null, 'started_at should be cleared')
    })
  })

  void describe('compact visibility', () => {
    const addr = 'fwa-dddddddddddddddddddddddd'

    void it('compact creates compact event and getVisibleAfterCompact filters correctly', () => {
      store.createOrGetConversation({ address: addr, kind: 'fwa', model: 'm' })

      // Add two message events (seq 1, 2)
      store.appendMessageEvent({ address: addr, from: 'test', text: 'A' })
      store.appendMessageEvent({ address: addr, from: 'test', text: 'B' })

      // Compact (seq 3 is compact event, covers through seq 2)
      const compactResult = store.compact({ address: addr, summary: 'Test compact' })
      assert.ok(compactResult.compact_seq > 0, 'compact should return valid seq')
      assert.ok(compactResult.covers_through_seq >= 2, 'should cover through seq 2')

      // Default visibility (after compact boundary) should return no visible events
      const visible = store.getVisibleAfterCompact(addr, 0, 100)
      assert.equal(visible.events.length, 0, 'no visible events after compact boundary')

      // After adding a new event after compact, it should be visible
      store.appendMessageEvent({ address: addr, from: 'test', text: 'C' })
      const visibleAfter = store.getVisibleAfterCompact(addr, 0, 100)
      assert.ok(visibleAfter.events.length >= 1, 'should see events after compact')
      // The compact boundary is at compact_event.seq, so events with seq > compact_event.seq are visible
      // Event C has seq 4 (since 1:A, 2:B, 3:compact, 4:C)
      assert.equal(visibleAfter.events[0].seq, 4, 'first visible event should be seq 4')
    })
  })

  void describe('seq consistency', () => {
    const addr = 'fwa-eeeeeeeeeeeeeeeeeeeeeeee'

    void it('appendEvent returns monotonically increasing seq', () => {
      store.createOrGetConversation({ address: addr, kind: 'fwa', model: 'm' })

      // Write a message event via appendMessageEvent
      store.appendMessageEvent({ address: addr, from: 'test', text: 'First' })

      // Write an assistant event via appendEvent
      const seq2 = store.appendEvent({
        address: addr,
        kind: 'assistant',
        payload: { role: 'assistant', content: 'Reply' },
      })
      assert.equal(seq2, 2, 'assistant event seq should be 2')

      // Write a tool_result event
      const seq3 = store.appendEvent({
        address: addr,
        kind: 'tool_result',
        payload: { role: 'tool', content: 'Tool result', tool_call_id: 'call-1', tool_name: 'test_tool' },
      })
      assert.equal(seq3, 3, 'tool_result event seq should be 3')

      // Append another message event
      const { event_seq: seq4 } = store.appendMessageEvent({
        address: addr,
        from: 'test',
        text: 'Second message',
      })
      assert.equal(seq4, 4, 'second message event seq should be 4')

      // Verify the conversation next_event_seq
      const conv = store.getConversation(addr)
      assert.ok(conv, 'conversation should exist')
      assert.equal(conv!.next_event_seq, 5, 'next_event_seq should be 5 (last seq + 1)')
    })

    void it('uses the last delivered seq as the next after_seq cursor', async () => {
      const first = await store.sync({ address: addr, after_seq: 0, limit: 2, wait_ms: 0 })
      const second = await store.sync({ address: addr, after_seq: first.next_seq, limit: 2, wait_ms: 0 })
      assert.deepEqual(first.events.map((event) => event.seq), [1, 2])
      assert.deepEqual(second.events.map((event) => event.seq), [3, 4])
    })
  })
})

void describe('agent_event kind migration', () => {
  void it('preserves legacy rows and admits typed delegation terminal events', () => {
    const legacyDb = new Database(':memory:')
    try {
      bootstrapSchema(legacyDb)
      legacyDb.prepare(`
        INSERT INTO agent_conversation (
          address, kind, status, model, next_event_seq, next_turn_seq,
          system_policy, created_at, updated_at
        ) VALUES ('foreman-work', 'work', 'idle', 'test', 2, 1, NULL, 'now', 'now')
      `).run()
      legacyDb.prepare('DROP INDEX IF EXISTS idx_agent_event_address_seq').run()
      legacyDb.prepare('DROP INDEX IF EXISTS idx_agent_event_turn').run()
      legacyDb.prepare('DROP TABLE agent_event').run()
      legacyDb.prepare(`CREATE TABLE agent_event (
        address TEXT NOT NULL REFERENCES agent_conversation(address) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        turn_seq INTEGER,
        kind TEXT NOT NULL CHECK(kind IN ('message','assistant','tool_call','tool_result','compact')),
        payload_json TEXT NOT NULL,
        compact_covers_through_seq INTEGER,
        compact_summary TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(address, seq)
      )`).run()
      legacyDb.prepare(`
        INSERT INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
        VALUES ('foreman-work', 1, NULL, 'message', '{"role":"human"}', 'now')
      `).run()

      bootstrapSchema(legacyDb)

      legacyDb.prepare(`
        INSERT INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
        VALUES ('foreman-work', 2, NULL, 'delegation_terminal', '{}', 'now')
      `).run()
      const kinds = legacyDb.prepare<[], { kind: string }>(
        `SELECT kind FROM agent_event WHERE address = 'foreman-work' ORDER BY seq`,
      ).all().map(row => row.kind)
      assert.deepEqual(kinds, ['message', 'delegation_terminal'])
    } finally {
      legacyDb.close()
    }
  })
})
