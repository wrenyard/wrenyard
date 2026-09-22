import type { ChannelConfig, CcChannelConfig, MessageDeliveryResult, MessageEnvelope } from '../../../message/delivery/types.mts'
import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { BackendDeps, McpConnection } from './index.mts'
import { recordOrigin } from './index.mts'

function buildParams(event: MessageEnvelope): Record<string, unknown> {
  const text = `${event.title}\n${event.body}`
  const meta: Record<string, unknown> = {
    source: 'foreman',
    kind: event.kind,
    severity: event.severity,
    refs: event.refs,
  }
  if (event.origin) {
    meta.origin = event.origin
  }
  return { content: text, meta }
}

export function createCcChannelBackend(
  _name: string,
  _cfg: ChannelConfig & CcChannelConfig,
  deps?: BackendDeps,
): MessageBackend {
  const connections = deps?.connections ?? new Map<string, McpConnection>()

  return {
    name: 'cc-channel',
    async deliver(event: MessageEnvelope, channel: string): Promise<MessageDeliveryResult> {
      const params = buildParams(event)
      const msg = { method: 'notifications/claude/channel', params }

      // 1. Try the originating connection captured when Foreman emitted the event.
      const originating = findEventConnection(event, connections)
      if (originating) {
        try {
          originating.sendNotification(msg)
          if (event.origin) recordOrigin(originating, event.origin)
          return { channel, backend: 'cc-channel', ok: true }
        } catch {
          // Originating failed — fall through to broadcast (excluding it)
        }
      }

      // 2. Broadcast to all other channel-capable connections
      const broadcastTargets = [...connections.values()].filter(
        (c) => c.channelCapable && c.id !== originating?.id,
      )

      if (broadcastTargets.length === 0) {
        return {
          channel,
          backend: 'cc-channel',
          ok: false,
          error: 'no-channel-connection',
        }
      }

      let ok = true
      let error: string | undefined

      for (const conn of broadcastTargets) {
        try {
          conn.sendNotification(msg)
          if (event.origin) recordOrigin(conn, event.origin)
        } catch (err: unknown) {
          ok = false
          error = err instanceof Error ? err.message : String(err)
        }
      }

      return {
        channel,
        backend: 'cc-channel',
        ok,
        ...(error ? { error } : {}),
      }
    },
  }
}

/**
 * Targeted delivery: send a message envelope to ONE specific connection by id.
 * Bypasses origin resolution and broadcast.
 *
 * Errors:
 *  - unknown connId  → failed delivery with reason "no-such-connection"
 *  - send throws      → failed delivery with reason = error message
 */
export function deliverToConnection(
  deps: BackendDeps,
  connId: string,
  event: MessageEnvelope,
): MessageDeliveryResult {
  const connections = deps?.connections
  const conn = connections?.get(connId)

  if (!conn) {
    return {
      channel: connId,
      backend: 'cc-channel',
      ok: false,
      error: 'no-such-connection',
    }
  }

  const params = buildParams(event)
  const msg = { method: 'notifications/claude/channel', params }

  try {
    conn.sendNotification(msg)
    if (event.origin) recordOrigin(conn, event.origin)
    return { channel: connId, backend: 'cc-channel', ok: true }
  } catch (err: unknown) {
    return {
      channel: connId,
      backend: 'cc-channel',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function findEventConnection(
  event: MessageEnvelope,
  connections: Map<string, McpConnection>,
): McpConnection | undefined {
  const connectionId = event.originatingConnectionId
  if (!connectionId) return undefined
  const conn = connections.get(connectionId)
  return conn?.channelCapable ? conn : undefined
}
