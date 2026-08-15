/**
 * MessageService — the single message entry point.
 *
 * All senders (CLI, IPC, MCP, Work/FWA tool reply, external route adapter) call
 * MessageService.send. Agent addresses and external principal routes are
 * resolved by this service alone.
 */

import { randomUUID, randomBytes } from 'node:crypto'
import type { PrincipalRegistry } from './principal.mts'
import {
  validateSender,
  validateRecipient,
  PRINCIPAL_ERRORS,
  resolvePrincipalDeliveryRoute,
  hasGrant,
} from './principal.mts'
import {
  isFwaAddress,
  resolveFwaAddress,
  FOREMAN_WORK_ADDRESS,
} from './address.mts'
import type { MessageStore } from '../db/stores/message-store.mts'

// ─── Types ───────────────────────────────────────────────────────────

/** Path-only attachment descriptor from caller */
export interface SendAttachment {
  path: string
}

/** Per-item attachment result */
export interface SendAttachmentResult {
  path: string
  status: 'accepted' | 'rejected'
  mime_type?: string
  size?: number
  sha256?: string
  storage_ref?: string
  error?: 'file_not_found' | 'invalid_path' | 'not_regular_file' | 'too_large' | 'unsupported_content_type' | 'read_failed'
}

export interface SendRequest {
  from: string
  to: string
  text: string
  client_message_id?: string
  attachments?: SendAttachment[]
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
  attachments?: SendAttachmentResult[]
}

export interface SendError {
  ok: false
  error: string
  message?: string
}

// ─── Service ports (injectable for testing) ──────────────────────────

export interface FwaSendPort {
  /** Send a message to a specific FWA session by its storage id. */
  sendToSession(sessionId: string, text: string, from: string, messageId: string): Promise<{ accepted: boolean; target_seq?: number; queue_depth?: number }>
  /** Check if a session id exists and is non-closed. */
  hasLiveSession(sessionId: string): boolean
}

export interface WorkSendPort {
  /** Send a message to foreman-work with optional attachments. Returns accepted + event seq info + per-item results. */
  send(text: string, from: string, messageId: string, attachments?: SendAttachment[]): Promise<{
    accepted: boolean
    target_seq?: number
    queue_depth?: number
    attachment_results?: SendAttachmentResult[]
  }>
}

export interface ExternalDeliveryPort {
  /** Deliver a message to an external transport using a durable delivery record.
   *  The caller is responsible for creating the pending delivery record in the store
   *  before invoking; the port updates the record on completion. */
  deliver(deliveryId: string, messageId: string, routeId: string, transport: string, envelope: { from: string; to: string; text: string }): Promise<{ deliveryId: string; status: 'delivered' | 'failed'; ok: boolean; error?: string }>
}

export interface MessageServiceDeps {
  registry: PrincipalRegistry
  store: MessageStore
  fwa?: FwaSendPort
  work?: WorkSendPort
  externalDelivery?: ExternalDeliveryPort
  now?: () => Date
}

// ─── Service ─────────────────────────────────────────────────────────

export class MessageService {
  private readonly registry: PrincipalRegistry
  private readonly store: MessageStore
  private fwa?: FwaSendPort
  private workPort?: WorkSendPort
  private externalDelivery?: ExternalDeliveryPort
  private readonly now: () => Date

  constructor(deps: MessageServiceDeps) {
    this.registry = deps.registry
    this.store = deps.store
    this.fwa = deps.fwa
    this.workPort = deps.work
    this.externalDelivery = deps.externalDelivery
    this.now = deps.now ?? (() => new Date())
  }

  /** Set the FWA send port after construction (for cyclic dependency resolution). */
  setFwaSendPort(port: FwaSendPort): void {
    this.fwa = port
  }

  /** Set the Work send port after construction (for cyclic dependency resolution). */
  setWorkSendPort(port: WorkSendPort): void {
    this.workPort = port
  }

  /** Set the external delivery port after construction. */
  setExternalDeliveryPort(port: ExternalDeliveryPort): void {
    this.externalDelivery = port
  }

  canReadWork(principalId: string): boolean {
    const principal = this.registry.principals[principalId]
    return Boolean(principal?.canSend && hasGrant(principal, 'work.read'))
  }

  /**
   * Send a message. This is the single entry point for all message routing.
   *
   * Permission checks:
   * - from must be a can_send principal with message.send grant
   * - to must be an addressable principal, fwa-<id>, or foreman-work
   *
   * Idempotency:
   * - (from, client_message_id) has a unique constraint
   * - Duplicate requests return the first result, no double delivery
   * - Message + idempotency key are persisted BEFORE the target side effect
   *
   * Routing:
   * - External principal (deliveryRoute) → durable outbox
   * - fwa-<24hex> → FwaService (native FIFO)
   * - foreman-work → WorkService (injectable, batch 2)
   *
   * Attachments:
   * - Only forwarded for foreman-work target; rejected for all others.
   */
  async send(req: SendRequest): Promise<SendResult | SendError> {
    // Validate sender
    if (isFwaAddress(req.from)) {
      const senderSessionId = resolveFwaAddress(req.from)
      if (!senderSessionId || !this.fwa?.hasLiveSession(senderSessionId)) {
        return { ok: false, error: PRINCIPAL_ERRORS.unknown_agent_address, message: `unknown sender address: ${req.from}` }
      }
    } else {
      const senderError = validateSender(this.registry, req.from)
      if (senderError) {
        return { ok: false, error: senderError.error, message: senderError.message }
      }
    }

    // Reject attachments for non-work targets
    if (req.attachments && req.attachments.length > 0 && req.to !== FOREMAN_WORK_ADDRESS) {
      return {
        ok: false,
        error: 'attachments_not_supported',
        message: `attachments are only supported for target '${FOREMAN_WORK_ADDRESS}'`,
      }
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

    // Resolve target (side effect: delivery, FWA queuing, etc.)
    const targetResult = await this.resolveTarget(req.to, req.text, req.from, messageId, req.attachments)
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
        ...('attachment_results' in targetResult && (targetResult as { attachment_results?: SendAttachmentResult[] }).attachment_results !== undefined
          ? { attachments: (targetResult as { attachment_results: SendAttachmentResult[] }).attachment_results }
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
    attachments?: SendAttachment[],
  ): Promise<{ target_seq?: number; queue_depth?: number; delivery?: SendResult['delivery']; attachment_results?: SendAttachmentResult[] } | SendError | null> {
    // 1. Check if target is an FWA address
    if (isFwaAddress(to)) {
      return this.resolveFwaTarget(to, text, from, messageId)
    }

    // 2. Check if target is foreman-work
    if (to === FOREMAN_WORK_ADDRESS) {
      return this.resolveWorkTarget(text, from, messageId, attachments)
    }

    // 3. Check if target is a registered principal
    const recipientError = validateRecipient(this.registry, to)
    if (recipientError) {
      return { ok: false as const, error: recipientError.error, message: recipientError.message }
    }

    // 4. Resolve external delivery via durable outbox
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

  private async resolveFwaTarget(
    address: string,
    text: string,
    from: string,
    messageId: string,
  ): Promise<{ target_seq?: number; queue_depth?: number } | SendError | null> {
    const sessionId = resolveFwaAddress(address)
    if (!sessionId) return null // invalid FWA address format

    if (!this.fwa) {
      return { ok: false, error: PRINCIPAL_ERRORS.unknown_agent_address, message: 'FWA service not available' }
    }

    if (!this.fwa.hasLiveSession(sessionId)) {
      return { ok: false, error: PRINCIPAL_ERRORS.unknown_agent_address, message: `no live FWA session for address: ${address}` }
    }

    const result = await this.fwa.sendToSession(sessionId, text, from, messageId)
    return { target_seq: result.target_seq, queue_depth: result.queue_depth }
  }

  private async resolveWorkTarget(
    text: string,
    from: string,
    messageId: string,
    attachments?: SendAttachment[],
  ): Promise<{ target_seq?: number; queue_depth?: number; attachment_results?: SendAttachmentResult[] } | SendError | null> {
    if (!this.workPort) {
      return { ok: false, error: 'work_unavailable', message: 'foreman-work is not available in this runtime' }
    }

    const result = await this.workPort.send(text, from, messageId, attachments)
    return {
      target_seq: result.target_seq,
      queue_depth: result.queue_depth,
      ...(result.attachment_results ? { attachment_results: result.attachment_results } : {}),
    }
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
