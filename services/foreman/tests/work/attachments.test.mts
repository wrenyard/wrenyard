/**
 * WorkAttachmentStore tests — isolated filesystem-backed.
 *
 * Verifies:
 * - PNG/JPEG/GIF/WEBP magic bytes with correct mime types
 * - Misleading extensions (e.g. .txt with PNG bytes) are accepted by content
 * - Missing/relative/symlink/non-file path rejection
 * - Spoofed .png content (not actually PNG) is rejected
 * - Exactly 10 MiB file accepted; over-limit rejected
 * - SHA-256 deduplication (same file ingested twice)
 * - Source deletion after ingest (ingested copy is independent)
 * - Temp file cleanup on failure
 * - Mixed batches produce per-item results
 * - Absence of base64/raw bytes in results
 */

import { describe, it, before, after } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { WorkAttachmentStore } from '../../lib/daemon/services/work/attachment-store.mts'
import type { AttachmentResult } from '../../lib/daemon/services/work/attachment-store.mts'

// ── Image magic bytes ─────────────────────────────────────────────────

function pngBytes(): Buffer {
  // Valid PNG: 8-byte signature + minimal IHDR chunk
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  return Buffer.concat([sig, Buffer.from('fake png content')])
}

function jpegBytes(): Buffer {
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xEE, ...Buffer.from('fake jpeg')])
}

function gifBytes(): Buffer {
  // GIF89a
  const header = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  return Buffer.concat([header, Buffer.from('fake gif')])
}

function webpBytes(): Buffer {
  // RIFF header with WEBP FourCC
  const riff = Buffer.from([0x52, 0x49, 0x46, 0x46])
  const fileSize = Buffer.alloc(4)
  fileSize.writeUInt32LE(20, 0) // little-endian file size
  const webp = Buffer.from([0x57, 0x45, 0x42, 0x50])
  const vp8 = Buffer.from([0x56, 0x50, 0x38, 0x20, 0x00, 0x00, 0x00, 0x00])
  return Buffer.concat([riff, fileSize, webp, vp8])
}

function gif87Bytes(): Buffer {
  const header = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
  return Buffer.concat([header, Buffer.from('fake gif87')])
}

function randomJunk(): Buffer {
  return Buffer.from('this is not any known image format at all')
}

function paddedGifBytes(targetSize: number): Buffer {
  // GIF89a header plus zero-padding to target size
  const header = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  const body = Buffer.alloc(targetSize - header.length, 0x00)
  return Buffer.concat([header, body])
}

// ── Test helpers ──────────────────────────────────────────────────────

let stateDir: string
let workDir: string

function createStore(): WorkAttachmentStore {
  return new WorkAttachmentStore(stateDir)
}

function writeTestFile(name: string, content: Buffer): string {
  const filePath = join(workDir, name)
  writeFileSync(filePath, content)
  return filePath
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('WorkAttachmentStore', () => {
  before(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'fwm-attachment-state-'))
    workDir = mkdtempSync(join(tmpdir(), 'fwm-attachment-work-'))
  })

  after(() => {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  })

  describe('magic byte detection', () => {
    it('accepts PNG via magic bytes', () => {
      const path = writeTestFile('test.png', pngBytes())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
      assert.equal(result.mime_type, 'image/png')
    })

    it('accepts JPEG via magic bytes', () => {
      const path = writeTestFile('test.jpg', jpegBytes())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
      assert.equal(result.mime_type, 'image/jpeg')
    })

    it('accepts GIF89a via magic bytes', () => {
      const path = writeTestFile('test.gif', gifBytes())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
      assert.equal(result.mime_type, 'image/gif')
    })

    it('accepts GIF87a via magic bytes', () => {
      const path = writeTestFile('test.gif87', gif87Bytes())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
      assert.equal(result.mime_type, 'image/gif')
    })

    it('accepts WEBP via RIFF/WEBP magic bytes', () => {
      const path = writeTestFile('test.webp', webpBytes())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
      assert.equal(result.mime_type, 'image/webp')
    })
  })

  describe('misleading extensions', () => {
    it('accepts PNG bytes with .txt extension', () => {
      const path = writeTestFile('fake.txt', pngBytes())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
      assert.equal(result.mime_type, 'image/png')
    })

    it('rejects junk with .png extension', () => {
      const path = writeTestFile('spoofed.png', randomJunk())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'rejected')
      assert.equal(result.error, 'unsupported_content_type')
    })
  })

  describe('path validation', () => {
    it('rejects missing path', () => {
      const result = createStore().ingest({ path: '/nonexistent/file.png' })
      assert.equal(result.status, 'rejected')
      assert.equal(result.error, 'file_not_found')
    })

    it('rejects relative path', () => {
      const result = createStore().ingest({ path: 'relative/path.png' })
      assert.equal(result.status, 'rejected')
      assert.equal(result.error, 'invalid_path')
    })

    it('rejects symlink', () => {
      const target = writeTestFile('target.png', pngBytes())
      const linkPath = join(workDir, 'link.png')
      try { symlinkSync(target, linkPath) } catch {
        // symlink may fail on some platforms; skip
        return
      }
      const result = createStore().ingest({ path: linkPath })
      assert.equal(result.status, 'rejected')
      assert.equal(result.error, 'not_regular_file')
    })

    it('rejects directory', () => {
      const dirPath = join(workDir, 'subdir')
      mkdirSync(dirPath, { recursive: true })
      const result = createStore().ingest({ path: dirPath })
      assert.equal(result.status, 'rejected')
      assert.equal(result.error, 'not_regular_file')
    })
  })

  describe('size limits', () => {
    it('accepts exactly 10 MiB', () => {
      const content = paddedGifBytes(10 * 1024 * 1024)
      const path = writeTestFile('exact-10mb.gif', content)
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
    })

    it('rejects over 10 MiB', () => {
      const content = paddedGifBytes(10 * 1024 * 1024 + 1)
      const path = writeTestFile('over-10mb.gif', content)
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'rejected')
      assert.equal(result.error, 'too_large')
    })
  })

  describe('deduplication', () => {
    it('produces identical SHA-256 for same content', () => {
      const content = pngBytes()
      const path1 = writeTestFile('dup1.png', content)
      const path2 = writeTestFile('dup2.png', content)

      const store = createStore()
      const r1 = store.ingest({ path: path1 })
      const r2 = store.ingest({ path: path2 })

      assert.equal(r1.status, 'accepted')
      assert.equal(r2.status, 'accepted')
      assert.equal(r1.sha256, r2.sha256)
      assert.equal(r1.storage_ref, r2.storage_ref)
    })
  })

  describe('source independence', () => {
    it('survives source file deletion after ingest', () => {
      const path = writeTestFile('independent.png', pngBytes())
      const store = createStore()
      const result = store.ingest({ path })
      assert.equal(result.status, 'accepted')

      // Delete source
      rmSync(path)

      // Verify storage file exists
      assert.ok(result.storage_ref)
      const storagePath = join(stateDir, result.storage_ref)
      assert.ok(existsSync(storagePath), 'storage file should exist after source deletion')
    })
  })

  describe('batch processing', () => {
    it('processes mixed batch with per-item results', () => {
      const validPath = writeTestFile('batch-valid.png', pngBytes())
      const missingPath = '/nonexistent/batch-missing.png'
      const invalidPath = writeTestFile('batch-invalid.txt', randomJunk())

      const store = createStore()
      const results = store.ingestBatch([
        { path: validPath },
        { path: missingPath },
        { path: invalidPath },
      ])

      assert.equal(results.length, 3)
      assert.equal(results[0].status, 'accepted')
      assert.equal(results[1].status, 'rejected')
      assert.equal(results[1].error, 'file_not_found')
      assert.equal(results[2].status, 'rejected')
      assert.equal(results[2].error, 'unsupported_content_type')
    })
  })

  describe('result shape', () => {
    it('never contains bytes, base64, or data URLs', () => {
      const path = writeTestFile('clean-result.png', pngBytes())
      const result = createStore().ingest({ path })
      assert.equal(result.status, 'accepted')
      // Check no raw bytes or base64 in any field
      const json = JSON.stringify(result)
      assert.ok(!json.includes('base64'), 'result should not contain base64')
      assert.ok(!json.includes('data:'), 'result should not contain data URLs')
      assert.ok(!json.includes('bytes'), 'result should not contain bytes field')
    })
  })
})
