/**
 * session live calls: in-memory streaming snapshots of the running `reason`
 * and `reply` calls, keyed by session and call id. The durable `call.started`
 * and `call` events, not this table, are the source of truth.
 */
import type { CallRunRequest, CallRunResult, CallsPort, LiveCall } from './ports.ts';

export class LiveCalls {
  private readonly liveCalls = new Map<string, Map<string, LiveCall>>();
  private readonly liveListeners = new Map<string, Set<(live: LiveCall[]) => void>>();

  subscribe(sessionId: string, listener: (live: LiveCall[]) => void): () => void {
    let set = this.liveListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.liveListeners.set(sessionId, set);
    }
    set.add(listener);
    const current = set;
    return () => {
      current.delete(listener);
      if (current.size === 0) this.liveListeners.delete(sessionId);
    };
  }

  /** Forget one session's snapshots. */
  drop(sessionId: string): void {
    this.liveCalls.delete(sessionId);
  }

  clear(): void {
    this.liveListeners.clear();
    this.liveCalls.clear();
  }

  /**
   * Wrap a session's call port so the streaming roles (`reason`, `reply`)
   * publish an in-memory snapshot while they run. The durable `call.started` /
   * `call` events, not this table, are the source of truth.
   */
  wrap(sessionId: string, inner: CallsPort): CallsPort {
    return { run: (input) => this.runCallWithLive(sessionId, inner, input) };
  }

  private async runCallWithLive(
    sessionId: string,
    inner: CallsPort,
    input: CallRunRequest,
  ): Promise<CallRunResult> {
    const streaming = input.role === 'reason' || input.role === 'reply';
    if (!streaming) return inner.run(input);
    this.beginLive(sessionId, input.callId);
    const onText = input.onText;
    const onReasoning = input.onReasoning;
    try {
      return await inner.run({
        ...input,
        onText: (delta) => {
          this.appendLive(sessionId, input.callId, 'text', delta);
          onText?.(delta);
        },
        onReasoning: (delta) => {
          this.appendLive(sessionId, input.callId, 'reasoning', delta);
          onReasoning?.(delta);
        },
      });
    } finally {
      // Covers success, failure and abort: the entry exists only while running.
      this.endLive(sessionId, input.callId);
    }
  }

  read(sessionId: string): LiveCall[] {
    const table = this.liveCalls.get(sessionId);
    if (!table) return [];
    return [...table.values()].map((call) => ({ ...call }));
  }

  private notifyLive(sessionId: string): void {
    const listeners = this.liveListeners.get(sessionId);
    if (!listeners || listeners.size === 0) return;
    const snapshot = this.read(sessionId);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A listener must never break the call it observes.
      }
    }
  }

  private beginLive(sessionId: string, callId: string): void {
    let table = this.liveCalls.get(sessionId);
    if (!table) {
      table = new Map();
      this.liveCalls.set(sessionId, table);
    }
    table.set(callId, { callId, text: '', reasoning: '' });
    this.notifyLive(sessionId);
  }

  private appendLive(sessionId: string, callId: string, field: 'text' | 'reasoning', delta: string): void {
    if (delta === '') return;
    const entry = this.liveCalls.get(sessionId)?.get(callId);
    if (!entry) return;
    entry[field] += delta;
    this.notifyLive(sessionId);
  }

  private endLive(sessionId: string, callId: string): void {
    const table = this.liveCalls.get(sessionId);
    if (!table) return;
    if (table.delete(callId)) this.notifyLive(sessionId);
    if (table.size === 0) this.liveCalls.delete(sessionId);
  }
}
