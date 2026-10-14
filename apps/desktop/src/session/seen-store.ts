/**
 * Main-process store for the shared "seen" state behind the 新结果 dot.
 *
 * Every window (the shell and each mini card) reads the same snapshot, so a
 * session marked seen in one window is seen everywhere. The state is kept in a
 * small JSON file in the same Desktop state/config directory as the settings
 * file, so it survives restarts without touching the settings schema.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Persisted shape: a first-load baseline plus the last-seen time per session. */
export interface SessionSeenState {
  /** ISO timestamp captured on the first load; earlier sessions are not unseen. */
  baselineAt: string;
  /** Last-seen ISO timestamp per session id. */
  seen: Record<string, string>;
}

export class SessionSeenStore {
  private state: SessionSeenState;

  constructor(private readonly path: string) {
    this.state = this.load();
  }

  /**
   * Read the persisted state. A missing file, or unreadable/invalid content,
   * is a first load: capture the baseline at "now" and write the file so that
   * sessions that already existed are not all reported as unseen.
   */
  private load(): SessionSeenState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SessionSeenState>;
      if (typeof parsed.baselineAt === 'string' && typeof parsed.seen === 'object' && parsed.seen !== null) {
        return { baselineAt: parsed.baselineAt, seen: { ...parsed.seen } };
      }
    } catch {
      // Missing or unparsable: fall through to the first-load path below.
    }
    const state: SessionSeenState = { baselineAt: new Date().toISOString(), seen: {} };
    this.persist(state);
    return state;
  }

  /** Write the whole state synchronously; a lost write is non-fatal. */
  private persist(state: SessionSeenState): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(state), 'utf8');
    } catch (error) {
      console.warn('[wrenyard-desktop] session seen state could not be written:', error instanceof Error ? error.message : String(error));
    }
  }

  /** Mark one session as seen now and persist immediately. */
  markSeen(sessionId: string): void {
    this.state = { ...this.state, seen: { ...this.state.seen, [sessionId]: new Date().toISOString() } };
    this.persist(this.state);
  }

  /** Current state for the renderer, returned as a defensive copy. */
  snapshot(): SessionSeenState {
    return { baselineAt: this.state.baselineAt, seen: { ...this.state.seen } };
  }
}
