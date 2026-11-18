import type { LiveFrame } from './types.ts';

/**
 * Ephemeral streaming snapshot hub keyed by `(sessionId, spanId)`.
 * Durable events remain authoritative; this hub only bridges in-flight frames
 * and isolates subscriber exceptions.
 */
export class LiveStreamHub {
  private readonly frames = new Map<string, Map<string, LiveFrame>>();
  private readonly listeners = new Map<string, Set<(frames: LiveFrame[]) => void>>();

  begin(sessionId: string, spanId: string): void {
    let table = this.frames.get(sessionId);
    if (table === undefined) {
      table = new Map();
      this.frames.set(sessionId, table);
    }
    table.set(spanId, { spanId, text: '', reasoning: '' });
    this.notify(sessionId);
  }

  append(sessionId: string, spanId: string, field: 'text' | 'reasoning', delta: string): void {
    if (delta === '') return;
    const frame = this.frames.get(sessionId)?.get(spanId);
    if (frame === undefined) return;
    frame[field] += delta;
    this.notify(sessionId);
  }

  end(sessionId: string, spanId: string): void {
    const table = this.frames.get(sessionId);
    if (table === undefined) return;
    const deleted = table.delete(spanId);
    if (table.size === 0) {
      this.frames.delete(sessionId);
    }
    if (deleted) {
      this.notify(sessionId);
    }
  }

  read(sessionId: string): LiveFrame[] {
    const table = this.frames.get(sessionId);
    if (table === undefined) return [];
    return [...table.values()].map((frame) => ({ ...frame }));
  }

  subscribe(sessionId: string, listener: (frames: LiveFrame[]) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    const current = set;
    return () => {
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  drop(sessionId: string): void {
    this.frames.delete(sessionId);
  }

  clear(): void {
    this.listeners.clear();
    this.frames.clear();
  }

  private notify(sessionId: string): void {
    const set = this.listeners.get(sessionId);
    if (set === undefined || set.size === 0) return;
    const snapshot = this.read(sessionId);
    for (const listener of [...set]) {
      try {
        listener(snapshot);
      } catch {
        // Isolate listener failures so streaming calls are unaffected.
      }
    }
  }
}
