import type { LedgerEvent, LedgerEventDraft, SessionSummary } from '@wrenyard/protocol/session';
import {
  SessionClosedError,
  SessionReadOnlyError,
  type SessionPage,
  type SessionStorageHandle,
  type SessionStorageMode,
} from '@wrenyard/session';

export interface JsonlStorageBackend {
  read(sessionId: string): LedgerEvent[];
  readPage(sessionId: string, afterSeq: number, limit: number): SessionPage<LedgerEvent>;
  appendDirect(sessionId: string, draft: LedgerEventDraft): Promise<LedgerEvent>;
  appendBatchDirect(sessionId: string, drafts: readonly LedgerEventDraft[]): Promise<LedgerEvent[]>;
  flush(): Promise<void>;
  stat(sessionId: string): SessionSummary | undefined;
}

export class JsonlStorageHandle implements SessionStorageHandle<LedgerEvent, SessionSummary> {
  readonly sessionId: string;
  readonly mode: SessionStorageMode;
  private closed = false;

  constructor(
    sessionId: string,
    mode: SessionStorageMode,
    private readonly backend: JsonlStorageBackend,
    private readonly onClose: () => void,
  ) {
    this.sessionId = sessionId;
    this.mode = mode;
  }

  read(): LedgerEvent[] {
    this.assertOpen();
    return this.backend.read(this.sessionId);
  }

  readPage(afterSeq: number, limit: number): SessionPage<LedgerEvent> {
    this.assertOpen();
    return this.backend.readPage(this.sessionId, afterSeq, limit);
  }

  async append(draft: LedgerEventDraft): Promise<LedgerEvent> {
    this.assertWritable();
    return this.backend.appendDirect(this.sessionId, draft);
  }

  async appendBatch(drafts: readonly LedgerEventDraft[]): Promise<LedgerEvent[]> {
    this.assertWritable();
    return this.backend.appendBatchDirect(this.sessionId, drafts);
  }

  async flush(): Promise<void> {
    this.assertWritable();
    return this.backend.flush();
  }

  summary(): SessionSummary | undefined {
    this.assertOpen();
    return this.backend.stat(this.sessionId);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.onClose();
    return Promise.resolve();
  }

  forceClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError();
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.mode === 'read') throw new SessionReadOnlyError(this.sessionId);
  }
}
