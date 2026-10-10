/**
 * session files: batch attachment import, in-place file description and image
 * preview reads. No file bytes ever enter the ledger; every derived value is
 * metadata only.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import sharp from 'sharp';
import type { AttachmentInput, SessionFile } from '@wrenyard/protocol';
import { messageOf } from './errors.ts';

export type { AttachmentInput, SessionFile } from '@wrenyard/protocol';

/** A Task-declared output file, mirroring the runtime artifact shape. */
export interface TaskArtifact {
  path: string;
  kind: 'image' | 'file';
  role?: string;
  description?: string;
}

/** Hard import limits shared by attachments and artifacts. */
export const MEDIA_LIMITS = {
  /** Per-file byte cap at import time (source file). */
  maxFileBytes: 64 * 1024 * 1024,
  /** Combined byte cap for one attachment batch. */
  maxBatchBytes: 128 * 1024 * 1024,
  /** Maximum number of attachments in one batch. */
  maxBatchItems: 128,
} as const;

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_LONG_EDGE = 1568;
const TEXT_TOKEN_CAP = 20_000;
const TEXT_ENCODING = getEncoding('cl100k_base');
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const DATA_URL_PATTERN = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/u;

/** Detect a supported image container from its leading bytes. */
function detectImageFormat(bytes: Uint8Array): { mime: string; ext: string } | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a
    && bytes[7] === 0x0a) return { mime: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42
    && bytes[11] === 0x50) return { mime: 'image/webp', ext: 'webp' };
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  return undefined;
}

/** Strict UTF-8 decode test; a failure means the file is binary metadata only. */
function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Guard one storage directory segment (session id / task run id). */
function assertSegment(value: string, label: string): void {
  if (value === '.' || value === '..' || !SEGMENT_PATTERN.test(value)) throw new Error(`invalid ${label}: ${value}`);
}

/** Simple lexical containment: `child` is `root` or a path below it. */
export function isInside(child: string, root: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A sanitized file name, gaining the detected image extension when nameless. */
function safeName(name: string, bytes: Uint8Array): string {
  // Keep the original basename incl. CJK/Unicode; strip separators/control/reserved leading dots.
  let base = basename(name).replace(/[/\\\u0000-\u001f\u007f]+/gu, '').replace(/^\.+/u, '');
  if (base === '') base = 'file';
  const image = detectImageFormat(bytes);
  if (extname(base) === '' && image !== undefined) base = `${base}.${image.ext}`;
  return base;
}

/** Highest existing sequence in a session directory, plus one. */
function scanNextSequence(directory: string): number {
  if (!existsSync(directory)) return 1;
  let max = 0;
  for (const entry of readdirSync(directory)) {
    const match = /^(\d+)-/u.exec(entry);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** Pixel-art cue: an explicit role/description/name signal, or a small image. */
function isPixelArt(
  role: string | undefined,
  description: string | undefined,
  name: string,
  width: number,
  height: number,
): boolean {
  const cue = `${role ?? ''} ${description ?? ''} ${name}`.toLowerCase();
  if (/pixel|sprite|icons?|像素/u.test(cue)) return true;
  return Math.max(width, height) <= 256;
}

/** Strict UTF-8 text (binary files carry metadata only), capped per file. */
function prepareText(bytes: Buffer): Partial<SessionFile> {
  if (!isUtf8Text(bytes)) return {};
  const content = bytes.toString('utf8');
  const tokens = TEXT_ENCODING.encode(content);
  const totalTokens = tokens.length;
  if (totalTokens <= TEXT_TOKEN_CAP) {
    return { text: content, tokens: totalTokens, totalTokens, truncated: false };
  }
  const prefix = TEXT_ENCODING.decode(tokens.slice(0, TEXT_TOKEN_CAP)).replace(/\uFFFD+$/u, '');
  return { text: prefix, tokens: TEXT_TOKEN_CAP, totalTokens, truncated: true };
}

interface DecodedAttachment {
  bytes: Buffer;
  name: string;
}

/** Read one attachment source; exactly one of `path` / `dataUrl` is required. */
async function readAttachment(attachment: AttachmentInput, index: number): Promise<DecodedAttachment> {
  const hasPath = typeof attachment.path === 'string' && attachment.path !== '';
  const hasData = typeof attachment.dataUrl === 'string' && attachment.dataUrl !== '';
  if (hasPath === hasData) throw new Error('attachment requires exactly one of path or dataUrl');
  if (hasData) {
    const match = DATA_URL_PATTERN.exec(attachment.dataUrl!);
    if (!match) throw new Error('attachment dataUrl is not a strict base64 data URL');
    return { bytes: Buffer.from(match[2]!, 'base64'), name: attachment.name ?? `attachment-${index + 1}` };
  }
  const path = attachment.path!;
  if (!isAbsolute(path)) throw new Error(`attachment path must be absolute: ${path}`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`attachment is not a regular file: ${path}`);
  if (info.size > MEDIA_LIMITS.maxFileBytes) {
    throw new Error(`attachment exceeds ${MEDIA_LIMITS.maxFileBytes} bytes: ${path}`);
  }
  return { bytes: await readFile(path), name: attachment.name ?? basename(path) };
}

/**
 * Owns the session file directory and the artifact descriptions derived in
 * place. It never reads the ledger and never calls a model.
 */
export class FileStore {
  private readonly stateRoot: string;
  /** Next free sequence per session, reserved synchronously before any await. */
  private readonly nextSequence = new Map<string, number>();

  constructor(options: { stateRoot: string }) {
    this.stateRoot = resolve(options.stateRoot);
  }

  private sessionFilesDir(sessionId: string): string {
    return join(this.stateRoot, 'sessions', sessionId, 'files');
  }

  private artifactsDir(taskRunId: string): string {
    return join(this.stateRoot, 'artifacts', taskRunId);
  }

  /** The run whose artifact directory holds `path`, among `runIds`. */
  runOf(path: string, runIds: Iterable<string>): string | undefined {
    const absolute = resolve(path);
    for (const runId of runIds) {
      const root = this.artifactsDir(runId);
      if (absolute === root || isInside(absolute, root)) return runId;
    }
    return undefined;
  }

  /** Regular files a run left in its artifact directory, previews excluded. */
  async listRunFiles(taskRunId: string): Promise<{ path: string; bytes: number }[]> {
    const root = this.artifactsDir(taskRunId);
    if (!existsSync(root)) return [];
    const files: { path: string; bytes: number }[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const path = join(root, entry.name);
      files.push({ path, bytes: (await stat(path)).size });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Reserve sequence numbers synchronously so concurrent admissions cannot collide. */
  private reserve(sessionId: string, count: number): number[] {
    let next = this.nextSequence.get(sessionId);
    if (next === undefined) {
      next = scanNextSequence(this.sessionFilesDir(sessionId));
      this.nextSequence.set(sessionId, next);
    }
    const reserved: number[] = [];
    for (let index = 0; index < count; index += 1) reserved.push(next + index);
    this.nextSequence.set(sessionId, next + count);
    return reserved;
  }

  /** Validate a whole batch, copy the originals into the session and prepare them. */
  async importAttachments(sessionId: string, attachments: readonly AttachmentInput[]): Promise<SessionFile[]> {
    assertSegment(sessionId, 'session id');
    if (attachments.length > MEDIA_LIMITS.maxBatchItems) {
      throw new Error(`too many attachments: ${attachments.length} exceeds ${MEDIA_LIMITS.maxBatchItems}`);
    }
    const decoded: DecodedAttachment[] = [];
    let totalBytes = 0;
    for (let index = 0; index < attachments.length; index += 1) {
      const source = await readAttachment(attachments[index]!, index);
      totalBytes += source.bytes.length;
      if (totalBytes > MEDIA_LIMITS.maxBatchBytes) {
        throw new Error(`attachment batch exceeds ${MEDIA_LIMITS.maxBatchBytes} bytes`);
      }
      decoded.push(source);
    }
    const sequences = this.reserve(sessionId, decoded.length);
    const directory = this.sessionFilesDir(sessionId);
    await mkdir(directory, { recursive: true });
    const files: SessionFile[] = [];
    for (let index = 0; index < decoded.length; index += 1) {
      const { bytes, name } = decoded[index]!;
      const stored = join(directory, `${String(sequences[index]).padStart(2, '0')}-${safeName(name, bytes)}`);
      await writeFile(stored, bytes);
      files.push(await this.prepareFile(stored, { source: 'user' }));
    }
    return files;
  }

  /** Describe a file in place: hash, image metadata/preview and text prefix. */
  async prepareFile(
    path: string,
    options: { source: 'user' | 'task'; taskRunId?: string; actionId?: string; role?: string; description?: string },
  ): Promise<SessionFile> {
    const absolute = resolve(path);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`not a regular file: ${absolute}`);
    if (info.size > MEDIA_LIMITS.maxFileBytes) {
      throw new Error(`file exceeds ${MEDIA_LIMITS.maxFileBytes} bytes: ${absolute}`);
    }
    const bytes = await readFile(absolute);
    const image = detectImageFormat(bytes);
    const name = basename(absolute);
    const file: SessionFile = {
      path: absolute,
      name,
      kind: image ? 'image' : 'file',
      mime: image ? image.mime : isUtf8Text(bytes) ? 'text/plain' : 'application/octet-stream',
      bytes: bytes.length,
      hash: sha256(bytes),
      source: options.source,
      description: options.description ?? options.role ?? '',
      ...(options.taskRunId === undefined ? {} : { taskRunId: options.taskRunId }),
      ...(options.actionId === undefined ? {} : { actionId: options.actionId }),
      ...(options.role === undefined ? {} : { role: options.role }),
    };
    if (!image) return { ...file, ...prepareText(bytes) };
    try {
      return { ...file, ...(await this.prepareImage(absolute, bytes, options, name)) };
    } catch {
      return file;
    }
  }

  /** Resize/re-encode one image and persist its preview bytes once. */
  private async prepareImage(
    absolute: string,
    bytes: Buffer,
    options: { role?: string; description?: string },
    name: string,
  ): Promise<Partial<SessionFile>> {
    const metadata = await sharp(bytes, { animated: false }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) return {};
    const result: Partial<SessionFile> = { width, height };
    const pixelArt = isPixelArt(options.role, options.description, name, width, height);
    const longEdge = Math.max(width, height);
    const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const encode = async (forceJpeg: boolean, quality: number): Promise<{ data: Buffer; mime: string }> => {
      let pipeline = sharp(bytes, { animated: false });
      if (scale !== 1) {
        pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'fill', kernel: pixelArt ? 'nearest' : 'lanczos3' });
      }
      if (!forceJpeg && (pixelArt || metadata.hasAlpha === true)) {
        return { data: await pipeline.png().toBuffer(), mime: 'image/png' };
      }
      return { data: await pipeline.jpeg({ quality }).toBuffer(), mime: 'image/jpeg' };
    };
    let encoded = await encode(false, 80);
    if (encoded.data.length > MAX_PREVIEW_BYTES) encoded = await encode(true, 60);
    // Oversized even after the retry: no preview is persisted for this image.
    if (encoded.data.length > MAX_PREVIEW_BYTES) return result;
    const ext = encoded.mime === 'image/png' ? 'png' : 'jpg';
    const processedHash = sha256(encoded.data);
    const previewPath = join(dirname(absolute), `.wy-preview-${processedHash}.${ext}`);
    if (!existsSync(previewPath)) {
      try {
        await writeFile(previewPath, encoded.data, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return {
      ...result,
      processedPath: previewPath,
      processedMime: encoded.mime,
      processedWidth: targetWidth,
      processedHeight: targetHeight,
      processedBytes: encoded.data.length,
    };
  }

  /** Describe Task artifacts in place inside their run directory. */
  async describeArtifacts(args: {
    sessionId: string;
    taskRunId: string;
    actionId: string;
    artifacts: readonly TaskArtifact[];
  }): Promise<{ files: SessionFile[]; errors: string[] }> {
    assertSegment(args.sessionId, 'session id');
    assertSegment(args.taskRunId, 'task run id');
    const runRoot = resolve(this.artifactsDir(args.taskRunId));
    const files: SessionFile[] = [];
    const errors: string[] = [];
    for (const artifact of args.artifacts) {
      try {
        if (!isAbsolute(artifact.path)) throw new Error('artifact path must be absolute');
        const absolute = resolve(artifact.path);
        if (!isInside(absolute, runRoot)) throw new Error('artifact is outside its task run directory');
        files.push(await this.prepareFile(absolute, {
          source: 'task',
          taskRunId: args.taskRunId,
          actionId: args.actionId,
          ...(artifact.role === undefined ? {} : { role: artifact.role }),
          ...(artifact.description === undefined ? {} : { description: artifact.description }),
        }));
      } catch (error) {
        errors.push(`${artifact.path}: ${messageOf(error)}`);
      }
    }
    return { files, errors };
  }

  /** Read the already-persisted preview bytes for one prepared image. */
  async readImage(file: SessionFile): Promise<{ dataUrl: string; mime: string }> {
    if (file.processedPath === undefined || file.processedMime === undefined) {
      throw new Error(`file has no prepared image preview: ${file.path}`);
    }
    const bytes = await readFile(file.processedPath);
    return { dataUrl: `data:${file.processedMime};base64,${bytes.toString('base64')}`, mime: file.processedMime };
  }
}
