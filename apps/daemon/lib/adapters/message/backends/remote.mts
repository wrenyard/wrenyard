import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { MessageDeliveryResult, MessageEnvelope, PeerConfig, RemoteChannelConfig } from '../../../message/delivery/types.mts'
import { resolveToken } from '../../../config/index.mts'
import { redactAuthorizationHeader, redactSecrets } from '../../../message/delivery/redact.mts'

export interface RemoteBackendDeps {
  fetch?: typeof globalThis.fetch
  peers?: Record<string, PeerConfig>
}

export function createRemoteBackend(
  cfg: RemoteChannelConfig,
  deps?: RemoteBackendDeps,
): MessageBackend {
  const apiFetch = deps?.fetch ?? globalThis.fetch
  const peers = deps?.peers ?? {}

  return {
    name: 'remote',
    async deliver(event, channel): Promise<MessageDeliveryResult> {
      const peer = peers[cfg.peer]
      if (!peer) {
        return { channel, backend: 'remote', ok: false, error: 'unknown-peer' }
      }

      const token = resolveToken(peer)

      // Increment hops for loop detection on the receiving end
      const currentHops = typeof event.hops === 'number' && Number.isFinite(event.hops) && event.hops >= 0 ? event.hops : 0
      const forwardedEvent: MessageEnvelope = {
        ...event,
        hops: currentHops + 1,
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const url = peer.url.endsWith('/')
        ? `${peer.url}message/deliver`
        : `${peer.url}/message/deliver`

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10_000)

        const response = await apiFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            event: forwardedEvent,
            channel: cfg.channel,
          }),
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          let errorBody = ''
          try {
            errorBody = await response.text()
          } catch {
            // best effort
          }
          // Redact secrets before including error body in delivery error
          const secrets: string[] = token ? [token] : []
          const redacted = redactAuthorizationHeader(redactSecrets(errorBody.slice(0, 200), secrets))
          return {
            channel,
            backend: 'remote',
            ok: false,
            error: `peer returned ${response.status}${redacted ? `: ${redacted}` : ''}`,
          }
        }

        const body = (await response.json()) as { ok?: boolean; deliveries?: MessageDeliveryResult[] }
        const remoteDeliveries = body.deliveries ?? []
        const remoteOk = remoteDeliveries.some((d) => d.ok)

        // Redact upstream errors before including in detail
        const secrets: string[] = token ? [token] : []
        const redactedDeliveries = remoteDeliveries.map((d) => {
          const result: MessageDeliveryResult = { ...d }
          if (d.error) result.error = redactSecrets(d.error, secrets)
          if (d.detail !== undefined) {
            if (typeof d.detail === 'string') {
              result.detail = redactAuthorizationHeader(redactSecrets(d.detail, secrets))
            } else {
              try {
                const json = JSON.stringify(d.detail)
                result.detail = JSON.parse(redactSecrets(json, secrets))
              } catch {
                // omit detail on parse failure
                result.detail = undefined
              }
            }
          }
          return result
        })

        return {
          channel,
          backend: 'remote',
          ok: remoteOk,
          detail: { remoteDeliveries: redactedDeliveries },
        }
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message : String(error)
        const secrets: string[] = token ? [token] : []
        return {
          channel,
          backend: 'remote',
          ok: false,
          error: redactSecrets(redactAuthorizationHeader(rawMsg), secrets),
        }
      }
    },
  }
}
