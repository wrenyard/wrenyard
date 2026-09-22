import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
export type ForgeStreamJsonEvent = Record<string, unknown>
const DEFAULT_STREAM_JSON_MAX_LINE_BYTES = 1024 * 1024
export interface ReadStreamJsonOptions { maxLineBytes?: number }

export async function* readStreamJson(
  child: ChildProcess,
  opts: ReadStreamJsonOptions = {},
): AsyncGenerator<ForgeStreamJsonEvent, void, void> {
  if (!child.stdout) {
    throw new Error('Forge child stdout is not readable')
  }

  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_STREAM_JSON_MAX_LINE_BYTES
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new Error(`Forge stream-json max line bytes must be a positive safe integer; received ${maxLineBytes}`)
  }

  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let bufferBytes = 0
  let discardingOversizedLine = false

  for await (const chunk of child.stdout) {
    const text = decodeChunk(decoder, chunk)

    for (const event of appendStreamJsonText(text)) {
      yield event
    }
  }

  for (const event of appendStreamJsonText(decoder.end())) {
    yield event
  }

  if (buffer.trim()) {
    console.warn('[foreman] Dropping incomplete forge stream-json line at EOF')
  }

  function appendStreamJsonText(text: string): ForgeStreamJsonEvent[] {
    const events: ForgeStreamJsonEvent[] = []
    let start = 0

    while (start < text.length) {
      const newlineIndex = text.indexOf('\n', start)
      const hasNewline = newlineIndex !== -1
      const segmentEnd = hasNewline ? newlineIndex : text.length
      const segment = text.slice(start, segmentEnd)

      if (discardingOversizedLine) {
        if (hasNewline) {
          discardingOversizedLine = false
        }
        start = hasNewline ? newlineIndex + 1 : text.length
        continue
      }

      const segmentBytes = Buffer.byteLength(segment)
      const lineBytes = bufferBytes + segmentBytes
      if (lineBytes > maxLineBytes) {
        warnOversizedStreamJsonLine(lineBytes, maxLineBytes)
        buffer = ''
        bufferBytes = 0
        discardingOversizedLine = !hasNewline
        start = hasNewline ? newlineIndex + 1 : text.length
        continue
      }

      if (hasNewline) {
        const line = buffer + segment
        buffer = ''
        bufferBytes = 0

        const event = parseStreamJsonLine(line, 'Skipping malformed forge stream-json line')
        if (event) events.push(event)
      } else {
        buffer += segment
        bufferBytes = lineBytes
      }

      start = hasNewline ? newlineIndex + 1 : text.length
    }

    return events
  }
}

function warnOversizedStreamJsonLine(lineBytes: number, maxLineBytes: number): void {
  console.warn(
    `[foreman] Dropping oversized forge stream-json line: ${lineBytes} bytes exceeds ${maxLineBytes} byte limit`,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decodeChunk(decoder: StringDecoder, chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return decoder.write(chunk)
  if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk))
  return String(chunk)
}

function parseStreamJsonLine(line: string, warningPrefix: string): ForgeStreamJsonEvent | undefined {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!text.trim()) return undefined

  try {
    const parsed = JSON.parse(text) as unknown
    if (isJsonObject(parsed)) return parsed
    console.warn(`[foreman] ${warningPrefix}: expected object`)
    return undefined
  } catch (error) {
    console.warn(`[foreman] ${warningPrefix}: ${errorMessage(error)}`)
    return undefined
  }
}

function isJsonObject(value: unknown): value is ForgeStreamJsonEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
