export interface MessageDeliveryFormatInput {
  taskName: string
  status: 'done' | 'failed' | 'cancelled'
  client?: string | null
  model?: string | null
  turnId?: string
  prUrl: string | null
  duration: string
  summary: string
  originSession?: string
}

export const MAX_MESSAGE_BYTES = 3500
export const MAX_INLINE_CODE_BLOCK_LINES = 18
export const MAX_INLINE_CODE_BLOCK_BYTES = 1200
export const CODE_BLOCK_OMITTED_MARKER = '（代码块已省略）'
export const HTML_ENTITY_REPLACEMENTS: Record<string, string> = {
  '&amp;': '&',
  '&apos;': "'",
  '&#39;': "'",
  '&gt;': '>',
  '&lt;': '<',
  '&quot;': '"',
}

const STATUS_LABELS: Record<string, string> = {
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

interface FenceMarker {
  char: '`' | '~'
  length: number
}

export function parseFenceOpener(line: string): FenceMarker | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/u)
  if (!match) return null

  const marker = match[1]
  const char = marker[0]
  if (char !== '`' && char !== '~') return null

  return { char, length: marker.length }
}

export function isFenceCloser(line: string, fence: FenceMarker): boolean {
  const trimmed = line.trim()
  return trimmed.length >= fence.length && Array.from(trimmed).every((char) => char === fence.char)
}

export function shouldFoldCodeBlock(contentLines: string[]): boolean {
  return contentLines.length > MAX_INLINE_CODE_BLOCK_LINES
    || Buffer.byteLength(contentLines.join('\n'), 'utf8') > MAX_INLINE_CODE_BLOCK_BYTES
}

export function decodeHtmlEntities(message: string): string {
  return message.replace(/&(amp|apos|#39|gt|lt|quot);/giu, (entity) => {
    return HTML_ENTITY_REPLACEMENTS[entity.toLowerCase()] ?? entity
  })
}

export function htmlCodeLanguage(attributes: string): string {
  const match = attributes.match(/\bclass\s*=\s*["'][^"']*\blanguage-([a-z0-9_+.-]+)\b[^"']*["']/iu)
  return match ? match[1] : ''
}

export function trimCodeWrapperNewlines(content: string): string {
  return content.replace(/^\r?\n/u, '').replace(/\r?\n$/u, '')
}

export function fencedCode(language: string, content: string): string {
  return [`\`\`\`${language}`, content, '```'].join('\n')
}

export function normalizeHtmlCodeTags(message: string): string {
  const decoded = decodeHtmlEntities(message)
  const preCodePattern = /<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/giu
  const codePattern = /<code\b([^>]*)>([\s\S]*?)<\/code>/giu
  const withPreBlocks = decoded.replace(preCodePattern, (_match, attributes: string, content: string) => {
    return fencedCode(htmlCodeLanguage(attributes), trimCodeWrapperNewlines(content))
  })

  return withPreBlocks.replace(codePattern, (_match, attributes: string, content: string) => {
    const trimmed = trimCodeWrapperNewlines(content)
    const lines = trimmed.split(/\r?\n/u)
    if (lines.length > 1 || shouldFoldCodeBlock(lines)) {
      return fencedCode(htmlCodeLanguage(attributes), trimmed)
    }
    return trimmed
  })
}

export function foldLongCodeBlocks(message: string): string {
  const lines = message.split('\n')
  const output: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const fence = parseFenceOpener(lines[index])
    if (!fence) {
      output.push(lines[index])
      continue
    }

    const blockLines = [lines[index]]
    let closingIndex = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      blockLines.push(lines[cursor])
      if (isFenceCloser(lines[cursor], fence)) {
        closingIndex = cursor
        break
      }
    }

    const contentLines = closingIndex >= 0 ? blockLines.slice(1, -1) : blockLines.slice(1)
    if (shouldFoldCodeBlock(contentLines)) {
      output.push(CODE_BLOCK_OMITTED_MARKER)
    } else {
      output.push(...blockLines)
    }

    index = closingIndex >= 0 ? closingIndex : lines.length
  }

  return output.join('\n')
}

export function unwrapRemainingCodeBlocks(message: string): string {
  const lines = message.split('\n')
  const output: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const fence = parseFenceOpener(lines[index])
    if (!fence) {
      output.push(lines[index])
      continue
    }

    const contentLines: string[] = []
    let closingIndex = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (isFenceCloser(lines[cursor], fence)) {
        closingIndex = cursor
        break
      }
      contentLines.push(lines[cursor])
    }

    output.push(...contentLines)
    index = closingIndex >= 0 ? closingIndex : lines.length
  }

  return output.join('\n')
}

export function stripKnownHtmlCodeTags(message: string): string {
  return message.replace(/<\/?(?:pre|code)\b[^>]*>/giu, '')
}

export function normalizeMessageCodeBlocks(message: string): string {
  const normalized = normalizeHtmlCodeTags(message)
  const folded = foldLongCodeBlocks(normalized)
  return stripKnownHtmlCodeTags(unwrapRemainingCodeBlocks(folded))
}

export function compactTurnRef(turnId: string): string {
  return /^\d+$/u.test(turnId) ? String(Number.parseInt(turnId, 10)) : turnId
}

export function formatRunMetadata(result: MessageDeliveryFormatInput): string {
  const parts: string[] = []
  if (result.client) {
    parts.push(result.client)
  }
  if (result.duration) parts.push(result.duration)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

export function formatMessageDeliveryText(result: MessageDeliveryFormatInput): string {
  const statusLabel = STATUS_LABELS[result.status] || result.status
  const suffix = result.turnId ? ` #${compactTurnRef(result.turnId)}` : ''
  const metadata = formatRunMetadata(result)
  const lines = [`👷 Foreman · ${result.taskName} · ${statusLabel}${suffix}${metadata}`]
  if (result.summary) lines.push(result.summary)
  if (result.prUrl) lines.push(`PR: ${result.prUrl}`)
  if (result.originSession) lines.push(result.originSession)
  return normalizeMessageCodeBlocks(lines.join('\n'))
}

export function formatSessionStamp(origin: { id: string; label?: string; host?: string }): string {
  const shortId = origin.id.slice(0, 8)
  const label = origin.label ?? '?'
  const host = origin.host ?? '?'
  return `〔session ${shortId} · ${label}@${host}〕`
}

export function formatMessageDeliveryTexts(result: MessageDeliveryFormatInput): string[] {
  return splitForDelivery(formatMessageDeliveryText(result))
}

export function splitForDelivery(message: string): string[] {
  if (Buffer.byteLength(message, 'utf8') <= MAX_MESSAGE_BYTES) return [message]

  let digits = 1
  while (true) {
    const suffixBytes = Buffer.byteLength(`\n（${'9'.repeat(digits)}/${'9'.repeat(digits)}）`, 'utf8')
    const contentBudget = MAX_MESSAGE_BYTES - suffixBytes
    if (contentBudget <= 0) {
      throw new Error('Message byte budget is too small for part suffixes')
    }

    const chunks = splitTextByByteBudget(message, contentBudget)
    const neededDigits = String(chunks.length).length
    if (neededDigits === digits) {
      return chunks.map((chunk, index) => `${chunk}\n（${index + 1}/${chunks.length}）`)
    }
    digits = neededDigits
  }
}

export function splitTextByByteBudget(text: string, byteBudget: number): string[] {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (current && currentBytes + charBytes > byteBudget) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += char
    currentBytes += charBytes
  }

  if (current || chunks.length === 0) chunks.push(current)
  return chunks
}

export function formatMetadata(meta: { client?: string | null; model?: string | null; duration?: string }): string {
  const parts: string[] = []
  if (meta.client) parts.push(meta.client)
  if (meta.model) parts.push(meta.model)
  if (meta.duration) parts.push(meta.duration)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}
