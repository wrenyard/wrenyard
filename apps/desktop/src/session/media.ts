/**
 * Safe media helpers for the session bridge (main process only).
 *
 * Sender validation stays in `ipc.ts`; this module owns the mechanical parts
 * of the attachment flow: bounded filesystem metadata, native thumbnails,
 * clipboard staging under the Desktop user-data directory and the cleanup of
 * exactly those staged files. No file bytes ever reach the renderer as data,
 * and nothing here touches the daemon ledger.
 */
import { app, nativeImage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { DraftAttachment } from './preload.js';

/** Upper bound on how many filesystem paths one describe request may carry. */
export const MAX_DESCRIBE_FILES = 128;
/** A file larger than this is still described, but never thumbnailed. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** A clipboard image larger than this is rejected outright. */
export const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;
/** Longest edge of a generated thumbnail, in pixels. */
export const THUMBNAIL_MAX_PX = 192;
/** A data URL preview longer than this is dropped rather than relayed. */
const MAX_PREVIEW_CHARS = 256 * 1024;
/** Data URL string ceiling before decoding, so a hostile paste cannot exhaust memory. */
const MAX_DATA_URL_CHARS = Math.ceil((MAX_CLIPBOARD_BYTES * 4) / 3) + 1024;
/** Subdirectory of `userData` holding clipboard images staged for a send. */
const STAGED_DIR = 'session-drafts';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Stable, filesystem-safe identifier derived from content or a canonical path. */
export function stableId(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 24);
}

/** Staging directory; created lazily by {@link stageClipboardImage}. */
export function stagedDirectory(): string {
  return join(app.getPath('userData'), STAGED_DIR);
}

/** Strips any directory components and control characters from a display name. */
function safeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f/\\]+/g, ' ').trim();
  if (cleaned === '') return fallback;
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

/** Bounded data URL preview of a decoded image, or `undefined` when unusable. */
function previewOf(image: Electron.NativeImage): string | undefined {
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest <= 0) return undefined;
  const scale = Math.min(1, THUMBNAIL_MAX_PX / longest);
  const scaled = scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good',
      })
    : image;
  const url = scaled.toDataURL();
  return url.length <= MAX_PREVIEW_CHARS ? url : undefined;
}

/** Describes one filesystem file; non-files and unreadable paths yield `undefined`. */
export async function describeFile(path: string): Promise<DraftAttachment | undefined> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  const mime = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
  let preview: string | undefined;
  if (mime !== undefined && info.size <= MAX_FILE_BYTES) {
    preview = previewOf(nativeImage.createFromPath(path));
  }
  return {
    id: stableId(path),
    path,
    name: basename(path),
    bytes: info.size,
    ...(mime === undefined ? {} : { mime }),
    ...(preview === undefined ? {} : { preview }),
  };
}

/** Describes a bounded, de-duplicated set of picked or dropped file paths. */
export async function describeFiles(paths: readonly string[]): Promise<DraftAttachment[]> {
  const bounded = [...new Set(paths.filter((path) => path !== ''))].slice(0, MAX_DESCRIBE_FILES);
  const described = await Promise.all(bounded.map(describeFile));
  return described.filter((file): file is DraftAttachment => file !== undefined);
}

/**
 * Persists a pasted clipboard image under the staging directory and returns a
 * draft attachment pointing at it (flagged `staged`). Each paste gets its own
 * content-hash + UUID filename and id, so a distinct draft can never delete
 * another draft's file.
 */
export async function stageClipboardImage(input: { dataUrl: string; name?: string }): Promise<DraftAttachment> {
  if (input.dataUrl.length > MAX_DATA_URL_CHARS) throw new Error('图片过大，无法添加');
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(input.dataUrl);
  if (!match) throw new Error('剪贴板图片格式不支持');
  const mime = match[1]!.toLowerCase();
  // Only the four formats the reason pipeline accepts; anything else is refused
  // rather than stored with a guessed extension.
  const extension = IMAGE_EXTENSION_BY_MIME[mime];
  if (extension === undefined) throw new Error('剪贴板图片格式不支持');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.byteLength === 0) throw new Error('剪贴板图片为空');
  if (bytes.byteLength > MAX_CLIPBOARD_BYTES) throw new Error('图片过大，无法添加');
  const contentHash = stableId(bytes);
  const unique = randomUUID();
  const directory = stagedDirectory();
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${contentHash}-${unique}${extension}`);
  await writeFile(target, bytes);
  const preview = previewOf(nativeImage.createFromBuffer(bytes));
  return {
    id: `${contentHash}-${unique}`,
    path: target,
    name: safeName(input.name, `粘贴图片${extension}`),
    bytes: bytes.byteLength,
    mime,
    staged: true,
    ...(preview === undefined ? {} : { preview }),
  };
}

/**
 * Deletes only the given paths that are direct children of the staging
 * directory, so a source file the user picked can never be removed even if a
 * malformed attachment claims to be staged.
 */
export async function discardStagedFiles(paths: readonly string[]): Promise<void> {
  const directory = stagedDirectory();
  await Promise.all(paths.map(async (candidate) => {
    if (dirname(resolve(candidate)) !== directory) return;
    // Already removed or no longer accessible: nothing to clean up.
    await unlink(candidate).catch(() => undefined);
  }));
}
