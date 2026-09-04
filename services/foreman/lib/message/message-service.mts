/**
 * MessageService — the single message entry point.
 *
 * All senders (CLI, IPC, MCP, and external route adapters) call
 * MessageService.send. External principal routes are resolved here.
 */

import { randomUUID, randomBytes } from 'node:crypto'
import type { PrincipalRegistry } from './principal.mts'
import {
  validateSender,
  validateRecipient,
  PRINCIPAL_ERRORS,
  resolvePrincipalDeliveryRoute,
} from './principal.mts'
import type { MessageStore } from '../db/stores/message-store.mts'

// ─── Types ───────────────────────────────────────────────────────────

export interface SendRequest {
  from: string
  to: string
  text: string
  client_message_id?: string
}

export interface SendResult {
  message_id: string
  accepted: boolean
  target_seq?: number
  queue_depth?: number
  delivery?: {
    delivery_id: string
    status: 'delivered' | 'failed'
    ok: boolean
    error?: string
  }
}

export interface SendError {
  ok: false
  error: string
  message?: string
}

// ─── Service ports (injectable for testing) ──────────────────────────

export interface ExternalDeliveryPort {
  /** Deliver a message to an external transport using a durable delivery record.
   *  The caller is responsible for creating the pending delivery record in the store
   *  before invoking; the port updates the record on completion. */
  deliver(deliveryId: string, messageId: string, routeId: string, transport: string, envelope: { from: string; to: string; text: string }): Promise<{ deliveryId: string; status: 'delivered' | 'failed'; ok: boolean; error?: string }>
}

export interface MessageServiceDeps {
  registry: PrincipalRegistry
  store: MessageStore
  externalDelivery?: ExternalDeliveryPort
  now?: () => Date
}

// ─── Service ─────────────────────────────────────────────────────────

export class MessageService {
  private readonly registry: PrincipalRegistry
  private readonly store: MessageStore
  private externalDelivery?: ExternalDeliveryPort
  private readonly now: () => Date

  constructor(deps: MessageServiceDeps) {
    this.registry = deps.registry
    this.store = deps.store
    this.externalDelivery = deps.externalDelivery
    this.now = deps.now ?? (() => new Date())
  }

  /** Set the external delivery port after construction. */
  setExternalDeliveryPort(port: ExternalDeliveryPort): void {
    this.externalDelivery = port
  }

  /**
   * Send a message. This is the single entry point for all message routing.
   *
   * Permission checks:
   * - from must be a can_send principal with message.send grant
   * - to must be an addressable principal
   *
   * Idempotency:
   * - (from, client_message_id) has a unique constraint
   * - Duplicate requests return the first result, no double delivery
   * - Message + idempotency key are persisted BEFORE the target side effect
   *
   * Routing: external principal (deliveryRoute) → durable outbox.
   */
  async send(req: SendRequest): Promise<SendResult | SendError> {
    // Validate sender
    const senderError = validateSender(this.registry, req.from)
    if (senderError) {
      return { ok: false, error: senderError.error, message: senderError.message }
    }

    // Generate or use provided client_message_id for idempotency
    const clientMessageId = req.client_message_id ?? `${req.from}_${randomUUID()}`

    // Check idempotency: (from, client_message_id) must be unique
    const existing = this.store.findByClientMessageId(req.from, clientMessageId)
    if (existing) {
      if (existing.result_json) {
        return JSON.parse(existing.result_json) as SendResult | SendError
      }
      return this.rehydrateStoredResult(existing.message_id)
    }

    // Persist message record + idempotency key BEFORE target side effect
    const messageId = `fm_${req.from}_${clientMessageId.slice(0, 32)}`
    const now = this.now().toISOString()
    this.store.createMessage({
      messageId,
      fromRole: req.from,
      toRole: req.to,
      body: req.text,
      createdAt: now,
    })
    this.store.createClientMessageId(req.from, clientMessageId, messageId, now)

    // Resolve the configured target and perform any external delivery.
    const targetResult = await this.resolveTarget(req.to, req.text, req.from, messageId)
    let result: SendResult | SendError
    if (targetResult === null) {
      result = { ok: false, error: PRINCIPAL_ERRORS.unknown_agent_address, message: `unknown target address: ${req.to}` }
    } else if ('error' in targetResult && 'ok' in targetResult) {
      result = targetResult as SendError
    } else {
      result = {
        message_id: messageId,
        accepted: true,
        ...('target_seq' in targetResult && (targetResult as { target_seq?: number }).target_seq !== undefined
          ? { target_seq: (targetResult as { target_seq: number }).target_seq }
          : {}),
        ...('queue_depth' in targetResult && (targetResult as { queue_depth?: number }).queue_depth !== undefined
          ? { queue_depth: (targetResult as { queue_depth: number }).queue_depth }
          : {}),
        ...('delivery' in targetResult && (targetResult as { delivery?: SendResult['delivery'] }).delivery !== undefined
          ? { delivery: (targetResult as { delivery: SendResult['delivery'] }).delivery }
          : {}),
      }
    }
    this.store.storeClientMessageResult(req.from, clientMessageId, result)
    return result
  }

  /**
   * Resolve the target address to a concrete handler.
   * Returns null for unknown addresses, SendError for known-but-invalid, or target result.
   */
  private async resolveTarget(
    to: string,
    text: string,
    from: string,
    messageId: string,
  ): Promise<{ delivery?: SendResult['delivery'] } | SendError | null> {
    // Check if target is a registered principal.
    const recipientError = validateRecipient(this.registry, to)
    if (recipientError) {
      return { ok: false as const, error: recipientError.error, message: recipientError.message }
    }

    // Resolve external delivery via durable outbox.
    const route = resolvePrincipalDeliveryRoute(this.registry, to)
    if (route && this.externalDelivery) {
      const deliveryId = `md_${randomBytes(8).toString('hex')}`
      const routeId = this.registry.principals[to]?.deliveryRoute ?? to
      // Create pending delivery record in the store (durable outbox)
      this.store.createDelivery({
        deliveryId,
        messageId,
        routeId,
        transport: route.transport,
        createdAt: this.now().toISOString(),
      })
      const result = await this.externalDelivery.deliver(
        deliveryId,
        messageId,
        routeId,
        route.transport,
        { from, to, text },
      )
      return {
        delivery: {
          delivery_id: result.deliveryId,
          status: result.status,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
        },
      }
    }

    // No route configured for addressable principal
    return { ok: false, error: PRINCIPAL_ERRORS.not_addressable, message: `principal '${to}' has no delivery route configured` }
  }

  /**
   * Rehydrate a stored send result for idempotent replay.
   * This reads the delivery status from the message store and returns the
   * original message_id with current delivery state.
   */
  private rehydrateStoredResult(messageId: string): SendResult | SendError {
    const deliveries = this.store.listDeliveries(messageId)
    const latestDelivery = deliveries.at(-1)

    if (latestDelivery) {
      const isDelivered = latestDelivery.status === 'delivered'
      return {
        message_id: messageId,
        accepted: true,
        ...(latestDelivery.status === 'failed'
          ? {
            delivery: {
              delivery_id: latestDelivery.id,
              status: 'failed' as const,
              ok: false,
              error: latestDelivery.last_error ?? 'delivery failed',
            },
          }
          : isDelivered
            ? {
              delivery: {
                delivery_id: latestDelivery.id,
                status: 'delivered' as const,
                ok: true,
              },
            }
            : {}),
      }
    }

    // No delivery records yet — message accepted but delivery pending
    return { message_id: messageId, accepted: true }
  }

  async drainPendingDeliveries(): Promise<void> {
    if (!this.externalDelivery) return
    for (const delivery of this.store.listPendingDeliveries()) {
      const message = this.store.getMessage(delivery.message_id)
      if (!message) continue
      await this.externalDelivery.deliver(
        delivery.id,
        delivery.message_id,
        delivery.route_id,
        delivery.transport,
        { from: message.from_role, to: message.to_role, text: message.body },
      )
    }
  }
}
