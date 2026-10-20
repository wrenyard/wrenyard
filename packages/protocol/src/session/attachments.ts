/** A user attachment crossing IPC. Exactly one of `path` / `dataUrl` is set. */
export interface AttachmentInput {
  path?: string
  name?: string
  dataUrl?: string
}

/** Metadata for one session file; never carries file bytes. */
export interface SessionFile {
  /** Canonical absolute public path of the original file. */
  path: string
  name: string
  kind: 'image' | 'file'
  mime: string
  bytes: number
  hash: string
  source: 'user' | 'task'
  description: string
  width?: number
  height?: number
  taskRunId?: string
  actionId?: string
  role?: string
  text?: string
  tokens?: number
  totalTokens?: number
  truncated?: boolean
  processedPath?: string
  processedMime?: string
  processedWidth?: number
  processedHeight?: number
  processedBytes?: number
}

// ─── Attachment reference links ─────────────────────────────────────────────

/**
 * The reserved host of every attachment reference URL. It is a fixed
 * `.invalid` name (RFC 2606), so it can never resolve; the desktop renderer
 * recognizes it and never opens it externally.
 */
export const ATTACHMENT_REF_HOST = 'wrenyard.invalid';

/** The fixed path prefix under {@link ATTACHMENT_REF_HOST}. */
const ATTACHMENT_REF_PREFIX = '/attachments/';

/**
 * The exact, fully anchored shape of one attachment reference URL. Only this
 * shape is a reference: no filesystem-path heuristic on the query value is
 * ever applied.
 */
const ATTACHMENT_REF_PATTERN = /^https:\/\/wrenyard\.invalid\/attachments\/([^/?#]+)\?path=([^#]*)$/u;

/** The scheme-and-authority head of a URL, for the reserved-host judgement. */
const URL_AUTHORITY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u;

/**
 * One attachment reference identity. Both fields participate: the same
 * canonical path with a different hash, or the same hash with a different
 * path, is a different reference.
 */
export interface AttachmentRef {
  /** Canonical absolute public path of the session file. */
  path: string;
  /** The session file's content hash. */
  hash: string;
}

/**
 * The RFC 3986 sub-delimiters that `encodeURIComponent` leaves literal but a
 * Markdown link destination cannot carry: an unbalanced `)` in a filename
 * would otherwise close the `[label](url)` link early.
 */
const ATTACHMENT_REF_SUB_DELIMITERS = /[!'()*]/gu

/**
 * Encode one attachment reference component (hash or path) so the resulting URL
 * survives Markdown link parsing byte-for-byte. {@link parseAttachmentRefUrl}
 * decodes it back to the exact original value.
 */
function encodeAttachmentRefComponent(value: string): string {
  return encodeURIComponent(value).replace(
    ATTACHMENT_REF_SUB_DELIMITERS,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

/**
 * Build the stable, model-opaque HTTPS reference URL of one session file:
 * `https://wrenyard.invalid/attachments/<hash>?path=<canonicalPath>`. The
 * canonical path is URI-encoded verbatim, so Windows separators, Unicode and
 * spaces survive unchanged, and RFC 3986 sub-delimiters are escaped so the URL
 * stays a valid Markdown link destination. The same path and hash always
 * reproduce the same URL, and only {@link SessionFile} metadata is read.
 */
export function attachmentRefUrl(file: Pick<SessionFile, 'path' | 'hash'>): string {
  const hash = encodeAttachmentRefComponent(file.hash)
  const path = encodeAttachmentRefComponent(file.path)
  return `https://${ATTACHMENT_REF_HOST}${ATTACHMENT_REF_PREFIX}${hash}?path=${path}`
}

/**
 * Parse one attachment reference URL by exact match. Returns the identity, or
 * `undefined` for anything that is not exactly this contract's shape. A
 * malformed escape or an empty path / hash is not a reference.
 */
export function parseAttachmentRefUrl(url: string): AttachmentRef | undefined {
  const match = ATTACHMENT_REF_PATTERN.exec(url);
  if (match === null) return undefined;
  try {
    const hash = decodeURIComponent(match[1]!);
    const path = decodeURIComponent(match[2]!);
    return hash === '' || path === '' ? undefined : { path, hash };
  } catch {
    return undefined;
  }
}

/**
 * True when a URL addresses the reserved attachment host, whatever the rest of
 * its shape. The renderer uses this to degrade an unknown or malformed
 * reference instead of opening it externally.
 */
export function isAttachmentRefHost(url: string): boolean {
  const match = URL_AUTHORITY_PATTERN.exec(url);
  if (match === null) return false;
  const authority = match[1]!;
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/u, '');
  return host.toLowerCase() === ATTACHMENT_REF_HOST;
}
