/** Desktop transport for daemon-owned sessions. */
import { isAbsolute } from 'node:path';
import { dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { WrenyardIpcClient, WrenyardRpcError, type WrenyardGatewayConnection } from '@wrenyard/control';
import type { ReasoningEffort } from '@wrenyard/models';
import type { ProviderListResult } from '@wrenyard/protocol/provider';
import type { LedgerEvent, LiveCall, SessionSummary } from '@wrenyard/session';
import type { TaskRunUsage } from '../shell-contract.js';
import { toModelEntries } from './model-entries.js';
import type {
  SessionBridgeEventPayload,
  SessionBridgeLivePayload,
  SessionBridgeModelEntry,
  SessionBridgeTaskBrief,
} from './preload.js';
import {
  clipboardToRemoteAttachment,
  describeFiles,
  describeRemoteFiles,
  discardStagedFiles,
  stageClipboardImage,
} from './media.js';
import type { SessionSeenStore } from './seen-store.js';
import { StaleGenerationError } from '../main/remote/context.js';

export const SESSION_CHANNELS = {
  list: 'session:list', create: 'session:create', ledger: 'session:ledger',
  ledgerSnapshot: 'session:ledger-snapshot',
  send: 'session:send', interrupt: 'session:interrupt', models: 'session:models',
  cancelTask: 'session:cancel-task',
  context: 'session:context', tasks: 'session:tasks',
  routesPreview: 'session:routes-preview',
  promptSuggest: 'session:prompt-suggest', promptCancel: 'session:prompt-cancel',
  mediaRead: 'session:media-read', mediaReveal: 'session:media-reveal',
  delete: 'session:delete', mediaPick: 'session:media-pick',
  rename: 'session:rename',
  updateMetadata: 'session:update-metadata',
  mediaDescribe: 'session:media-describe', mediaStageClipboard: 'session:media-stage-clipboard',
  mediaDiscard: 'session:media-discard',
  seen: 'session:seen', seenState: 'session:seen-state',
  seenChanged: 'session:seen-changed',
  event: 'session:event', live: 'session:live',
} as const;
export type {
  SessionBridge, SessionBridgeContextInspectRequest, SessionBridgeEventPayload,
  SessionBridgeInterruptRequest, SessionBridgeLivePayload, SessionBridgeMediaRequest,
  SessionBridgeModelEntry, SessionBridgeSendRequest, SessionBridgeTaskBrief,
  SessionBridgeRoutesPreviewRequest,
  SessionPromptSuggestParams, SessionPromptSuggestResult, SessionPromptCancelParams,
  SessionMediaReadResult, SessionFile, DraftAttachment,
} from './preload.js';
export type {
  SessionRoutesPreviewParams, SessionRoutesPreviewResult, SessionRoutesPreviewRole,
} from '@wrenyard/protocol';

export interface RegisterSessionOptions {
  ipcPath: string;
  canConnect?: () => boolean;
  /**
   * Whether the active host context is *not* local (WY Remote): `connecting`,
   * `disconnected` and `remote` all count, because in none of them may a
   * locally picked/revealed path be used. When true the media surface is
   * remote-safe: locally picked/clipboard bytes become bounded `dataUrl`
   * uploads instead of local paths, and revealing a remote canonical path on
   * the local machine is refused.
   */
  isRemote?: () => boolean;
  /**
   * Active connection generation. Captured before every session request and
   * re-checked once it resolves, so a reply produced on the previous endpoint
   * is dropped instead of being applied to a surface that now belongs to a new
   * context. Applies to the ledger polls as well as the one-shot RPCs.
   */
  currentGeneration?: () => number;
  isShellSender(sender: WebContents): boolean;
  /**
   * Shared "seen" state behind the 新结果 dot. Every trusted window reads the
   * same snapshot, so a session marked seen in one window clears everywhere.
   */
  seenStore: SessionSeenStore;
  /**
   * Other trusted windows (the shell and every open mini card) that also
   * receive each polled live event, so a card sees live chat updates even when
   * another window owns the session's poll. Duplicate deliveries are harmless:
   * the renderer merges ledger events by `seq`.
   */
  additionalRecipients?(): WebContents[];
  /**
   * Observes live ledger events as they are polled and forwarded to the
   * renderer — never the initial catch-up page, so history is not replayed.
   * Used by the main-process conversation notification producer.
   */
  onLiveEvent?(sessionId: string, event: LedgerEvent): void;
}
export interface SessionRegistration {
  disconnect(): void;
  /**
   * Retire every per-window `session.events` poll and its in-flight client
   * without removing the registered IPC handlers, so a workspace switch stops
   * delivering the previous workspace's ledger events while later selections can
   * still subscribe. Late poll responses are dropped instead of forwarded.
   */
  reset(): void;
  close(): Promise<void>;
}
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
  /**
   * One socket for this subscription, created on first use and shared by the
   * catch-up drain, every long poll and the shutdown probe. Reusing it removes
   * a connect + version handshake per history page.
   */
  client?: WrenyardIpcClient;
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

/** Full-snapshot equality; an unchanged live table is not re-pushed. */
function sameLive(a: readonly LiveCall[], b: readonly LiveCall[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.spanId !== right.spanId || left.text !== right.text || left.reasoning !== right.reasoning) return false;
  }
  return true;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : undefined;
}

/**
 * `session:ledger` accepts either the bare session id (the original shape) or
 * `{ sessionId, afterSeq }` when the renderer already holds a cached tail.
 */
function readLedgerRequest(value: unknown): { sessionId: string; afterSeq: number } {
  if (typeof value === 'string' && value !== '') return { sessionId: value, afterSeq: 0 };
  if (typeof value !== 'object' || value === null) throw new Error('Invalid sessionId');
  const record = value as Record<string, unknown>;
  const sessionId = readString(record.sessionId);
  const afterSeq = record.afterSeq === undefined ? 0 : readNumber(record.afterSeq);
  if (sessionId === undefined || afterSeq === undefined
    || !Number.isInteger(afterSeq) || afterSeq < 0) {
    throw new Error('Invalid sessionId');
  }
  return { sessionId, afterSeq };
}

/** `{ sessionId, path }` shared by the media read/reveal handlers. */
function readMediaRequest(value: unknown): { sessionId: string; path: string } {
  if (typeof value !== 'object' || value === null) throw new Error('媒体请求无效');
  const record = value as Record<string, unknown>;
  const sessionId = readString(record.sessionId);
  const path = readString(record.path);
  if (sessionId === undefined || path === undefined) throw new Error('媒体请求无效');
  return { sessionId, path };
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

/**
 * Full per-run usage from the daemon wire, or undefined when the row carries
 * none. Numeric fields stay absent when the daemon omitted them; only the
 * identity/completeness fields the schema requires are defaulted.
 */
function taskUsage(value: unknown): TaskRunUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const completeness = record.completeness;
  const usage: TaskRunUsage = {
    completeness: completeness === 'complete' || completeness === 'partial' || completeness === 'unavailable'
      ? completeness
      : 'unavailable',
    attemptCount: readNumber(record.attempt_count) ?? 0,
    usageEventCount: readNumber(record.usage_event_count) ?? 0,
    referenceCostComplete: record.reference_cost_complete === true,
  };
  const inputTokens = readNumber(record.input_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  const cachedInputTokens = readNumber(record.cached_input_tokens);
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  const cacheReadInputTokens = readNumber(record.cache_read_input_tokens);
  if (cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = cacheReadInputTokens;
  const cacheCreationInputTokens = readNumber(record.cache_creation_input_tokens);
  if (cacheCreationInputTokens !== undefined) usage.cacheCreationInputTokens = cacheCreationInputTokens;
  const outputTokens = readNumber(record.output_tokens);
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  const totalTokens = readNumber(record.total_tokens);
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  const generationMs = readNumber(record.generation_ms);
  if (generationMs !== undefined) usage.generationMs = generationMs;
  const outputTps = readNumber(record.output_tps);
  if (outputTps !== undefined) usage.outputTps = outputTps;
  const referenceCostUsd = readNumber(record.reference_cost_usd);
  if (referenceCostUsd !== undefined) usage.referenceCostUsd = referenceCostUsd;
  const referenceCostBasis = readString(record.reference_cost_basis);
  if (referenceCostBasis !== undefined) usage.referenceCostBasis = referenceCostBasis;
  return usage;
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
  /** Drop a reply whose connection generation a switch already superseded. */
  const assertCurrentGeneration = (generation: number | undefined): void => {
    if (generation === undefined) return;
    if (options.currentGeneration?.() !== generation) {
      throw new StaleGenerationError('连接上下文已切换，忽略过期结果');
    }
  };
  const request = <T,>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
    if (closed || signal?.aborted) return Promise.reject(aborted());
    if (options.canConnect?.() === false) return Promise.reject(new Error('daemon 不可用'));
    const generation = options.currentGeneration?.();
    const client = new WrenyardIpcClient({ path: options.ipcPath, requestTimeoutMs: 30_000 });
    clients.add(client);
    const stop = (): void => client.close();
    signal?.addEventListener('abort', stop, { once: true });
    return track(client.request<T>(method, params).then((result) => {
      // The context may have switched while this request was in flight: the
      // reply belongs to the previous endpoint and must not reach a view.
      assertCurrentGeneration(generation);
      return result;
    }).finally(() => {
      signal?.removeEventListener('abort', stop);
      clients.delete(client);
      client.close();
    }));
  };
  /** Retire the subscription's shared socket; a later page reconnects lazily. */
  const closePollClient = (state: PollState): void => {
    const client = state.client;
    if (client === undefined) return;
    state.client = undefined;
    clients.delete(client);
    client.close();
  };
  const stopPoll = (state: PollState): void => {
    state.controller.abort();
    state.target.removeListener('destroyed', state.onDestroyed);
    if (polls.get(state.ownerId) === state) polls.delete(state.ownerId);
    closePollClient(state);
  };
  /**
   * A request on the subscription's own socket. The socket outlives a single
   * page: the drain and the long poll share it, so switching sessions no
   * longer pays one connect and handshake per 500-event page. A failed socket
   * is dropped and the retry loop reconnects on the next attempt.
   */
  const pollRequest = <T,>(state: PollState, method: string, params: unknown): Promise<T> => {
    const signal = state.controller.signal;
    if (closed || signal.aborted) return Promise.reject(aborted());
    if (options.canConnect?.() === false) return Promise.reject(new Error('daemon 不可用'));
    const generation = options.currentGeneration?.();
    let client = state.client;
    if (client === undefined) {
      client = new WrenyardIpcClient({ path: options.ipcPath, requestTimeoutMs: 30_000 });
      state.client = client;
      clients.add(client);
    }
    return client.request<T>(method, params).then((result) => {
      assertCurrentGeneration(generation);
      return result;
    }).catch((error: unknown) => {
      // A closed or failed socket cannot carry another page; reconnect next time.
      if (state.client === client) closePollClient(state);
      throw error;
    });
  };
  const readPage = (state: PollState, waitMs: number): Promise<EventPage> => pollRequest<EventPage>(
    state,
    'session.events',
    { sessionId: state.sessionId, afterSeq: state.afterSeq, waitMs, live: true },
  );
  /**
   * Every window a polled event is pushed to: the poll's own target plus the
   * other trusted surfaces (the shell and any open mini card). Duplicates are
   * de-duplicated by web contents id.
   */
  const eventRecipients = (state: PollState): WebContents[] => {
    const recipients: WebContents[] = [];
    const seen = new Set<number>();
    for (const target of [state.target, ...(options.additionalRecipients?.() ?? [])]) {
      if (target.isDestroyed() || seen.has(target.id)) continue;
      seen.add(target.id);
      recipients.push(target);
    }
    return recipients;
  };
  /**
   * Push the shared seen snapshot to every trusted surface — the shell and all
   * open mini cards — so a session seen in one window clears in the others.
   */
  const broadcastSeen = (): void => {
    const payload = options.seenStore.snapshot();
    for (const recipient of options.additionalRecipients?.() ?? []) {
      if (!recipient.isDestroyed()) recipient.send(SESSION_CHANNELS.seenChanged, payload);
    }
  };
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
            for (const recipient of eventRecipients(state)) recipient.send(SESSION_CHANNELS.event, payload);
            state.afterSeq = event.seq;
            options.onLiveEvent?.(state.sessionId, event);
          }
          const live = page.live;
          if (live !== undefined && (state.lastLive === undefined || !sameLive(state.lastLive, live))) {
            state.lastLive = live.map(call => ({ ...call }));
            const payload: SessionBridgeLivePayload = { sessionId: state.sessionId, live };
            for (const recipient of eventRecipients(state)) recipient.send(SESSION_CHANNELS.live, payload);
          }
          if (draining) {
            const status = await pollRequest<{ shutting_down: boolean }>(state, 'daemon.status', {});
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
            // Treat any RPC failure as transient: log it and keep polling
            // instead of tearing the loop down and leaving the UI stale.
            if (error instanceof WrenyardRpcError && error.code !== -32001) {
              console.warn(`[session] event poll failed (code ${error.code}), retrying:`, error);
            }
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
  /**
   * Subscribe `target` to `sessionId` and return the catch-up page. A caller
   * that already holds the tail of the ledger (a recently opened session) may
   * pass `afterSeq`, so only the delta is drained and returned.
   */
  const openLedger = async (target: WebContents, sessionId: string, afterSeq = 0): Promise<LedgerEvent[]> => {
    const previous = polls.get(target.id);
    if (previous) stopPoll(previous);
    const state: PollState = {
      ownerId: target.id, target, sessionId, afterSeq, controller: new AbortController(),
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
      return track(Promise.resolve().then(() => operation(event, value)).catch((error: unknown) => {
        // Closing the relay intentionally cancels in-flight IPC requests.
        // Do not report that known teardown cancellation as a handler failure.
        if (closed && error instanceof Error && error.message === 'WrenyardIpcClient closed before response') return undefined;
        throw error;
      }));
    });
  };

  handle(SESSION_CHANNELS.list, async () =>
    (await request<{ sessions: SessionSummary[] }>('session.list', {})).sessions);
  handle(SESSION_CHANNELS.create, () => request('session.create', {}));
  handle(SESSION_CHANNELS.send, (_event, value) => request('session.send', value));
  handle(SESSION_CHANNELS.interrupt, async (_event, value) => { await request('session.interrupt', value); });
  handle(SESSION_CHANNELS.cancelTask, async (_event, value) => {
    if (typeof value !== 'string' || value === '') throw new Error('Invalid taskRunId');
    const result = await request<{ ok?: boolean; message?: string }>('task.run.cancel', { task_run_id: value });
    if (result?.ok === false) throw new Error(result.message ?? '取消任务失败');
  });
  handle(SESSION_CHANNELS.models, async () => {
    // The Provider list carries configured eligibility and display metadata;
    // the Gateway connection carries each model's own protocols, which is the
    // only source for the model's session protocol.
    const [providers, connection] = await Promise.all([
      request<ProviderListResult>('provider.list', {}),
      request<WrenyardGatewayConnection>('gateway.connection', {}),
    ]);
    return toModelEntries(providers, connection.models);
  });
  handle(SESSION_CHANNELS.context, (_event, value) =>
    request('session.context.inspect', value));
  handle(SESSION_CHANNELS.routesPreview, (_event, value) =>
    request('session.routes.preview', value ?? {}));
  // Forwarded verbatim: the daemon owns the session context and the cancel
  // semantics; the main process never reads or caches conversation text.
  handle(SESSION_CHANNELS.promptSuggest, (_event, value) =>
    request('session.prompt.suggest', value));
  handle(SESSION_CHANNELS.promptCancel, async (_event, value) => {
    await request('session.prompt.cancel', value);
  });
  handle(SESSION_CHANNELS.ledger, (event, value) => {
    const ledger = readLedgerRequest(value);
    return openLedger(event.sender, ledger.sessionId, ledger.afterSeq);
  });
  handle(SESSION_CHANNELS.ledgerSnapshot, async (_event, value) => {
    if (typeof value !== 'string' || !value) throw new Error('Invalid sessionId');
    if (options.canConnect?.() === false) throw new Error('daemon 不可用');
    // One client for the whole drain: each page would otherwise pay its own
    // connect and version handshake on the same read-only snapshot.
    const generation = options.currentGeneration?.();
    const client = new WrenyardIpcClient({ path: options.ipcPath, requestTimeoutMs: 30_000 });
    clients.add(client);
    try {
      const events: LedgerEvent[] = [];
      let afterSeq = 0;
      while (true) {
        const page = await client.request<EventPage>('session.events', { sessionId: value, afterSeq, waitMs: 0 });
        assertCurrentGeneration(generation);
        events.push(...page.events);
        if (page.events.length) afterSeq = page.events[page.events.length - 1]!.seq;
        if (afterSeq >= page.lastSeq) return events;
      }
    } finally {
      clients.delete(client);
      client.close();
    }
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
  // `send` above already forwards its request untouched, so `attachments`
  // ride along without a dedicated channel.
  handle(SESSION_CHANNELS.mediaRead, (_event, value) =>
    request('session.media.read', readMediaRequest(value)));
  handle(SESSION_CHANNELS.mediaReveal, async (_event, value) => {
    const media = readMediaRequest(value);
    // A remote canonical path is a path on the *remote* host: revealing it in
    // the local file manager would either fail or expose an unrelated local
    // file. Remote media is read through `session.media.read` instead, so this
    // local-only action fails explicitly while remote.
    if (options.isRemote?.() === true) {
      throw new Error('远程模式下无法在本地打开远程媒体文件');
    }
    // The daemon authorizes the ledger-known file and returns its canonical
    // path. Reveal exactly that path — never the renderer-requested raw value —
    // and only after it is a nonempty absolute string.
    const result = await request<{ path?: unknown }>('session.media.read', media);
    const canonical = readString(result?.path);
    if (canonical === undefined || !isAbsolute(canonical)) throw new Error('媒体路径无效');
    shell.showItemInFolder(canonical);
  });
  handle(SESSION_CHANNELS.delete, async (_event, value) => {
    const sessionId = readString(value);
    if (sessionId === undefined) throw new Error('会话 id 无效');
    await request('session.delete', { sessionId });
  });
  handle(SESSION_CHANNELS.rename, async (_event, value) => {
    if (typeof value !== 'object' || value === null) throw new Error('会话标题无效');
    const record = value as Record<string, unknown>;
    const sessionId = readString(record.sessionId);
    const title = readString(record.title);
    if (sessionId === undefined || title === undefined) throw new Error('会话标题无效');
    await request('session.rename', { sessionId, title });
  });
  handle(SESSION_CHANNELS.updateMetadata, async (_event, value) => {
    if (typeof value !== 'object' || value === null) throw new Error('会话元数据无效');
    const record = value as Record<string, unknown>;
    const sessionId = readString(record.sessionId);
    const archived = record.archived;
    const pinned = record.pinned;
    if (sessionId === undefined || (archived !== undefined && typeof archived !== 'boolean')
      || (pinned !== undefined && typeof pinned !== 'boolean')) {
      throw new Error('会话元数据无效');
    }
    if (archived === undefined && pinned === undefined) throw new Error('会话元数据无效');
    await request('session.updateMetadata', {
      sessionId,
      ...(archived === undefined ? {} : { archived }),
      ...(pinned === undefined ? {} : { pinned }),
    });
  });
  handle(SESSION_CHANNELS.mediaPick, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    // Remote: the daemon cannot read a local path, so the picked bytes become
    // bounded `dataUrl` uploads. Local: the path is forwarded as before.
    return options.isRemote?.() === true
      ? describeRemoteFiles(result.filePaths)
      : describeFiles(result.filePaths);
  });
  handle(SESSION_CHANNELS.mediaDescribe, async (_event, value) => {
    const paths = readStringArray(value);
    if (paths === undefined) throw new Error('文件路径无效');
    return options.isRemote?.() === true ? describeRemoteFiles(paths) : describeFiles(paths);
  });
  handle(SESSION_CHANNELS.mediaStageClipboard, (_event, value) => {
    if (typeof value !== 'object' || value === null) throw new Error('剪贴板图片无效');
    const record = value as Record<string, unknown>;
    const dataUrl = readString(record.dataUrl);
    if (dataUrl === undefined) throw new Error('剪贴板图片无效');
    const name = readString(record.name);
    const input = { dataUrl, ...(name === undefined ? {} : { name }) };
    // Remote: forward the bytes as a dataUrl attachment without staging a local
    // file (its path would be meaningless to the remote daemon). Local: stage
    // the image on disk exactly as before.
    return options.isRemote?.() === true
      ? clipboardToRemoteAttachment(input)
      : stageClipboardImage(input);
  });
  handle(SESSION_CHANNELS.mediaDiscard, async (_event, value) => {
    if (!Array.isArray(value)) throw new Error('附件列表无效');
    // Only drafts explicitly flagged as main-staged are eligible; a user's
    // source path can never be removed even if the renderer asks.
    const staged = value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => item.staged === true)
      .map((item) => (typeof item.path === 'string' ? item.path : ''))
      .filter((path) => path !== '');
    await discardStagedFiles(staged);
  });
  handle(SESSION_CHANNELS.seen, (_event, value) => {
    const sessionId = readString(value);
    if (sessionId === undefined) throw new Error('会话 id 无效');
    options.seenStore.markSeen(sessionId);
    broadcastSeen();
  });
  handle(SESSION_CHANNELS.seenState, () => options.seenStore.snapshot());

  return {
    disconnect(): void {
      for (const client of clients) client.close();
      clients.clear();
      // The polls stay subscribed: dropping their dead sockets lets the next
      // page reconnect lazily on the new endpoint.
      for (const state of polls.values()) state.client = undefined;
    },
    // Retires the previous workspace's polls only: each stopPoll aborts the poll
    // controller (closing its in-flight request, so a late page is dropped) and
    // removes the ledger-event listeners, then the owner map is cleared so no
    // stale subscription survives. The IPC handlers stay registered for later
    // session selections.
    reset(): void {
      for (const state of polls.values()) stopPoll(state);
      polls.clear();
    },
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
