import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { MessageDeliveryResult, MessageEnvelope, WecomChannelConfig } from '../../../message/delivery/types.mts'
import { formatSessionStamp } from '../../../message/delivery/format.mts'
import { redactSecrets, redactWecomUrl } from '../../../message/delivery/redact.mts'

function resolveWebhookUrl(cfg: WecomChannelConfig): string {
  if (cfg.webhook_env) {
    const fromEnv = process.env[cfg.webhook_env]?.trim()
    if (fromEnv) return fromEnv
  }
  if (cfg.webhook_file) {
    const fromFile = readFileSync(cfg.webhook_file, 'utf-8').trim()
    if (fromFile) return fromFile
  }
  throw new Error('wecom backend: no webhook URL found (webhook_env or webhook_file required)')
}

const SEVERITY_COLORS: Record<string, string> = {
  info: 'info',
  success: 'info',
  warning: 'warning',
  error: 'warning',
}

export function createWecomBackend(
  cfg: WecomChannelConfig,
  deps?: { fetch?: typeof globalThis.fetch },
): MessageBackend {
  const apiFetch = deps?.fetch ?? globalThis.fetch

  return {
    name: 'wecom',
    async deliver(event, channel): Promise<MessageDeliveryResult> {
      const webhookUrl = (() => {
        try {
          return resolveWebhookUrl(cfg)
        } catch {
          return null
        }
      })()
      if (!webhookUrl) {
        return { channel, backend: 'wecom', ok: false, error: 'no webhook URL configured' }
      }

      const severityColor = SEVERITY_COLORS[event.severity] ?? 'info'

      // Try to send media as image if available
      if (event.media) {
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']
        const ext = event.media.toLowerCase()
        const isImage = imageExts.some((e) => ext.endsWith(e))
        if (isImage) {
          try {
            const data = readFileSync(event.media)
            const base64 = data.toString('base64')
            const md5 = createHash('md5').update(data).digest('hex')
            const imgBody = JSON.stringify({
              msgtype: 'image',
              image: { base64, md5 },
            })
            const imgResp = await apiFetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: imgBody,
            })
            if (imgResp.ok) {
              return { channel, backend: 'wecom', ok: true }
            }
            // Fall through to text fallback
          } catch {
            // Fall through to text fallback
          }
        }
      }

      // Text/markdown message
      const title = event.title ? `**${event.title}**` : ''
      const body = event.body
      const severityLabel = event.severity !== 'info'
        ? `<font color="${severityColor}">[${event.severity}]</font> `
        : ''
      const markdown = [
        title,
        `${severityLabel}${body}`,
        ...(event.refs.originSession ? [formatSessionStamp(event.refs.originSession)] : []),
      ].filter(Boolean).join('\n')

      try {
        const resp = await apiFetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content: markdown },
          }),
        })
        if (resp.ok) {
          return { channel, backend: 'wecom', ok: true }
        }
        // Extract structured error fields — avoid leaking the full response body
        // which may contain the webhook URL or key.
        let errCode = 'unknown'
        let errMsg = `HTTP ${resp.status}`
        try {
          const errBody = await resp.text()
          const parsed = JSON.parse(errBody) as { errcode?: unknown; errmsg?: unknown }
          if (typeof parsed.errcode === 'number') errCode = String(parsed.errcode)
          if (typeof parsed.errmsg === 'string' && parsed.errmsg.trim()) {
            // Redact webhook key from WeCom error messages before use
            let redactedMsg = parsed.errmsg.trim()
            try {
              const parsedUrl = new URL(webhookUrl)
              const webhookKey = parsedUrl.searchParams.get('key')
              if (webhookKey) {
                redactedMsg = redactSecrets(redactedMsg, [webhookKey])
              }
            } catch { /* best effort */ }
            errMsg = redactWecomUrl(redactedMsg)
          }
        } catch { /* best effort */ }
        return { channel, backend: 'wecom', ok: false, error: `WeCom webhook returned ${resp.status} (errcode=${errCode}): ${errMsg}` }
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message : String(error)
        return { channel, backend: 'wecom', ok: false, error: redactWecomUrl(rawMsg) }
      }
    },
  }
}
