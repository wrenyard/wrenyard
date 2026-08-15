export type NdjsonChunk = Buffer | string

export interface FrameDecoderOptions {
  encoding?: BufferEncoding
  onMessage?: (message: unknown) => void
  onError?: (error: NdjsonFrameError, line: string) => void
}

export interface FrameDecoder {
  readonly buffered: string
  write(chunk: NdjsonChunk): unknown[]
  reset(): void
}

export class NdjsonFrameError extends Error {
  readonly line: string
  readonly cause?: unknown

  constructor(message: string, line: string, cause?: unknown) {
    super(message)
    this.name = 'NdjsonFrameError'
    this.line = line
    this.cause = cause
  }
}
