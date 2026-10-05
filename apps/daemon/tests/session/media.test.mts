/**
 * Focused FileStore tests.
 *
 * These tests use real `sharp` codecs on generated temporary fixtures. They
 * cover batch attachment import (sequence numbering, restart/concurrent
 * reservations, whole-batch validation), text/binary description, in-place
 * image previews (resize, alpha, persistence) and Task artifact description
 * without any copy into the session. No model calls are made.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  FileStore,
  MEDIA_LIMITS,
  type AttachmentInput,
  type SessionFile,
} from '@wrenyard/session'

interface SharpPipeline {
  png(): SharpPipeline
  ensureAlpha(alpha?: number): SharpPipeline
  toBuffer(): Promise<Buffer>
}

interface SharpFactory {
  (options: { create: { width: number; height: number; channels: number; background: string } }): SharpPipeline
}

// sharp is owned by the session package; resolve it through that manifest so the
// daemon test does not need its own copy.
const requireFromSession = createRequire(
  fileURLToPath(new URL('../../../../packages/features/session/package.json', import.meta.url)),
)
const sharp = requireFromSession('sharp') as SharpFactory

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024

let root: string

beforeEach(() => {
  // Canonicalize the temporary root so assertions match resolve() on the same
  // real file on platforms where /var is a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wrenyard-filestore-test-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function store(): FileStore {
  return new FileStore({ stateRoot: root })
}

function filesDir(sessionId: string): string {
  return join(root, 'sessions', sessionId, 'files')
}

function attachment(path: string, name?: string): AttachmentInput {
  return { path, ...(name === undefined ? {} : { name }) }
}

function writeFixture(name: string, bytes: Buffer | string): string {
  const file = join(root, name)
  writeFileSync(file, bytes)
  return file
}

async function pngBytes(width: number, height: number, background = '#3355ff'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer()
}

function sequenceOf(file: SessionFile): number {
  const match = /^(\d+)-/u.exec(basename(file.path))
  assert.ok(match !== null, `stored file is numbered: ${basename(file.path)}`)
  return Number(match![1])
}

describe('FileStore import numbering', () => {
  it('numbers files across batches, a fresh instance and concurrent reservations', async () => {
    const first = await store().importAttachments('sess-num', [
      attachment(writeFixture('a.txt', 'alpha'), 'a.txt'),
      attachment(writeFixture('b.txt', 'beta'), 'b.txt'),
    ])
    assert.deepEqual(first.map(sequenceOf), [1, 2], 'one batch numbers its files in order')

    const afterRestart = await new FileStore({ stateRoot: root }).importAttachments('sess-num', [
      attachment(writeFixture('c.txt', 'gamma'), 'c.txt'),
    ])
    assert.deepEqual(afterRestart.map(sequenceOf), [3], 'a fresh instance continues from the existing directory')

    const media = store()
    const [left, right] = await Promise.all([
      media.importAttachments('sess-num', [attachment(writeFixture('d.txt', 'delta'), 'd.txt')]),
      media.importAttachments('sess-num', [attachment(writeFixture('e.txt', 'epsilon'), 'e.txt')]),
    ])
    const concurrent = [...left, ...right].map(sequenceOf)
    assert.equal(new Set(concurrent).size, 2, 'concurrent admissions never collide on a sequence')
    assert.ok(concurrent.every((value) => value >= 4), 'concurrent admissions continue past the used numbers')
  })

  it('validates the whole batch before copying any file', async () => {
    const good = writeFixture('good.txt', 'ok')
    await assert.rejects(
      () => store().importAttachments('sess-batch', [
        attachment(good, 'good.txt'),
        attachment(join(root, 'absent.txt')),
      ]),
    )
    assert.equal(existsSync(filesDir('sess-batch')), false, 'a rejected batch writes nothing')
  })

  it('rejects an over-large batch by item count', async () => {
    const inline = Array.from(
      { length: MEDIA_LIMITS.maxBatchItems + 1 },
      () => ({ dataUrl: 'data:text/plain;base64,b2s=' }),
    )
    await assert.rejects(() => store().importAttachments('sess-many', inline))
  })

  it('rejects invalid session and task-run directory segments', async () => {
    const file = writeFixture('seg.txt', 'x')
    await assert.rejects(() => store().importAttachments('a/b', [attachment(file, 'seg.txt')]))
    await assert.rejects(() => store().importAttachments('', [attachment(file, 'seg.txt')]))
    await assert.rejects(() => store().importAttachments('.', [attachment(file, 'seg.txt')]))
    await assert.rejects(() => store().importAttachments('..', [attachment(file, 'seg.txt')]))
    await assert.rejects(
      () => store().describeArtifacts({ sessionId: 's', taskRunId: '..', actionId: 'a', artifacts: [] }),
    )
    await assert.rejects(
      () => store().describeArtifacts({ sessionId: 's', taskRunId: 'a/b', actionId: 'a', artifacts: [] }),
    )
  })

  it('preserves a Chinese original basename', async () => {
    const [file] = await store().importAttachments('sess-cn', [
      attachment(writeFixture('source.txt', '内容'), '报告.txt'),
    ])
    assert.ok(file.name.includes('报告'), `original basename is preserved: ${file.name}`)
  })
})

describe('FileStore text and binary description', () => {
  it('keeps an exact unicode text body and its token count', async () => {
    const original = '你好，世界\n'.repeat(50)
    const [file] = await store().importAttachments('sess-text', [
      attachment(writeFixture('notes.txt', original), 'notes.txt'),
    ])
    assert.equal(file.kind, 'file')
    assert.equal(file.mime, 'text/plain')
    assert.equal(file.text, original)
    assert.equal(file.truncated, false)
    assert.equal(file.tokens, file.totalTokens)
    assert.ok((file.tokens ?? 0) > 0)
  })

  it('truncates oversized text at 20000 tokens preserving the exact unicode prefix', async () => {
    const original = 'the quick brown fox jumps over the lazy dog. '.repeat(5000)
    const [file] = await store().importAttachments('sess-big', [
      attachment(writeFixture('big.txt', original), 'big.txt'),
    ])
    assert.equal(file.truncated, true)
    assert.equal(file.tokens, 20_000)
    assert.ok((file.totalTokens ?? 0) > 20_000)
    assert.ok(file.text !== undefined && original.startsWith(file.text), 'the stored text is an exact prefix')
    assert.equal(file.text.includes('\uFFFD'), false, 'no replacement character at the token boundary')
  })

  it('describes a binary file as metadata only', async () => {
    const [file] = await store().importAttachments('sess-bin', [
      attachment(writeFixture('blob.bin', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])), 'blob.bin'),
    ])
    assert.equal(file.kind, 'file')
    assert.equal(file.mime, 'application/octet-stream')
    assert.equal(file.text, undefined)
    assert.equal(file.tokens, undefined)
  })
})

describe('FileStore image previews', () => {
  it('persists a bounded preview beside an intact canonical original', async () => {
    const bytes = await pngBytes(300, 300)
    const [file] = await store().importAttachments('sess-img', [
      attachment(writeFixture('photo.png', bytes), 'photo.png'),
    ])
    assert.equal(file.kind, 'image')
    assert.equal(file.mime, 'image/png')
    assert.equal(file.width, 300)
    assert.equal(file.height, 300)
    assert.ok(file.processedPath !== undefined)
    assert.equal(dirname(file.processedPath), dirname(file.path), 'the preview lives beside the original')
    assert.ok(existsSync(file.processedPath))
    assert.equal(file.processedWidth, 300)
    assert.equal(file.processedHeight, 300)
    assert.ok((file.processedBytes ?? 0) <= MAX_PREVIEW_BYTES)
    assert.deepEqual(readFileSync(file.path), bytes, 'the canonical original is never re-encoded')
  })

  it('caps a large preview at a 1568 long edge within 4MiB', async () => {
    const [file] = await store().importAttachments('sess-huge', [
      attachment(writeFixture('huge.png', await pngBytes(6000, 4000)), 'huge.png'),
    ])
    assert.equal(file.processedWidth, 1568)
    assert.equal(file.processedHeight, Math.round(4000 * (1568 / 6000)))
    assert.equal(Math.max(file.processedWidth ?? 0, file.processedHeight ?? 0), 1568)
    assert.ok((file.processedBytes ?? 0) <= MAX_PREVIEW_BYTES)
  })

  it('keeps an alpha image as PNG and re-encodes an opaque image to JPEG', async () => {
    const [alpha] = await store().importAttachments('sess-alpha', [
      attachment(writeFixture('alpha.png', await pngBytes(300, 300, '#3355ff80')), 'alpha.png'),
    ])
    assert.equal(alpha.processedMime, 'image/png', 'alpha survives as PNG')

    const opaque = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#3355ff' } })
      .png()
      .toBuffer()
    const [flat] = await store().importAttachments('sess-opaque', [
      attachment(writeFixture('opaque.png', opaque), 'opaque.png'),
    ])
    assert.equal(flat.processedMime, 'image/jpeg', 'an opaque photo is re-encoded to JPEG')
  })

  it('retains the previous preview and produces a new version after mutation and restart', async () => {
    const source = writeFixture('mut.png', await pngBytes(64, 64, '#ff0000'))
    const first = await store().prepareFile(source, { source: 'user' })
    const oldPreview = first.processedPath!
    assert.ok(existsSync(oldPreview))

    writeFileSync(source, await pngBytes(64, 64, '#00ff00'))
    const second = await new FileStore({ stateRoot: root }).prepareFile(source, { source: 'user' })
    assert.notEqual(second.hash, first.hash, 'the content version changes with the source')
    assert.notEqual(second.processedPath, oldPreview, 'a new preview file is written')
    assert.ok(existsSync(oldPreview), 'the previous preview is retained')
    assert.ok(existsSync(second.processedPath!))
  })

  it('reads back a prepared image and rejects one without a preview', async () => {
    const [image] = await store().importAttachments('sess-read', [
      attachment(writeFixture('read.png', await pngBytes(20, 20)), 'read.png'),
    ])
    const read = await store().readImage(image)
    assert.equal(read.mime, image.processedMime)
    assert.ok(read.dataUrl.startsWith(`data:${read.mime};base64,`))

    const [text] = await store().importAttachments('sess-read', [
      attachment(writeFixture('read.txt', 'plain'), 'read.txt'),
    ])
    await assert.rejects(() => store().readImage(text))
  })
})

describe('FileStore task artifacts', () => {
  it('describes artifacts in place and never copies them into the session', async () => {
    const runDir = join(root, 'artifacts', 'run-1')
    mkdirSync(runDir, { recursive: true })
    const artifactPath = join(runDir, '目标图.png')
    writeFileSync(artifactPath, await pngBytes(200, 200, '#123456'))

    const media = store()
    const result = await media.describeArtifacts({
      sessionId: 'sess-task',
      taskRunId: 'run-1',
      actionId: 'a1',
      artifacts: [{ path: artifactPath, kind: 'image', role: 'target', description: '目标画面' }],
    })
    assert.deepEqual(result.errors, [])
    assert.equal(result.files.length, 1)
    const file = result.files[0]!
    assert.equal(file.path, artifactPath, 'the canonical artifact path is kept')
    assert.equal(file.name, '目标图.png', 'the original basename is preserved')
    assert.equal(file.source, 'task')
    assert.equal(file.taskRunId, 'run-1')
    assert.equal(file.actionId, 'a1')
    assert.equal(file.role, 'target')
    assert.equal(file.description, '目标画面')
    assert.equal(dirname(file.processedPath!), runDir, 'the preview is written into the run directory')
    assert.equal(existsSync(join(root, 'sessions', 'sess-task', 'files')), false, 'nothing is copied into the session')

    const image = await media.readImage(file)
    assert.equal(image.mime, file.processedMime)
    assert.ok(image.dataUrl.startsWith(`data:${file.processedMime};base64,`))
  })

  it('rejects an artifact that lives outside its task-run directory', async () => {
    const runDir = join(root, 'artifacts', 'run-1')
    const outside = join(root, 'artifacts', 'run-2')
    mkdirSync(runDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const strayPath = join(outside, 'stray.png')
    writeFileSync(strayPath, await pngBytes(20, 20))

    const result = await store().describeArtifacts({
      sessionId: 'sess-out',
      taskRunId: 'run-1',
      actionId: 'a1',
      artifacts: [{ path: strayPath, kind: 'image' }],
    })
    assert.equal(result.files.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!, /outside its task run directory/u)
  })
})
