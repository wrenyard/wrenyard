/** Durable workspace document commits, serialized by the owning ledger. */
import { createHash, randomUUID } from 'node:crypto';
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

interface Transaction extends DocumentCommit { id: string }

function checksum(transaction: Transaction): string {
  return createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
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

function syncFile(file: string): void {
  const fd = openSync(file, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function replaceFile(file: string, content: string, id: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = resolve(dirname(file), '.' + basename(file) + '.' + id + '.tmp');
  const fd = openSync(temp, 'w', existsSync(file) ? lstatSync(file).mode : 0o600);
  try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  syncDirectory(dirname(file));
}

/** One write-ahead intent per workspace; callers must hold the ledger queue. */
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

  async commit(input: DocumentCommit): Promise<void> {
    await this.recover();
    if (input.context !== undefined && (!input.context.sessionId || !input.context.parent
      || !Number.isSafeInteger(input.context.turn) || input.context.turn < 1
      || !Number.isSafeInteger(input.context.step) || input.context.step < 1)) {
      throw new Error('Invalid document commit provenance');
    }
    const transaction: Transaction = { ...input, id: randomUUID() };
    const file = this.target(transaction.path);
    if (this.content(file) !== input.before) throw conflict('conflict', 'Document changed before commit; read it again');
    if (input.context !== undefined) {
      const events = this.read(input.context.sessionId);
      if (!events.some(event => event.type === 'session.created')) throw conflict('missing_session', 'Document commit requires an existing session');
      currentDocument(events, input.path);
    }
    // Publishing this durable intent is the commit decision. Recovery completes
    // it before any later mutation; a tool success is returned only after cleanup.
    let published = false;
    try {
      replaceFile(this.journal, JSON.stringify({ transaction, checksum: checksum(transaction) }), transaction.id);
      published = true;
      await this.recover();
    } catch (error) {
      if (published || existsSync(this.journal)) {
        throw conflict('commit_pending', 'Document commit ' + transaction.id
          + ' may already have taken effect; recover and read before retrying: ' + String(error));
      }
      throw error;
    }
  }

  async recover(): Promise<void> {
    if (!existsSync(this.journal)) return;
    const journal = JSON.parse(readFileSync(this.journal, 'utf8')) as { transaction: Transaction; checksum: string };
    const transaction = journal.transaction;
    if (transaction === null || typeof transaction !== 'object' || checksum(transaction) !== journal.checksum) {
      throw new Error('Document commit journal checksum mismatch; refusing recovery');
    }
    if (typeof transaction.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(transaction.id)
      || typeof transaction.path !== 'string' || typeof transaction.title !== 'string'
      || (transaction.before !== null && typeof transaction.before !== 'string')
      || (transaction.content !== null && typeof transaction.content !== 'string')) {
      throw new Error('Invalid document commit journal; recovery requires intervention');
    }
    const { context } = transaction;
    if (context !== undefined && (typeof context.sessionId !== 'string' || typeof context.parent !== 'string'
      || !Number.isSafeInteger(context.turn) || context.turn < 1 || !Number.isSafeInteger(context.step) || context.step < 1)) {
      throw new Error('Invalid document commit provenance');
    }
    const events = context === undefined ? [] : this.read(context.sessionId);
    const committed = events.some(event => event.type === 'workspace.changed' && event.transactionId === transaction.id);
    if (!committed) {
      if (context !== undefined && !events.some(event => event.type === 'session.created')) {
        throw conflict('missing_session', 'Pending document commit refers to a missing session');
      }
      const file = this.target(transaction.path);
      const current = this.content(file);
      // Never overwrite an unrelated edit discovered after a crash.
      if (current !== transaction.before && current !== transaction.content) {
        throw conflict('recovery_conflict', 'Pending document commit conflicts with an external edit; preserve the journal for recovery');
      }
      if (context !== undefined) currentDocument(events, transaction.path);
      if (current !== transaction.content) {
        if (transaction.content === null) { unlinkSync(file); syncDirectory(dirname(file)); }
        else replaceFile(file, transaction.content, transaction.id);
      }
      // A prior attempt may have completed a rename but failed its directory
      // sync. Confirm durability even when the target already has the new text.
      if (transaction.content !== null) syncFile(file);
      syncDirectory(dirname(file));
      if (context !== undefined) {
        if (transaction.content !== null) {
          const draft = makeDocumentDraft({ path: transaction.path, title: transaction.title, content: transaction.content }, events,
            { turn: context.turn, step: context.step, parent: context.parent, source: 'write' });
          if (draft !== undefined) await this.append(context.sessionId, draft);
        }
        // The receipt is last: its fsynced transaction id makes replay idempotent,
        // including a crash between the content event and this receipt.
        await this.append(context.sessionId, {
          type: 'workspace.changed', turn: context.turn, step: context.step, parent: context.parent,
          scope: 'document', target: transaction.path, transactionId: transaction.id,
          change: transaction.content === null ? 'deleted' : transaction.before === null ? 'created' : 'updated',
          version: contentVersion(transaction.content ?? transaction.before ?? ''),
        });
      }
    }
    // A complete receipt observed after an fsync error is not yet a durability
    // acknowledgement. Flush its file again before discarding the recovery intent.
    if (context !== undefined) await this.sync(context.sessionId);
    unlinkSync(this.journal);
    syncDirectory(dirname(this.journal));
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
