/** Workspace document commits, serialized by the owning ledger's process-local queue. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { contentVersion, currentDocument, makeDocumentDraft } from './documents.ts';
import type { LedgerEvent, LedgerEventDraft } from './ledger/events.ts';

export interface DocumentCommitContext {
  sessionId: string;
  turn: number;
  step: number;
  parent: string;
}

export interface DocumentCommit {
  path: string;
  title: string;
  /** Exact content read by the service; null means the file must not exist. */
  before: string | null;
  /** Null deletes the document. */
  content: string | null;
  context?: DocumentCommitContext;
}

function conflict(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** File data is flushed before rename; POSIX directory entries are flushed too. */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function replaceFile(file: string, content: string, id: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = resolve(dirname(file), '.' + basename(file) + '.' + id + '.tmp');
  const fd = openSync(temp, 'w', existsSync(file) ? lstatSync(file).mode : 0o600);
  try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
}

/** Coarse parent-facing error category; never embeds raw paths or stack text. */
function errorCategory(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/u.test(code) ? code : 'io_error';
}

/**
 * The document file is the sole content authority: the mutation completes at
 * the atomic replacement (or the unlink for a delete). Session history is then
 * recorded once; a crash between the two may leave the last operation out of
 * history, which an explicit reread of the file resolves. A pre-existing
 * document-commit.json from an older format is preserved verbatim and never
 * replayed or removed.
 */
export class DocumentCommitter {
  private readonly journal: string;
  private readonly workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    directory: string,
    private readonly read: (sessionId: string) => LedgerEvent[],
    private readonly append: (sessionId: string, draft: LedgerEventDraft) => Promise<LedgerEvent>,
    private readonly sync: (sessionId: string) => Promise<void>,
  ) {
    this.workspaceRoot = realpathSync(workspaceRoot);
    this.journal = resolve(directory, 'document-commit.json');
  }

  /**
   * Presence-only legacy check: a pending document-commit.json left by the
   * durable-transaction format is preserved untouched and never blocks use.
   * Callers must treat the current file on disk as authoritative and reread it.
   */
  hasLegacyPending(): boolean {
    return existsSync(this.journal);
  }

  /** Serialized by the caller's queue; re-validates `before` immediately before replacing. */
  async commit(input: DocumentCommit): Promise<void> {
    if (input.context !== undefined && (!input.context.sessionId || !input.context.parent
      || !Number.isSafeInteger(input.context.turn) || input.context.turn < 1
      || !Number.isSafeInteger(input.context.step) || input.context.step < 1)) {
      throw new Error('Invalid document commit provenance');
    }
    const file = this.target(input.path);
    // The caller holds the process-local queue, so this read and the
    // replacement below are serialized against every cooperating writer. A
    // mutation computed from a stale snapshot is rejected, never overwritten.
    if (this.content(file) !== input.before) throw conflict('conflict', 'Document changed before commit; read it again');
    let events: LedgerEvent[] = [];
    if (input.context !== undefined) {
      events = this.read(input.context.sessionId);
      if (!events.some(event => event.type === 'session.created')) throw conflict('missing_session', 'Document commit requires an existing session');
      currentDocument(events, input.path);
    }
    // The atomic replacement is the completion point of the mutation.
    if (input.content === null) unlinkSync(file);
    else replaceFile(file, input.content, randomUUID());
    // Post-mutation durability confirmation: the document is already changed,
    // so a directory fsync failure must surface as a distinct partial outcome,
    // never as a raw fs error indistinguishable from "nothing was written".
    try {
      syncDirectory(dirname(file));
    } catch (error) {
      throw conflict('durability_failed',
        'Document was already changed but durability confirmation failed; read it again instead of retrying the write: ' + errorCategory(error));
    }
    // Session history follows the file change. When it cannot be recorded the
    // document is already changed, so the error must say so: callers may fix
    // history or reread, but must never blind-retry the mutation.
    if (input.context === undefined) return;
    try {
      const context = input.context;
      if (input.content !== null) {
        const draft = makeDocumentDraft({ path: input.path, title: input.title, content: input.content }, events,
          { turn: context.turn, step: context.step, parent: context.parent, source: 'write' });
        if (draft !== undefined) await this.append(context.sessionId, draft);
      }
      await this.append(context.sessionId, {
        type: 'workspace.changed', turn: context.turn, step: context.step, parent: context.parent,
        scope: 'document', target: input.path,
        change: input.content === null ? 'deleted' : input.before === null ? 'created' : 'updated',
        version: contentVersion(input.content ?? input.before ?? ''),
      });
      await this.sync(context.sessionId);
    } catch (error) {
      throw conflict('history_failed', 'Document was already changed but its session history could not be recorded; read it again instead of retrying the write: ' + errorCategory(error));
    }
  }

  /** A delayed read must not replace the current view with an obsolete snapshot. */
  validateSnapshot(path: string, version: string): void {
    const content = this.content(this.target(path, false));
    if (content === null || contentVersion(content) !== version) {
      throw conflict('conflict', 'Document changed before its read was recorded; read it again');
    }
  }

  private content(file: string): string | null {
    if (!existsSync(file)) return null;
    if (!lstatSync(file).isFile()) throw conflict('not_a_file', 'Document target is not a regular file');
    return readFileSync(file, 'utf8');
  }

  private target(key: string, mutation = true): string {
    if (key.includes('\0') || key.includes('\\') || key.includes(':') || key.split('/').some(part => part === '.' || part === '..' || part === '')
      || !key.endsWith('.md') || (mutation && !/^projects\/(?:[^/]+\/)+(?:AGENTS\.md|docs\/(?:specs|reports|handoff)\/[^/]+\.md)$/u.test(key))) {
      throw new Error('Invalid document commit target');
    }
    const file = resolve(this.workspaceRoot, key);
    let ancestor = file;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const canonical = resolve(realpathSync(ancestor), relative(ancestor, file));
    const rel = relative(this.workspaceRoot, canonical);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || canonical !== file) {
      throw new Error('Document commit target escapes its canonical location');
    }
    return file;
  }
}
