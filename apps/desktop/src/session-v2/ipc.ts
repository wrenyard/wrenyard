/** Desktop transport for daemon-owned session-v2 sessions. */
import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { WrenyardIpcClient, WrenyardRpcError, type WrenyardGatewayConnection } from '@wrenyard/control-client';
import type { LedgerEvent, SessionSummary } from '@wrenyard/session-v2';
import type {
  SessionV2BridgeEventPayload,
  SessionV2BridgeModelEntry,
} from './preload.js';

export const SESSION_V2_CHANNELS = {
  list: 'session-v2:list', create: 'session-v2:create', ledger: 'session-v2:ledger',
  send: 'session-v2:send', interrupt: 'session-v2:interrupt', models: 'session-v2:models',
  openExternal: 'session-v2:open-external',
  event: 'session-v2:event',
} as const;
export type {
  SessionV2Bridge, SessionV2BridgeEventPayload, SessionV2BridgeInterruptRequest,
  SessionV2BridgeModelEntry, SessionV2BridgeSendRequest,
} from './preload.js';

export interface RegisterSessionV2Options {
  ipcPath: string;
  canConnect?: () => boolean;
  isShellSender(sender: WebContents): boolean;
}
export interface SessionV2Registration { disconnect(): void; close(): Promise<void> }
interface EventPage { events: LedgerEvent[]; lastSeq: number }
interface PollState {
  ownerId: number;
  target: WebContents;
  sessionId: string;
  afterSeq: number;
  controller: AbortController;
  onDestroyed(): void;
}

function aborted(): Error { return new Error('Session relay stopped'); }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => { signal.removeEventListener('abort', stop); resolve(); };
    const stop = (): void => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(finish, ms);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}
function isShuttingDown(error: unknown): boolean {
  return error instanceof WrenyardRpcError && typeof error.data === 'object' && error.data !== null
    && 'code' in error.data && error.data.code === 'daemon_shutting_down';
}
function toModelEntries(connection: WrenyardGatewayConnection): SessionV2BridgeModelEntry[] {
  return connection.models.filter(model => !model.taskOnly && model.publicId.includes('/')).map(model => ({
    publicId: model.publicId, provider: model.provider,
    model: model.publicId.slice(model.publicId.indexOf('/') + 1), displayName: model.displayName,
    ...(model.thinkingLevels?.length ? { thinkingLevels: [...model.thinkingLevels] } : {}),
  }));
}

export function registerSessionV2(options: RegisterSessionV2Options): SessionV2Registration {
  const polls = new Map<number, PollState>();
  const clients = new Set<WrenyardIpcClient>();
  const work = new Set<Promise<unknown>>();
  const channels: string[] = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const track = <T,>(promise: Promise<T>): Promise<T> => {
    work.add(promise);
    void promise.then(() => work.delete(promise), () => work.delete(promise));
    return promise;
  };
  const request = <T,>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
    if (closed || signal?.aborted) return Promise.reject(aborted());
    if (options.canConnect?.() === false) return Promise.reject(new Error('daemon 不可用'));
    const client = new WrenyardIpcClient({ path: options.ipcPath, requestTimeoutMs: 30_000 });
    clients.add(client);
    const stop = (): void => client.close();
    signal?.addEventListener('abort', stop, { once: true });
    return track(client.request<T>(method, params).finally(() => {
      signal?.removeEventListener('abort', stop);
      clients.delete(client);
      client.close();
    }));
  };
  const stopPoll = (state: PollState): void => {
    state.controller.abort();
    state.target.removeListener('destroyed', state.onDestroyed);
    if (polls.get(state.ownerId) === state) polls.delete(state.ownerId);
  };
  const readPage = (state: PollState, waitMs: number): Promise<EventPage> => request(
    'sessionV2.events',
    { sessionId: state.sessionId, afterSeq: state.afterSeq, waitMs },
    state.controller.signal,
  );
  const poll = async (state: PollState): Promise<void> => {
    const signal = state.controller.signal;
    let draining = false;
    try {
      while (!signal.aborted) {
        try {
          const page = await readPage(state, draining ? 0 : 1000);
          if (signal.aborted || state.target.isDestroyed()) break;
          for (const event of page.events) {
            const payload: SessionV2BridgeEventPayload = { sessionId: state.sessionId, event };
            state.target.send(SESSION_V2_CHANNELS.event, payload);
            state.afterSeq = event.seq;
          }
          if (draining) {
            const status = await request<{ shutting_down: boolean }>('daemon.status', {}, signal);
            draining = status.shutting_down;
            if (draining) await delay(500, signal);
          }
        } catch (error) {
          if (signal.aborted) break;
          if (isShuttingDown(error)) {
            draining = true;
            await delay(500, signal);
          } else {
            // Business/protocol errors cannot be repaired by reconnecting.
            if (error instanceof WrenyardRpcError && error.code !== -32001) throw error;
            draining = false;
            await delay(1000, signal);
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) console.warn('[session-v2] event polling failed:', error);
    } finally {
      stopPoll(state);
    }
  };
  const openLedger = async (target: WebContents, sessionId: string): Promise<LedgerEvent[]> => {
    const previous = polls.get(target.id);
    if (previous) stopPoll(previous);
    const state: PollState = {
      ownerId: target.id, target, sessionId, afterSeq: 0, controller: new AbortController(),
      onDestroyed: () => stopPoll(state),
    };
    polls.set(target.id, state);
    target.once('destroyed', state.onDestroyed);
    const events: LedgerEvent[] = [];
    try {
      while (!state.controller.signal.aborted) {
        const page = await readPage(state, 0);
        if (state.controller.signal.aborted) throw aborted();
        events.push(...page.events);
        if (page.events.length) state.afterSeq = page.events[page.events.length - 1]!.seq;
        if (state.afterSeq >= page.lastSeq) break;
      }
      if (state.controller.signal.aborted) throw aborted();
      // Appends after the snapshot are read from this exact cursor by the poll.
      track(poll(state));
      return events;
    } catch (error) {
      stopPoll(state);
      throw error;
    }
  };
  const handle = (channel: string, operation: (event: IpcMainInvokeEvent, value: unknown) => unknown): void => {
    channels.push(channel);
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, value: unknown) => {
      if (!options.isShellSender(event.sender)) throw new Error('Untrusted shell IPC sender');
      if (closed) throw aborted();
      return track(Promise.resolve().then(() => operation(event, value)));
    });
  };

  handle(SESSION_V2_CHANNELS.list, async () =>
    (await request<{ sessions: SessionSummary[] }>('sessionV2.list', {})).sessions);
  handle(SESSION_V2_CHANNELS.create, () => request('sessionV2.create', {}));
  handle(SESSION_V2_CHANNELS.send, (_event, value) => request('sessionV2.send', value));
  handle(SESSION_V2_CHANNELS.interrupt, async (_event, value) => { await request('sessionV2.interrupt', value); });
  handle(SESSION_V2_CHANNELS.models, async () =>
    toModelEntries(await request<WrenyardGatewayConnection>('gateway.connection', {})));
  handle(SESSION_V2_CHANNELS.ledger, (event, value) => {
    if (typeof value !== 'string' || !value) throw new Error('Invalid sessionId');
    return openLedger(event.sender, value);
  });
  handle(SESSION_V2_CHANNELS.openExternal, async (_event, value) => {
    if (typeof value !== 'string' || value === '') throw new Error('Invalid URL');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Invalid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported URL protocol');
    await shell.openExternal(url.toString());
  });

  return {
    disconnect(): void { for (const client of clients) client.close(); },
    close(): Promise<void> {
      closePromise ??= (async () => {
        closed = true;
        for (const channel of channels) ipcMain.removeHandler(channel);
        for (const state of polls.values()) stopPoll(state);
        for (const client of clients) client.close();
        await Promise.allSettled([...work]);
      })();
      return closePromise;
    },
  };
}
