/**
 * Desktop main-process ownership of the session-v2 feature.
 *
 * `registerSessionV2` is the single lifecycle entry point: it binds the feature
 * to the currently configured workspace, registers the `session-v2:*` IPC
 * handlers, and tears everything down on quit. The daemon is never modified —
 * the host reaches it through the owner-only NDJSON socket and the feature is
 * hosted in-process exactly like the spec requires.
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import {
  createSessionV2,
  type LedgerEvent,
  type SessionSummary,
  type SessionV2,
  type SessionV2Host,
} from '@wrenyard/session-v2';

import { createDesktopSessionV2Host } from './host.js';
import type {
  SessionV2BridgeEventPayload,
  SessionV2BridgeInterruptRequest,
  SessionV2BridgeModelEntry,
  SessionV2BridgeSendRequest,
} from './preload.js';

// Keep renderer-only Electron imports out of the main-process module graph.
export const SESSION_V2_CHANNELS = {
  list: 'session-v2:list', create: 'session-v2:create', ledger: 'session-v2:ledger',
  send: 'session-v2:send', interrupt: 'session-v2:interrupt', models: 'session-v2:models',
  event: 'session-v2:event',
} as const;
export type {
  SessionV2Bridge,
  SessionV2BridgeEventPayload,
  SessionV2BridgeInterruptRequest,
  SessionV2BridgeModelEntry,
  SessionV2BridgeSendRequest,
} from './preload.js';

export interface RegisterSessionV2Options {
  /** Owner-only daemon NDJSON socket path. */
  ipcPath: string;
  /** Desktop userData directory (the feature writes its ledger beneath it). */
  stateRoot: string;
  /** Current configured workspace root; undefined/empty while none is configured. */
  getWorkspaceRoot(): string | undefined;
  /** Device label surfaced in the frozen workspace snapshot. */
  deviceName?: string;
  /** Whether an IPC sender belongs to the trusted shell renderer. */
  isShellSender(sender: WebContents): boolean;
}

export interface SessionV2Registration {
  /** Interrupt every running turn, release the feature and unregister its IPC. */
  close(): Promise<void>;
}

/** Channels retired when the registration closes; `event` is push-only. */
const REGISTERED_CHANNELS = [
  SESSION_V2_CHANNELS.list,
  SESSION_V2_CHANNELS.create,
  SESSION_V2_CHANNELS.ledger,
  SESSION_V2_CHANNELS.send,
  SESSION_V2_CHANNELS.interrupt,
  SESSION_V2_CHANNELS.models,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`session-v2 参数无效：${label}`);
  return value;
}

function parseSendRequest(value: unknown): SessionV2BridgeSendRequest {
  if (!isRecord(value)) throw new Error('session-v2:send 参数无效');
  const model = value.model;
  if (!isRecord(model)) throw new Error('session-v2:send 缺少 model');
  return {
    sessionId: requireString(value.sessionId, 'sessionId'),
    text: typeof value.text === 'string' ? value.text : '',
    model: {
      provider: requireString(model.provider, 'model.provider'),
      model: requireString(model.model, 'model.model'),
      ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
    },
  };
}

function parseInterruptRequest(value: unknown): SessionV2BridgeInterruptRequest {
  if (!isRecord(value)) throw new Error('session-v2:interrupt 参数无效');
  const turn = value.turn;
  if (typeof turn !== 'number' || !Number.isFinite(turn)) {
    throw new Error('session-v2:interrupt 缺少 turn');
  }
  return { sessionId: requireString(value.sessionId, 'sessionId'), turn };
}

/** Project the live gateway list into the picker rows the renderer consumes. */
function toModelEntries(connection: WrenyardGatewayConnection): SessionV2BridgeModelEntry[] {
  return connection.models
    .filter((model) => !model.taskOnly && typeof model.publicId === 'string' && model.publicId.includes('/'))
    .map((model) => ({
      publicId: model.publicId,
      provider: model.provider,
      model: model.publicId.slice(model.publicId.indexOf('/') + 1),
      displayName: model.displayName,
      ...(Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0
        ? { thinkingLevels: [...model.thinkingLevels] }
        : {}),
    }));
}

/**
 * Register the session-v2 IPC surface. The host/session pair is bound to one
 * workspace root: Desktop's workspace switch invalidates it, so the old
 * instance is closed (interrupting its turns) and the next call builds a fresh
 * one against the new root. `close()` does the same teardown for process quit.
 */
export function registerSessionV2(options: RegisterSessionV2Options): SessionV2Registration {
  let closed = false;
  let host: SessionV2Host | null = null;
  let hostRoot: string | null = null;
  let session: SessionV2 | null = null;
  let unsubscribe: (() => void) | null = null;

  const assertShellSender = (event: IpcMainInvokeEvent): void => {
    if (!options.isShellSender(event.sender)) throw new Error('Untrusted shell IPC sender');
  };

  const detachSubscriber = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };

  const requireWorkspaceRoot = (): string => {
    const root = options.getWorkspaceRoot();
    if (typeof root !== 'string' || !root.trim()) {
      throw new Error('尚未配置 workspace，无法使用会话 v2');
    }
    return root;
  };

  const currentHost = (): SessionV2Host => {
    const workspaceRoot = requireWorkspaceRoot();
    if (host && hostRoot === workspaceRoot) return host;
    if (session) {
      const previous = session;
      session = null;
      void previous.close().catch(() => undefined);
    }
    detachSubscriber();
    host = createDesktopSessionV2Host({
      workspaceRoot,
      stateRoot: options.stateRoot,
      ipcPath: options.ipcPath,
      ...(options.deviceName !== undefined ? { deviceName: options.deviceName } : {}),
    });
    hostRoot = workspaceRoot;
    return host;
  };

  const currentSession = (): SessionV2 => {
    const active = currentHost();
    session ??= createSessionV2(active);
    return session;
  };

  ipcMain.handle(SESSION_V2_CHANNELS.list, (event: IpcMainInvokeEvent): SessionSummary[] => {
    assertShellSender(event);
    return currentSession().listSessions();
  });

  ipcMain.handle(SESSION_V2_CHANNELS.create, (event: IpcMainInvokeEvent): Promise<{ sessionId: string }> => {
    assertShellSender(event);
    return currentSession().createSession();
  });

  // Subscribe before reading: the snapshot is a prefix of the pushed stream, so
  // the renderer only has to dedupe by `seq` (and it handles events that arrive
  // while the snapshot is still in flight).
  ipcMain.handle(
    SESSION_V2_CHANNELS.ledger,
    (event: IpcMainInvokeEvent, sessionId: unknown): LedgerEvent[] => {
      assertShellSender(event);
      const active = currentSession();
      const id = requireString(sessionId, 'sessionId');
      detachSubscriber();
      const target = event.sender;
      unsubscribe = active.subscribe(id, (ledgerEvent) => {
        if (target.isDestroyed()) return;
        const payload: SessionV2BridgeEventPayload = { sessionId: id, event: ledgerEvent };
        target.send(SESSION_V2_CHANNELS.event, payload);
      });
      return active.readLedger(id);
    },
  );

  ipcMain.handle(SESSION_V2_CHANNELS.send, (event: IpcMainInvokeEvent, value: unknown) => {
    assertShellSender(event);
    const active = currentSession();
    const request = parseSendRequest(value);
    return active.send(request.sessionId, { text: request.text, model: request.model });
  });

  ipcMain.handle(
    SESSION_V2_CHANNELS.interrupt,
    async (event: IpcMainInvokeEvent, value: unknown): Promise<void> => {
      assertShellSender(event);
      const active = currentSession();
      const request = parseInterruptRequest(value);
      await active.interrupt(request.sessionId, request.turn);
    },
  );

  ipcMain.handle(
    SESSION_V2_CHANNELS.models,
    async (event: IpcMainInvokeEvent): Promise<SessionV2BridgeModelEntry[]> => {
      assertShellSender(event);
      return toModelEntries(await currentHost().gateway());
    },
  );

  if (options.getWorkspaceRoot()?.trim()) currentSession();

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      detachSubscriber();
      for (const channel of REGISTERED_CHANNELS) ipcMain.removeHandler(channel);
      const active = session;
      session = null;
      host = null;
      hostRoot = null;
      await active?.close();
    },
  };
}
