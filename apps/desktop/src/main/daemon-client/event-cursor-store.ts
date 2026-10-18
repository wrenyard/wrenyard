/**
 * Durable cursor store for the daemon event stream. Desktop keeps one entry
 * per endpoint key (the stable daemon IPC path), so a restart resumes from
 * the last observed cursor instead of skipping events emitted while the app
 * was closed. State lives in a small JSON file next to the other Desktop
 * state; a missing or corrupt file is an empty map and a failed write is a
 * non-fatal warning, never a crash.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventCursorStore {
  private cursors: Record<string, string>;

  constructor(private readonly path: string) {
    this.cursors = this.load();
  }

  /** Read the persisted map; any failure starts from an empty map. */
  private load(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const cursors: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string' && value.length > 0) cursors[key] = value;
        }
        return cursors;
      }
    } catch (error) {
      console.warn('[wrenyard-desktop] event cursor state could not be read:', error instanceof Error ? error.message : String(error));
    }
    return {};
  }

  /** Write the whole map atomically via a temp file plus rename; non-fatal. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.cursors), 'utf8');
      renameSync(temporary, this.path);
    } catch (error) {
      console.warn('[wrenyard-desktop] event cursor state could not be written:', error instanceof Error ? error.message : String(error));
    }
  }

  /** Last recorded cursor for one endpoint key, when present. */
  lookup(key: string): string | undefined {
    return this.cursors[key];
  }

  /** Record the latest cursor for one endpoint key and persist immediately. */
  record(key: string, cursor: string): void {
    this.cursors = { ...this.cursors, [key]: cursor };
    this.persist();
  }

  /** Drop the cursor for one endpoint key, for example on endpoint switch. */
  clear(key: string): void {
    if (!(key in this.cursors)) return;
    const next = { ...this.cursors };
    delete next[key];
    this.cursors = next;
    this.persist();
  }
}
