/**
 * Renderer-facing session-v2 bridge.
 *
 * This module is bundled into the shell preload (sandboxed, context-isolated)
 * and intentionally imports nothing but Electron: the channel names live here
 * as the single source of truth and are imported by `ipc.ts` on the main side.
 * The renderer only ever sees the frozen `window.sessionV2` facade below.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LedgerEvent, SessionSummary } from '@wrenyard/session-v2';

/** Exact main↔renderer channels of the session-v2 test surface. */
export const SESSION_V2_CHANNELS = {
  /** Renderer → main: the session list. */
  list: 'session-v2:list',
  /** Renderer → main: create a session. */
  create: 'session-v2:create',
  /** Renderer → main: read a session's full ledger (also subscribes the caller). */
  ledger: 'session-v2:ledger',
  /** Renderer → main: `{ sessionId, text, model }`. */
  send: 'session-v2:send',
  /** Renderer → main: `{ sessionId, turn }`. */
  interrupt: 'session-v2:interrupt',
  /** Renderer → main: the gateway model list. */
  models: 'session-v2:models',
  /** Renderer → main: open an external http(s) URL in the OS browser. */
  openExternal: 'session-v2:open-external',
  /** Main → renderer: `{ sessionId, event }` for the subscribed session. */
  event: 'session-v2:event',
} as const;

/** One selectable model row: gateway public id plus its thinking levels. */
export interface SessionV2BridgeModelEntry {
  publicId: string;
  provider: string;
  model: string;
  displayName: string;
  thinkingLevels?: string[];
}

export interface SessionV2BridgeSendRequest {
  sessionId: string;
  text: string;
  model: { provider: string; model: string; reasoningEffort?: string };
}

export interface SessionV2BridgeInterruptRequest {
  sessionId: string;
  turn: number;
}

export interface SessionV2BridgeEventPayload {
  sessionId: string;
  event: LedgerEvent;
}

/** The `window.sessionV2` facade consumed by the renderer test page. */
export interface SessionV2Bridge {
  /** Every known session, newest first (daemon/feature order). */
  list(): Promise<SessionSummary[]>;
  /** Create a session; its workspace snapshot is frozen immediately. */
  create(): Promise<{ sessionId: string }>;
  /**
   * Read a session's complete ledger. The caller is subscribed to that session
   * before the snapshot is returned, so no event can be missed; later events
   * arrive through {@link SessionV2Bridge.onEvent}.
   */
  ledger(sessionId: string): Promise<LedgerEvent[]>;
  /** Send one user message; resolves with the allocated turn number. */
  send(request: SessionV2BridgeSendRequest): Promise<{ turn: number }>;
  /** Interrupt one running turn. */
  interrupt(request: SessionV2BridgeInterruptRequest): Promise<void>;
  /** The live gateway models the reason-model picker may offer. */
  models(): Promise<SessionV2BridgeModelEntry[]>;
  /** Open an `http:`/`https:` URL in the OS browser; other schemes are rejected. */
  openExternal(url: string): Promise<void>;
  /** Subscribe to pushed ledger events; the returned function unsubscribes. */
  onEvent(listener: (payload: SessionV2BridgeEventPayload) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEventPayload(value: unknown): value is SessionV2BridgeEventPayload {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && isRecord(value.event);
}

const bridge: SessionV2Bridge = {
  list(): Promise<SessionSummary[]> {
    return ipcRenderer.invoke(SESSION_V2_CHANNELS.list) as Promise<SessionSummary[]>;
  },
  create(): Promise<{ sessionId: string }> {
    return ipcRenderer.invoke(SESSION_V2_CHANNELS.create) as Promise<{ sessionId: string }>;
  },
  ledger(sessionId: string): Promise<LedgerEvent[]> {
    return ipcRenderer.invoke(SESSION_V2_CHANNELS.ledger, sessionId) as Promise<LedgerEvent[]>;
  },
  send(request: SessionV2BridgeSendRequest): Promise<{ turn: number }> {
    return ipcRenderer.invoke(SESSION_V2_CHANNELS.send, request) as Promise<{ turn: number }>;
  },
  interrupt(request: SessionV2BridgeInterruptRequest): Promise<void> {
    return ipcRenderer.invoke(SESSION_V2_CHANNELS.interrupt, request) as Promise<void>;
  },
  models(): Promise<SessionV2BridgeModelEntry[]> {
    return ipcRenderer.invoke(SESSION_V2_CHANNELS.models) as Promise<SessionV2BridgeModelEntry[]>;
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke(SESSION_V2_CHANNELS.openExternal, url) as Promise<void>;
  },
  onEvent(listener: (payload: SessionV2BridgeEventPayload) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (isEventPayload(payload)) listener(payload);
    };
    ipcRenderer.on(SESSION_V2_CHANNELS.event, handler);
    return () => {
      ipcRenderer.removeListener(SESSION_V2_CHANNELS.event, handler);
    };
  },
};

/** Expose `window.sessionV2`. Called once by the shell preload entry. */
export function exposeSessionV2(): void {
  contextBridge.exposeInMainWorld('sessionV2', bridge);
}
