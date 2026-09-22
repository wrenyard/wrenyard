import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { MessageDeliveryResult, MessageEnvelope, TelegramChannelConfig } from '../../../message/delivery/types.mts'
import { formatMessageDeliveryTexts, formatSessionStamp, type MessageDeliveryFormatInput } from '../../../message/delivery/format.mts'
import { redactTelegramUrl } from '../../../message/delivery/redact.mts'

function resolveBotToken(cfg: TelegramChannelConfig): string {
  if (cfg.token_env) {
    const fromEnv = process.env[cfg.token_env]?.trim()
    if (fromEnv) return fromEnv
  }
  if (cfg.token_file) {
    const fromFile = readFileSync(cfg.token_file, 'utf-8').trim()
    if (fromFile) return fromFile
  }
  throw new Error('telegram backend: no bot token found (token_env or token_file required)')
}

function inputFromEvent(event: MessageEnvelope): MessageDeliveryFormatInput {
  return {
    taskName: event.title,
    status: 'done',
    client: null,
    model: null,
    prUrl: null,
    duration: '',
    summary: event.body,
    originSession: event.refs.originSession ? formatSessionStamp(event.refs.originSession) : undefined,
  }
}

export function createTelegramBackend(
  cfg: TelegramChannelConfig,
  deps?: { fetch?: typeof globalThis.fetch },
): MessageBackend {
  const apiFetch = deps?.fetch ?? globalThis.fetch

  return {
    name: 'telegram',
    async deliver(event, channel): Promise<MessageDeliveryResult> {
      const token = (() => {
        try {
          return resolveBotToken(cfg)
        } catch (error) {
          return null
        }
      })()
      if (!token) {
        return { channel, backend: 'telegram', ok: false, error: 'no bot token configured' }
      }

      const input = inputFromEvent(event)
      const messages = formatMessageDeliveryTexts(input)

      try {
        // Send text messages
        for (const msg of messages) {
          await sendTelegramMessage(apiFetch, token, cfg.chat_id, msg)
        }

        // Send media if present
        if (event.media) {
          try {
            await sendTelegramMedia(apiFetch, token, cfg.chat_id, event.media, event.body)
          } catch (mediaError) {
            // Plain-text fallback for media failure
            try {
              await sendTelegramMessage(
                apiFetch,
                token,
                cfg.chat_id,
                `📎 ${event.title}\n媒体发送失败，已改发纯文本通知。`,
              )
            } catch {
              // Best effort
            }
          }
        }

        return { channel, backend: 'telegram', ok: true }
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message : String(error)
        return {
          channel,
          backend: 'telegram',
          ok: false,
          error: redactTelegramUrl(rawMsg),
        }
      }
    },
  }
}

async function sendTelegramMessage(
  apiFetch: typeof globalThis.fetch,
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  })
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  if (!response.ok) {
    // Extract structured Telegram error fields; never log the raw response body
    // which may contain the bot token in error descriptions.
    let tgDesc = ''
    try {
      const errBody = await response.text()
      const parsed = JSON.parse(errBody) as { description?: unknown }
      if (typeof parsed.description === 'string' && parsed.description.trim()) {
        tgDesc = `: ${parsed.description.trim()}`
      }
    } catch { /* best effort */ }
    throw new Error(`Telegram sendMessage failed: ${response.status}${tgDesc}`)
  }
}

async function sendTelegramMedia(
  apiFetch: typeof globalThis.fetch,
  token: string,
  chatId: string,
  mediaPath: string,
  caption: string,
): Promise<void> {
  const ext = basename(mediaPath).toLowerCase()

  const isVideo = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v'].some((e) => ext.endsWith(e))
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tif', '.tiff'].some((e) => ext.endsWith(e))

  if (!isVideo && !isImage) {
    throw new Error(`Unsupported media type for Telegram: ${ext}`)
  }

  const method = isVideo ? 'sendVideo' : 'sendPhoto'
  const url = `https://api.telegram.org/bot${token}/${method}`

  const fileData = readFileSync(mediaPath)
  // Use a simple boundary-based multipart approach via fetch
  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`

  const parts: Buffer[] = []
  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf-8'))
  }
  const addFile = (name: string, filename: string, data: Buffer, contentType: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf-8',
    ))
    parts.push(data)
    parts.push(Buffer.from('\r\n', 'utf-8'))
  }

  addField('chat_id', chatId)
  if (caption) addField('caption', caption.slice(0, 200))
  const contentType = isVideo ? 'video/mp4' : 'image/jpeg'
  addFile(method === 'sendVideo' ? 'video' : 'photo', basename(mediaPath), fileData, contentType)
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))

  const response = await apiFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  })
  if (!response.ok) {
    let tgDesc = ''
    try {
      const errBody = await response.text()
      const parsed = JSON.parse(errBody) as { description?: unknown }
      if (typeof parsed.description === 'string' && parsed.description.trim()) {
        tgDesc = `: ${parsed.description.trim()}`
      }
    } catch { /* best effort */ }
    throw new Error(`Telegram ${method} failed: ${response.status}${tgDesc}`)
  }
}
