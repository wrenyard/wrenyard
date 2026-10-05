/**
 * Per-session composer drafts.
 *
 * Drafts live in memory first and mirror to `localStorage` under
 * `session:draft:<id>` (text) and `session:attachments:<id>` (attachments)
 * after a short debounce. When `localStorage` is unavailable the in-memory copy
 * is authoritative, so typing never throws. Text and attachments are removed
 * only by a successful send or an explicit clear.
 */
import type { DraftAttachment } from '../model/types.js';

const STORAGE_PREFIX = 'session:draft:';
const ATTACHMENTS_PREFIX = 'session:attachments:';
const DEBOUNCE_MS = 300;
/** Upper bound on persisted attachments per session. */
const MAX_ATTACHMENTS = 32;
/** A persisted thumbnail larger than this is dropped rather than stored. */
const MAX_PREVIEW_CHARS = 256 * 1024;
/** Upper bound on a persisted attachment list, in characters. */
const MAX_STORED_CHARS = 2_000_000;

const drafts = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const attachmentDrafts = new Map<string, DraftAttachment[]>();
const attachmentTimers = new Map<string, ReturnType<typeof setTimeout>>();

const storageKey = (id: string): string => `${STORAGE_PREFIX}${id}`;

function readStored(id: string): { ok: boolean; text: string } {
  try {
    return { ok: true, text: window.localStorage.getItem(storageKey(id)) ?? '' };
  } catch {
    return { ok: false, text: '' };
  }
}

function writeStored(id: string, text: string): void {
  try {
    if (text === '') window.localStorage.removeItem(storageKey(id));
    else window.localStorage.setItem(storageKey(id), text);
  } catch {
    // Storage is best-effort; the in-memory draft stays authoritative.
  }
}

function cancelTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

/** Reads the draft for `id`, falling back to memory when storage fails. */
export function readDraft(id: string): string {
  const cached = drafts.get(id);
  if (cached !== undefined) return cached;
  const stored = readStored(id);
  if (stored.ok) drafts.set(id, stored.text);
  return stored.text;
}

/** Records a draft edit and schedules the debounced storage write. */
export function writeDraft(id: string, text: string): void {
  drafts.set(id, text);
  cancelTimer(id);
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    writeStored(id, drafts.get(id) ?? '');
  }, DEBOUNCE_MS));
}

/** Writes any pending draft edit for `id` immediately. */
export function flushDraft(id: string): void {
  cancelTimer(id);
  const text = drafts.get(id);
  if (text !== undefined) writeStored(id, text);
}

/** Removes the draft for `id` from memory and storage. */
export function clearDraft(id: string): void {
  drafts.delete(id);
  cancelTimer(id);
  writeStored(id, '');
}

// ─── Attachment drafts ─────────────────────────────────────────────────────

const attachmentStorageKey = (id: string): string => `${ATTACHMENTS_PREFIX}${id}`;

/** Keeps only the JSON-safe, bounded fields of one draft attachment. */
function sanitizeAttachment(value: unknown): DraftAttachment | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const name = typeof record.name === 'string' ? record.name : undefined;
  const path = typeof record.path === 'string' ? record.path : undefined;
  if (id === undefined || name === undefined || path === undefined) return undefined;
  const bytes = typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0;
  const mime = typeof record.mime === 'string' ? record.mime : undefined;
  const preview = typeof record.preview === 'string' && record.preview.length <= MAX_PREVIEW_CHARS
    ? record.preview
    : undefined;
  const staged = record.staged === true ? true : undefined;
  return {
    id,
    name,
    path,
    bytes,
    ...(mime === undefined ? {} : { mime }),
    ...(preview === undefined ? {} : { preview }),
    ...(staged === undefined ? {} : { staged }),
  };
}

function sanitizeAttachments(value: unknown): DraftAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(sanitizeAttachment)
    .filter((attachment): attachment is DraftAttachment => attachment !== undefined)
    .slice(0, MAX_ATTACHMENTS);
}

function readStoredAttachments(id: string): { ok: boolean; value: DraftAttachment[] } {
  try {
    const raw = window.localStorage.getItem(attachmentStorageKey(id));
    if (raw === null) return { ok: true, value: [] };
    return { ok: true, value: sanitizeAttachments(JSON.parse(raw)) };
  } catch {
    return { ok: false, value: [] };
  }
}

function writeStoredAttachments(id: string, attachments: readonly DraftAttachment[]): void {
  try {
    if (attachments.length === 0) {
      window.localStorage.removeItem(attachmentStorageKey(id));
      return;
    }
    const json = JSON.stringify(attachments);
    if (json.length > MAX_STORED_CHARS) return;
    window.localStorage.setItem(attachmentStorageKey(id), json);
  } catch {
    // Storage is best-effort; the in-memory copy stays authoritative.
  }
}

function cancelAttachmentTimer(id: string): void {
  const timer = attachmentTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    attachmentTimers.delete(id);
  }
}

/** Reads the attachment draft for `id`, falling back to memory on storage failure. */
export function readDraftAttachments(id: string): DraftAttachment[] {
  const cached = attachmentDrafts.get(id);
  if (cached !== undefined) return cached;
  const stored = readStoredAttachments(id);
  if (stored.ok) attachmentDrafts.set(id, stored.value);
  return stored.value;
}

/** Records an attachment-list edit and schedules the debounced storage write. */
export function writeDraftAttachments(id: string, attachments: readonly DraftAttachment[]): void {
  const bounded = attachments.slice(0, MAX_ATTACHMENTS);
  attachmentDrafts.set(id, bounded);
  cancelAttachmentTimer(id);
  attachmentTimers.set(id, setTimeout(() => {
    attachmentTimers.delete(id);
    writeStoredAttachments(id, attachmentDrafts.get(id) ?? []);
  }, DEBOUNCE_MS));
}

/** Writes any pending attachment edit for `id` immediately. */
export function flushDraftAttachments(id: string): void {
  cancelAttachmentTimer(id);
  const attachments = attachmentDrafts.get(id);
  if (attachments !== undefined) writeStoredAttachments(id, attachments);
}

/** Removes the attachment draft for `id` from memory and storage. */
export function clearDraftAttachments(id: string): void {
  attachmentDrafts.delete(id);
  cancelAttachmentTimer(id);
  writeStoredAttachments(id, []);
}

// ─── In-flight reconciliation ──────────────────────────────────────────────

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Live selection and submitted snapshot of one completed send. */
export interface SentDraftSnapshot {
  /** Session the send originated from. */
  originKey: string;
  /** Session currently active in the composer. */
  activeKey: string;
  /** Submitted text exactly as sent. */
  bodyText: string;
  /** Current composer text. */
  activeText: string;
  /** Attachment ids submitted, in order. */
  submittedIds: readonly string[];
  /** Attachment ids currently in the composer, in order. */
  activeIds: readonly string[];
  /** Attachment ids currently stored in the origin draft, in order. */
  originIds: readonly string[];
}

/** What a successful send may clear; every field is independent. */
export interface SentDraftReconciliation {
  clearText: boolean;
  clearAttachments: boolean;
  clearOriginAttachments: boolean;
}

/**
 * Pure reconciliation of a successful in-flight send against the live composer
 * selection. Text and attachments are cleared independently, each only while it
 * still equals the submitted snapshot, so a newer edit is preserved. When the
 * composer switched sessions, the destination is left untouched and the origin's
 * persisted attachment draft is cleared instead — only when it still matches.
 */
export function reconcileSentDraft(snapshot: SentDraftSnapshot): SentDraftReconciliation {
  if (snapshot.activeKey !== snapshot.originKey) {
    return {
      clearText: false,
      clearAttachments: false,
      clearOriginAttachments: sameIds(snapshot.originIds, snapshot.submittedIds),
    };
  }
  return {
    clearText: snapshot.activeText === snapshot.bodyText,
    clearAttachments: sameIds(snapshot.activeIds, snapshot.submittedIds),
    clearOriginAttachments: false,
  };
}

/**
 * True when any known session attachment draft still references `path`. Only
 * the in-memory drafts and the persisted `session:attachments:*` keys are
 * scanned; nothing else in storage is touched.
 */
export function isStagedPathRetained(path: string): boolean {
  if (path === '') return false;
  for (const attachments of attachmentDrafts.values()) {
    if (attachments.some((item) => item.path === path)) return true;
  }
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(ATTACHMENTS_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      if (sanitizeAttachments(JSON.parse(raw)).some((item) => item.path === path)) return true;
    }
  } catch {
    // Storage is best-effort; the in-memory map above stays authoritative.
  }
  return false;
}
