import {
  NdjsonFrameError,
  type FrameDecoder,
  type FrameDecoderOptions,
  type NdjsonChunk,
} from './types.mts'

const DEFAULT_ENCODING: BufferEncoding = 'utf8'

export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

export function decodeFrame(line: string): unknown {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new NdjsonFrameError('Invalid NDJSON frame', text, error)
  }
}

export function createFrameDecoder(options: FrameDecoderOptions = {}): FrameDecoder {
  let buffer = ''
  const encoding = options.encoding ?? DEFAULT_ENCODING

  function emitLine(line: string, messages: unknown[]): void {
    if (!line.trim()) return

    try {
      const message = decodeFrame(line)
      messages.push(message)
      options.onMessage?.(message)
    } catch (error) {
      const frameError = error instanceof NdjsonFrameError
        ? error
        : new NdjsonFrameError('Invalid NDJSON frame', line, error)

      if (options.onError) {
        options.onError(frameError, line)
        return
      }

      throw frameError
    }
  }

  return {
    get buffered(): string {
      return buffer
    },

    write(chunk: NdjsonChunk): unknown[] {
      const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding)
      buffer += text

      const messages: unknown[] = []
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        emitLine(line, messages)
        newlineIndex = buffer.indexOf('\n')
      }

      return messages
    },

    reset(): void {
      buffer = ''
    },
  }
}
