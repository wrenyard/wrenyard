/** Desktop transport for daemon-owned sessions. */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { WrenyardIpcClient, WrenyardRpcError, type WrenyardGatewayConnection } from '@wrenyard/control-client';
import { resolveModelMetadata, type LedgerEvent, type LiveCall, type SessionSummary } from '@wrenyard/session';
import type {
  SessionBridgeEventPayload,
  SessionBridgeLivePayload,
  SessionBridgeModelEntry,
  SessionBridgeTaskBrief,
} from './preload.js';

export const SESSION_CHANNELS = {
  list: 'session:list', create: 'session:create', ledger: 'session:ledger',
  send: 'session:send', interrupt: 'session:interrupt', models: 'session:models',
  context: 'session:context', tasks: 'session:tasks',
  event: 'session:event', live: 'session:live',
} as const;
export type {
  SessionBridge, SessionBridgeContextInspectRequest, SessionBridgeEventPayload,
  SessionBridgeInterruptRequest, SessionBridgeLivePayload, SessionBridgeModelEntry,
  SessionBridgeSendRequest, SessionBridgeTaskBrief,
} from './preload.js';

export interface RegisterSessionOptions {
  ipcPath: string;
  canConnect?: () => boolean;
  isShellSender(sender: WebContents): boolean;
}
export interface SessionRegistration { disconnect(): void; close(): Promise<void> }
interface EventPage { events: LedgerEvent[]; lastSeq: number; live?: LiveCall[] }
interface PollState {
  ownerId: number;
  target: WebContents;
  sessionId: string;
  afterSeq: number;
  controller: AbortController;
  onDestroyed(): void;
  /** Last live snapshot pushed to the renderer; undefined forces a refresh. */
  lastLive?: LiveCall[];
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
function toModelEntries(connection: WrenyardGatewayConnection): SessionBridgeModelEntry[] {
  return connection.models.filter(model => !model.taskOnly && model.publicId.includes('/')).map(model => {
    // Window facts resolve from the same config as the call budget, so the
    // renderer's model-change preview (and the ring) use identical numbers.
    const metadata = resolveModelMetadata(model.publicId);
    return {
      publicId: model.publicId, provider: model.provider,
      model: model.publicId.slice(model.publicId.indexOf('/') + 1), displayName: model.displayName,
      ...(model.thinkingLevels?.length ? { thinkingLevels: [...model.thinkingLevels] } : {}),
      ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
      ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    };
  });
}

/** Full-snapshot equality; an unchanged live table is not re-pushed. */
function sameLive(a: readonly LiveCall[], b: readonly LiveCall[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.callId !== right.callId || left.text !== right.text || left.reasoning !== right.reasoning) return false;
  }
  return true;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Runtime label from the actual resolved dispatch (execution client + model). */
function taskRuntimeLabel(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  // Prefer the resolved execution client (codex/codebuddy/etc.); provider only as fallback.
  const client = readString(record.client_display_name)
    ?? readString(record.client) ?? readString(record.provider_display_name) ?? readString(record.provider);
  const model = readString(record.model_display_name) ?? readString(record.model);
  if (client !== undefined && model !== undefined) return `${client} · ${model}`;
  return readString(record.runtime);
}

function taskUsage(value: unknown): { input?: number; output?: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const input = readNumber(record.input_tokens);
  const output = readNumber(record.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

/** Map a daemon `task.run.status` result into a renderer brief. */
function taskBriefFrom(taskRunId: string, value: unknown): SessionBridgeTaskBrief {
  if (typeof value !== 'object' || value === null) return { taskRunId, status: 'unavailable' };
  const record = value as Record<string, unknown>;
  const brief: SessionBridgeTaskBrief = {
    taskRunId: readString(record.task_run_id) ?? taskRunId,
    status: readString(record.status) ?? 'unavailable',
  };
  const name = readString(record.task_name) ?? readString(record.task_id);
  if (name !== undefined) brief.taskName = name;
  const runtime = taskRuntimeLabel(record.resolved);
  if (runtime !== undefined) brief.runtime = runtime;
  const summary = readString(record.summary);
  if (summary !== undefined) brief.summary = summary;
  const usage = taskUsage(record.usage);
  if (usage !== undefined) brief.usage = usage;
  return brief;
}

export function registerSession(options: RegisterSessionOptions): SessionRegistration {
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
    'session.events',
    { sessionId: state.sessionId, afterSeq: state.afterSeq, waitMs, live: true },
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
            const payload: SessionBridgeEventPayload = { sessionId: state.sessionId, event };
            state.target.send(SESSION_CHANNELS.event, payload);
            state.afterSeq = event.seq;
          }
          const live = page.live;
          if (live !== undefined && (state.lastLive === undefined || !sameLive(state.lastLive, live))) {
            state.lastLive = live.map(call => ({ ...call }));
            const payload: SessionBridgeLivePayload = { sessionId: state.sessionId, live };
            state.target.send(SESSION_CHANNELS.live, payload);
          }
          if (draining) {
            const status = await request<{ shutting_down: boolean }>('daemon.status', {}, signal);
            draining = status.shutting_down;
            if (draining) await delay(500, signal);
          }
        } catch (error) {
          if (signal.aborted) break;
          // Force a live refresh after any reconnect so the renderer is not stale.
          state.lastLive = undefined;
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
      if (!signal.aborted) console.warn('[session] event polling failed:', error);
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

  handle(SESSION_CHANNELS.list, async () =>
    (await request<{ sessions: SessionSummary[] }>('session.list', {})).sessions);
  handle(SESSION_CHANNELS.create, () => request('session.create', {}));
  handle(SESSION_CHANNELS.send, (_event, value) => request('session.send', value));
  handle(SESSION_CHANNELS.interrupt, async (_event, value) => { await request('session.interrupt', value); });
  handle(SESSION_CHANNELS.models, async () =>
    toModelEntries(await request<WrenyardGatewayConnection>('gateway.connection', {})));
  handle(SESSION_CHANNELS.context, (_event, value) =>
    request('session.context.inspect', value));
  handle(SESSION_CHANNELS.ledger, (event, value) => {
    if (typeof value !== 'string' || !value) throw new Error('Invalid sessionId');
    return openLedger(event.sender, value);
  });
  handle(SESSION_CHANNELS.tasks, async (_event, value) => {
    if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) {
      throw new Error('Invalid taskRunIds');
    }
    // Concurrent per-id status: one rejection only marks that entry unavailable.
    return Promise.all(value.map(async (taskRunId): Promise<SessionBridgeTaskBrief> => {
      try {
        return taskBriefFrom(taskRunId, await request('task.run.status', { task_run_id: taskRunId }));
      } catch {
        return { taskRunId, status: 'unavailable' };
      }
    }));
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
