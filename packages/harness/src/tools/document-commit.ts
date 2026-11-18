/**
 * Workspace document commits and persistence validation hook, serialized over a
 * structural persistence authority so harness remains decoupled from any concrete
 * JSONL persistence implementation.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LedgerEvent, LedgerEventDraft } from '../events.ts';
import {
  contentVersion,
  currentDocument,
  documentChange,
  makeDocumentDraft,
} from './documents.ts';

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

export interface DocumentBeforeAppendContext {
  sessionId: string;
  events: readonly LedgerEvent[];
  draft: LedgerEventDraft;
  fromExclusive?: boolean;
  isSeed?: boolean;
}

export type DocumentBeforeAppendResult =
  | { action: 'append'; draft: LedgerEventDraft }
  | { action: 'return-existing'; event: LedgerEvent };

/**
 * Minimal structural persistence surface needed by the document authority.
 * Satisfied by `@wrenyard/session-jsonl`'s `JsonlSessionPersistence` without a
 * package dependency edge from `@wrenyard/harness`.
 */
export interface DocumentPersistencePort {
  read(sessionId: string): LedgerEvent[];
  enqueueExclusive?<T>(work: () => Promise<T>): Promise<T>;
  appendDirect?(
    sessionId: string,
    draft: LedgerEventDraft,
    options?: { fromExclusive?: boolean },
  ): Promise<LedgerEvent>;
  syncSessionFile?(sessionId: string): Promise<void>;
  setBeforeAppendHook?(
    hook?: (ctx: DocumentBeforeAppendContext) => DocumentBeforeAppendResult,
  ): void;
}

export interface DocumentAuthority {
  readonly committer: DocumentCommitter;
  commitDocument(input: DocumentCommit): Promise<void>;
  validateSnapshot(path: string, version: string): void;
  hasLegacyPending(): boolean;
}

function conflict(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** File data is flushed before rename; POSIX directory entries are flushed too. */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function replaceFile(file: string, content: string, id: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = resolve(dirname(file), `.${basename(file)}.${id}.tmp`);
  const fd = openSync(temp, 'w', existsSync(file) ? lstatSync(file).mode : 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
    if (this.content(file) !== input.before) throw conflict('conflict', 'Document changed before commit; read it again');
    let events: LedgerEvent[] = [];
    if (input.context !== undefined) {
      events = this.read(input.context.sessionId);
      if (!events.some((event) => event.type === 'session.created')) {
        throw conflict('missing_session', 'Document commit requires an existing session');
      }
      currentDocument(events, input.path);
    }
    if (input.content === null) unlinkSync(file);
    else replaceFile(file, input.content, randomUUID());
    try {
      syncDirectory(dirname(file));
    } catch (error) {
      throw conflict(
        'durability_failed',
        `Document was already changed but durability confirmation failed; read it again instead of retrying the write: ${errorCategory(error)}`,
      );
    }
    if (input.context === undefined) return;
    try {
      const context = input.context;
      if (input.content !== null) {
        const draft = makeDocumentDraft(
          { path: input.path, title: input.title, content: input.content },
          events,
          { turn: context.turn, step: context.step, parent: context.parent, source: 'write' },
        );
        if (draft !== undefined) await this.append(context.sessionId, draft);
      }
      await this.append(context.sessionId, {
        type: 'workspace.changed',
        turn: context.turn,
        step: context.step,
        parent: context.parent,
        scope: 'document',
        target: input.path,
        change: input.content === null ? 'deleted' : input.before === null ? 'created' : 'updated',
        version: contentVersion(input.content ?? input.before ?? ''),
      });
      await this.sync(context.sessionId);
    } catch (error) {
      throw conflict(
        'history_failed',
        `Document was already changed but its session history could not be recorded; read it again instead of retrying the write: ${errorCategory(error)}`,
      );
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
    if (key.includes('\0') || key.includes('\\') || key.includes(':')
      || key.split('/').some((part) => part === '.' || part === '..' || part === '')
      || !key.endsWith('.md')
      || (mutation && !/^projects\/(?:[^/]+\/)+(?:AGENTS\.md|docs\/(?:specs|reports|handoff)\/[^/]+\.md)$/u.test(key))) {
      throw new Error('Invalid document commit target');
    }
    const file = resolve(this.workspaceRoot, key);
    let ancestor = file;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const canonical = resolve(realpathSync(ancestor), relative(ancestor, file));
    const rel = relative(this.workspaceRoot, canonical);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || canonical !== file) {
      throw new Error('Document commit target escapes its canonical location');
    }
    return file;
  }
}

/**
 * Wire {@link DocumentCommitter} onto a persistence backend and attach the
 * `beforeAppend` document validation & unified-diff computation hook.
 */
export function createDocumentAuthority(options: {
  workspaceRoot: string;
  stateRoot: string;
  persistence: DocumentPersistencePort;
}): DocumentAuthority {
  const { workspaceRoot, stateRoot, persistence } = options;
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
  const directory = join(stateRoot, 'session', digest);

  const committer = new DocumentCommitter(
    workspaceRoot,
    directory,
    (sessionId) => persistence.read(sessionId),
    async (sessionId, draft) => {
      if (persistence.appendDirect === undefined) {
        throw new Error('Persistence adapter does not support document commits');
      }
      return persistence.appendDirect(sessionId, draft, { fromExclusive: true });
    },
    async (sessionId) => {
      if (persistence.syncSessionFile !== undefined) {
        await persistence.syncSessionFile(sessionId);
      }
    },
  );

  persistence.setBeforeAppendHook?.(({ events, draft, fromExclusive, isSeed }) => {
    if (isSeed === true) {
      return { action: 'append', draft };
    }
    const documentCommit = fromExclusive === true;
    if (draft.type === 'workspace.changed' && draft.scope === 'document' && !documentCommit) {
      throw new Error('Document changes must use commitDocument');
    }
    if (draft.type === 'document.content') {
      const { path, version } = draft;
      if (!documentCommit) committer.validateSnapshot(path, version);
      if (draft.source === 'write' && !documentCommit) {
        throw new Error('Document writes must use commitDocument');
      }
      if (draft.format !== 'full' || draft.base !== undefined || contentVersion(draft.content) !== version) {
        throw new Error('Document append requires a verified full snapshot');
      }
      const change = documentChange(path, currentDocument(events, path)?.content, draft.content);
      if (change === undefined) {
        let existing: LedgerEvent | undefined;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]!;
          if (event.type === 'document.content' && event.path === path && event.version === version) {
            existing = event;
            break;
          }
        }
        if (existing !== undefined) {
          return { action: 'return-existing', event: existing };
        }
      }
      const nextDraft = { ...draft, ...change };
      currentDocument([...events, { ...nextDraft, seq: 0, at: '' } as LedgerEvent], nextDraft.path);
      return { action: 'append', draft: nextDraft as LedgerEventDraft };
    }
    return { action: 'append', draft };
  });

  return {
    committer,
    async commitDocument(input: DocumentCommit): Promise<void> {
      const captured = structuredClone(input);
      if (persistence.enqueueExclusive !== undefined) {
        await persistence.enqueueExclusive(() => committer.commit(captured));
        return;
      }
      await committer.commit(captured);
    },
    validateSnapshot: (path, version) => committer.validateSnapshot(path, version),
    hasLegacyPending: () => committer.hasLegacyPending(),
  };
}
