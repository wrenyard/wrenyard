/**
 * Per-session composer drafts.
 *
 * Drafts live in memory first and mirror to `localStorage` under
 * `session:draft:<id>` after a short debounce. When `localStorage` is
 * unavailable the in-memory copy is authoritative, so typing never throws.
 * Text is only removed by a successful send or an explicit {@link clearDraft}.
 */

const STORAGE_PREFIX = 'session:draft:';
const DEBOUNCE_MS = 300;

const drafts = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

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
