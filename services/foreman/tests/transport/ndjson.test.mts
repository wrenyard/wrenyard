import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  NdjsonFrameError,
} from '../../lib/transport/types.mts'
import {
  createFrameDecoder,
  decodeFrame,
  encodeFrame,
} from '../../lib/transport/ndjson.mts'

describe('NDJSON transport framing', () => {
  it('encodes and decodes a single message', () => {
    const message = {
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
      id: 1,
    }

    const frame = encodeFrame(message)

    assert.equal(frame, `${JSON.stringify(message)}\n`)
    assert.deepEqual(decodeFrame(frame.trimEnd()), message)
  })

  it('splits multiple messages from one chunk', () => {
    const decoder = createFrameDecoder()
    const first = { method: 'first' }
    const second = { method: 'second' }

    const messages = decoder.write(`${encodeFrame(first)}${encodeFrame(second)}`)

    assert.deepEqual(messages, [first, second])
    assert.equal(decoder.buffered, '')
  })

  it('recovers a frame split across chunks', () => {
    const decoder = createFrameDecoder()

    assert.deepEqual(decoder.write('{"method":'), [])
    assert.equal(decoder.buffered, '{"method":')
    assert.deepEqual(decoder.write('"split"}\n'), [{ method: 'split' }])
    assert.equal(decoder.buffered, '')
  })

  it('ignores empty lines', () => {
    const decoder = createFrameDecoder()

    assert.deepEqual(decoder.write('\n\r\n  \n{"ok":true}\n'), [{ ok: true }])
  })

  it('throws a clear error for invalid JSON without onError', () => {
    const decoder = createFrameDecoder()

    assert.throws(
      () => decoder.write('{bad json}\n'),
      (error) => {
        assert(error instanceof NdjsonFrameError)
        assert.equal(error.message, 'Invalid NDJSON frame')
        assert.equal(error.line, '{bad json}')
        return true
      },
    )
  })

  it('routes invalid JSON through onError when provided', () => {
    const errors: Array<{ error: NdjsonFrameError, line: string }> = []
    const messages: unknown[] = []
    const decoder = createFrameDecoder({
      onMessage: (message) => messages.push(message),
      onError: (error, line) => errors.push({ error, line }),
    })

    const returned = decoder.write('{bad json}\n{"ok":true}\n')

    assert.equal(errors.length, 1)
    assert(errors[0].error instanceof NdjsonFrameError)
    assert.equal(errors[0].line, '{bad json}')
    assert.deepEqual(messages, [{ ok: true }])
    assert.deepEqual(returned, [{ ok: true }])
  })

  it('does not emit incomplete trailing frames before newline', () => {
    const messages: unknown[] = []
    const decoder = createFrameDecoder({
      onMessage: (message) => messages.push(message),
    })

    assert.deepEqual(decoder.write('{"pending":true}'), [])
    assert.deepEqual(messages, [])
    assert.equal(decoder.buffered, '{"pending":true}')

    assert.deepEqual(decoder.write('\n'), [{ pending: true }])
    assert.deepEqual(messages, [{ pending: true }])
    assert.equal(decoder.buffered, '')
  })

  it('accepts Buffer chunks', () => {
    const decoder = createFrameDecoder()

    assert.deepEqual(decoder.write(Buffer.from('{"from":"buffer"}\n')), [{ from: 'buffer' }])
  })
})
