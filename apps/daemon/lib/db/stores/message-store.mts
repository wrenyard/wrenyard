import type { ForemanDatabase, RunResult } from '../types.mts'

export type MessageDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed'

export interface MessageWrite {
  messageId: string
  fromRole: string
  toRole: string
  conversationId?: string | null
  body: string
  format?: string | null
  createdAt: string
}

export interface MessageDeliveryWrite {
  deliveryId: string
  messageId: string
  routeId: string
  transport: string
  createdAt: string
}

export interface StoredMessage {
  id: string
  from_role: string
  to_role: string
  conversation_id: string | null
  body: string
  format: string | null
  created_at: string
}

export interface StoredMessageDelivery {
  id: string
  message_id: string
  route_id: string
  transport: string
  status: MessageDeliveryStatus
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
  delivered_at: string | null
}

export interface IdempotencyKey {
  from_role: string
  client_message_id: string
  message_id: string
  result_json: string | null
  created_at: string
}

export class MessageStore {
  constructor(private readonly db: ForemanDatabase) {}

  createMessage(write: MessageWrite): void {
    this.run(
      `INSERT OR IGNORE INTO messages (
        id, from_role, to_role, conversation_id, body, format, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      write.messageId,
      write.fromRole,
      write.toRole,
      write.conversationId ?? null,
      write.body,
      write.format ?? null,
      write.createdAt,
    )
  }

  createDelivery(write: MessageDeliveryWrite): void {
    this.run(
      `INSERT INTO message_deliveries (
        id, message_id, route_id, transport, status, attempts, last_error,
        created_at, updated_at, delivered_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)`,
      write.deliveryId,
      write.messageId,
      write.routeId,
      write.transport,
      write.createdAt,
      write.createdAt,
    )
  }

  markDelivered(deliveryId: string, deliveredAt: string): void {
    this.run(
      `UPDATE message_deliveries
      SET status = 'delivered', attempts = attempts + 1, last_error = NULL,
        updated_at = ?, delivered_at = ?
      WHERE id = ?`,
      deliveredAt,
      deliveredAt,
      deliveryId,
    )
  }

  markFailed(deliveryId: string, error: string, failedAt: string): void {
    this.run(
      `UPDATE message_deliveries
      SET status = 'failed', attempts = attempts + 1, last_error = ?,
        updated_at = ?, delivered_at = NULL
      WHERE id = ?`,
      error,
      failedAt,
      deliveryId,
    )
  }

  getMessage(messageId: string): StoredMessage | null {
    return this.get<StoredMessage>(
      `SELECT id, from_role, to_role, conversation_id, body, format, created_at
      FROM messages WHERE id = ?`,
      messageId,
    ) ?? null
  }

  listDeliveries(messageId: string): StoredMessageDelivery[] {
    return this.db.prepare<[string], StoredMessageDelivery>(
      `SELECT id, message_id, route_id, transport, status, attempts, last_error,
        created_at, updated_at, delivered_at
      FROM message_deliveries
      WHERE message_id = ?
      ORDER BY created_at ASC, id ASC`,
    ).all(messageId)
  }

  /**
   * Persist an idempotency key (from_role, client_message_id) → message_id.
   * Returns true if inserted, false if key already exists.
   */
  createClientMessageId(fromRole: string, clientMessageId: string, messageId: string, createdAt: string): boolean {
    const result = this.db.prepare<[string, string, string, string]>(
      `INSERT OR IGNORE INTO message_idempotency_keys
      (from_role, client_message_id, message_id, created_at)
      VALUES (?, ?, ?, ?)`,
    ).run(fromRole, clientMessageId, messageId, createdAt)
    return result.changes > 0
  }

  /**
   * Find a previously-persisted message by idempotency key.
   */
  findByClientMessageId(fromRole: string, clientMessageId: string): IdempotencyKey | null {
    return this.db.prepare<[string, string], IdempotencyKey>(
      `SELECT from_role, client_message_id, message_id, result_json, created_at
      FROM message_idempotency_keys
      WHERE from_role = ? AND client_message_id = ?`,
    ).get(fromRole, clientMessageId) ?? null
  }

  storeClientMessageResult(fromRole: string, clientMessageId: string, result: unknown): void {
    this.run(
      `UPDATE message_idempotency_keys SET result_json = ?
       WHERE from_role = ? AND client_message_id = ?`,
      JSON.stringify(result),
      fromRole,
      clientMessageId,
    )
  }

  listPendingDeliveries(): StoredMessageDelivery[] {
    return this.db.prepare<[], StoredMessageDelivery>(
      `SELECT id, message_id, route_id, transport, status, attempts, last_error,
        created_at, updated_at, delivered_at
       FROM message_deliveries WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    ).all()
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare<unknown[], T>(sql).get(...params)
  }

  private run(sql: string, ...params: unknown[]): RunResult {
    return this.db.prepare<unknown[]>(sql).run(...params)
  }
}
