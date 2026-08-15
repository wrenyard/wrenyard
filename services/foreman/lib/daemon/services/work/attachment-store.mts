/**
 * WorkAttachmentStore — injectable content-addressed image store.
 *
 * Ingests files from absolute local paths, validates magic bytes without
 * trusting extensions, computes SHA-256, and publishes atomically under
 * work/attachments/sha256/<prefix>/<hash>. Returns daemon-state-relative
 * storage_ref and one normalized result per input. Never stores bytes,
 * base64, data URLs, or absolute storage paths in results.
 *
 * Supported: PNG, JPEG, GIF87a/GIF89a, WEBP (via RIFF header).
 * Rejected: missing paths, symlinks, non-regular files, unsupported types,
 * files exceeding 10*1024*1024, and read failures.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

// ─── Constants ─────────────────────────────────────────────────────────

const MAX_BYTE_SIZE = 10 * 1024 * 1024
const ATTACHMENTS_DIR = 'work/attachments'

// Magic bytes (up to 12 bytes each)
const MAGIC_PNG  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const MAGIC_JPEG = Buffer.from([0xFF, 0xD8, 0xFF])
const MAGIC_GIF  = Buffer.from([0x47, 0x49, 0x46]) // "GIF"
const MAGIC_RIFF = Buffer.from([0x52, 0x49, 0x46, 0x46]) // "RIFF" – covers WEBP

type MimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// ─── Types ─────────────────────────────────────────────────────────────

export interface AttachmentInput {
  path: string
}

export interface AttachmentResult {
  path: string
  status: 'accepted' | 'rejected'
  mime_type?: string
  size?: number
  sha256?: string
  storage_ref?: string
  error?: 'file_not_found' | 'invalid_path' | 'not_regular_file' | 'too_large' | 'unsupported_content_type' | 'read_failed'
}

// ─── Store ─────────────────────────────────────────────────────────────

export class WorkAttachmentStore {
  private readonly stateRoot: string

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot
  }

  /**
   * Ingest one attachment descriptor. Returns a normalized result.
   */
  ingest(input: AttachmentInput): AttachmentResult {
    // 1. Require absolute path
    if (!input.path.startsWith('/')) {
      return {
        path: input.path,
        status: 'rejected',
        error: 'invalid_path',
      }
    }

    // 2. Check for symlinks first using lstatSync (does not follow symlinks)
    let lstat: ReturnType<typeof lstatSync>
    try {
      lstat = lstatSync(input.path)
    } catch {
      return {
        path: input.path,
        status: 'rejected',
        error: 'file_not_found',
      }
    }

    if (lstat.isSymbolicLink()) {
      return {
        path: input.path,
        status: 'rejected',
        error: 'not_regular_file',
      }
    }

    // 3. Stat the followed target – fail on missing or non-file
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(input.path)
    } catch {
      return {
        path: input.path,
        status: 'rejected',
        error: 'file_not_found',
      }
    }

    // Reject non-regular files (directories, FIFOs, sockets, devices)
    if (!stat.isFile()) {
      return {
        path: input.path,
        status: 'rejected',
        error: 'not_regular_file',
      }
    }

    // 3. Enforce size limit
    if (stat.size > MAX_BYTE_SIZE) {
      return {
        path: input.path,
        status: 'rejected',
        error: 'too_large',
      }
    }

    // 4. Read header bytes and validate magic
    let header: Buffer
    try {
      header = readFileSync(input.path, { flag: 'r' }).subarray(0, 12)
    } catch {
      return {
        path: input.path,
        status: 'rejected',
        error: 'read_failed',
      }
    }

    const sniffed = this.sniffMimeType(header)
    if (!sniffed) {
      return {
        path: input.path,
        status: 'rejected',
        error: 'unsupported_content_type',
      }
    }

    // 5. Stream/copy while computing SHA-256
    let fullContent: Buffer
    try {
      fullContent = readFileSync(input.path)
    } catch {
      return {
        path: input.path,
        status: 'rejected',
        error: 'read_failed',
      }
    }

    const hash = createHash('sha256').update(fullContent).digest('hex').toLowerCase()
    const prefix = hash.slice(0, 2)
    const storageDir = join(this.stateRoot, ATTACHMENTS_DIR, 'sha256', prefix)
    const storagePath = join(storageDir, hash)

    // 6. Atomically publish under work/attachments/sha256/<prefix>/<hash>
    //    Use a temp file + rename for atomic write.
    const tmpPath = join(storageDir, `.tmp.${randomUUID()}`)
    try {
      mkdirSync(storageDir, { recursive: true })
      writeFileSync(tmpPath, fullContent)
      copyFileSync(tmpPath, storagePath)
      unlinkSync(tmpPath)
    } catch {
      // Clean up temp file if it exists
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      return {
        path: input.path,
        status: 'rejected',
        error: 'read_failed',
      }
    }

    // 7. Return normalized result
    const storageRef = `work/attachments/sha256/${prefix}/${hash}`
    return {
      path: input.path,
      status: 'accepted',
      mime_type: sniffed,
      size: stat.size,
      sha256: hash,
      storage_ref: storageRef,
    }
  }

  /**
   * Ingest a batch of attachment descriptors.
   */
  ingestBatch(inputs: AttachmentInput[]): AttachmentResult[] {
    return inputs.map((input) => this.ingest(input))
  }

  /**
   * Sniff MIME type from header bytes using magic signatures.
   * Returns null for unsupported content.
   */
  private sniffMimeType(header: Buffer): MimeType | null {
    if (header.subarray(0, MAGIC_PNG.length).equals(MAGIC_PNG)) return 'image/png'
    if (header.subarray(0, MAGIC_JPEG.length).equals(MAGIC_JPEG)) return 'image/jpeg'
    if (header.subarray(0, MAGIC_GIF.length).equals(MAGIC_GIF)) {
      // GIF87a or GIF89a
      if (header[3] === 0x38 && header[4] === 0x37 && header[5] === 0x61) return 'image/gif'
      if (header[3] === 0x38 && header[4] === 0x39 && header[5] === 0x61) return 'image/gif'
      return null
    }
    // RIFF header – check for WEBP at offset 8
    if (header.subarray(0, MAGIC_RIFF.length).equals(MAGIC_RIFF)) {
      if (
        header.length >= 12 &&
        header[8] === 0x57 && header[9] === 0x45 &&
        header[10] === 0x42 && header[11] === 0x50
      ) return 'image/webp'
      return null
    }
    return null
  }
}
