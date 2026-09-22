import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { MessageDeliveryResult, MessageEnvelope, WebhookChannelConfig } from '../../../message/delivery/types.mts'

function buildPayload(event: MessageEnvelope, config: WebhookChannelConfig): unknown {
  if (config.template) {
    const body: Record<string, unknown> = {}
    for (const [key, pattern] of Object.entries(config.template)) {
      const value = substituteTemplate(pattern, event)
      // Support dot-notation for nested objects (e.g. "refs.taskId" → { refs: { taskId: ... } })
      setNestedKey(body, key, value)
    }
    // Clean up empty nested objects: remove refs if all values are empty strings
    compactNested(body)
    return body
  }
  return event
}

function setNestedKey(obj: Record<string, unknown>, key: string, value: string): void {
  const parts = key.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function compactNested(obj: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const child = val as Record<string, unknown>
      compactNested(child)
      // Remove empty object if all values are empty strings
      const allEmpty = Object.keys(child).length > 0
        && Object.values(child).every((v) => v === '')
      if (allEmpty) {
        delete obj[key]
      }
    }
  }
}

function substituteTemplate(pattern: string, event: MessageEnvelope): string {
  return pattern.replace(/\{\{(\w+)\}\}/g, (_match, field: string) => {
    if (field === 'id') return event.id
    if (field === 'kind') return event.kind
    if (field === 'severity') return event.severity
    if (field === 'title') return event.title
    if (field === 'body') return event.body
    if (field === 'media') return event.media ?? ''
    if (field === 'ts') return event.ts
    if (field === 'hops') return String(event.hops ?? 0)
    if (field === 'taskId') return event.refs.taskId ?? ''
    if (field === 'workflowId') return event.refs.workflowId ?? ''
    if (field === 'sessionId') return event.refs.sessionId ?? ''
    if (field === 'project') return event.refs.project ?? ''
    if (field === 'channel' && event.origin) return event.origin.channel
    if (field === 'peer' && event.origin) return event.origin.peer ?? ''
    if (field === 'thread' && event.origin) return event.origin.thread ?? ''
    if (field === 'sender' && event.origin) return event.origin.sender ?? ''
    return `{{${field}}}`
  })
}

export function createWebhookBackend(
  config: WebhookChannelConfig,
  deps?: { fetch?: typeof globalThis.fetch },
): MessageBackend {
  const apiFetch = deps?.fetch ?? globalThis.fetch

  return {
    name: 'webhook',
    async deliver(event, channel): Promise<MessageDeliveryResult> {
      const payload = buildPayload(event, config)
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(config.headers ?? {}),
        }
        const response = await apiFetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          return {
            channel,
            backend: 'webhook',
            ok: false,
            error: `webhook returned ${response.status}: ${text.slice(0, 200)}`,
          }
        }
        return { channel, backend: 'webhook', ok: true }
      } catch (error) {
        return {
          channel,
          backend: 'webhook',
          ok: false,
          error: (error as Error).message,
        }
      }
    },
  }
}
