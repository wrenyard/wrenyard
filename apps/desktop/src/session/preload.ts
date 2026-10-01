/**
 * Renderer-facing session bridge.
 *
 * This module is bundled into the shell preload (sandboxed, context-isolated)
 * and intentionally imports nothing but Electron: the channel names live here
 * as the single source of truth and are imported by `ipc.ts` on the main side.
 * The renderer only ever sees the frozen `window.wrenyardSession` facade below.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LedgerEvent, LiveCall, SessionSummary } from '@wrenyard/session';

export type { LiveCall };

/** Exact main↔renderer channels of the session surface. */
export const SESSION_CHANNELS = {
  /** Renderer → main: the session list. */
  list: 'session:list',
  /** Renderer → main: create a session. */
  create: 'session:create',
  /** Renderer → main: read a session's full ledger (also subscribes the caller). */
  ledger: 'session:ledger',
  /** Renderer → main: `{ sessionId, text, model }`. */
  send: 'session:send',
  /** Renderer → main: `{ sessionId, turn }`. */
  interrupt: 'session:interrupt',
  /** Renderer → main: the gateway model list. */
  models: 'session:models',
  /** Renderer → main: `string[]` of task run ids, resolved to briefs. */
  tasks: 'session:tasks',
  /** Main → renderer: `{ sessionId, event }` for the subscribed session. */
  event: 'session:event',
  /** Main → renderer: `{ sessionId, live }` streaming snapshot changes. */
  live: 'session:live',
} as const;

/** One selectable model row: gateway public id plus its thinking levels. */
export interface SessionBridgeModelEntry {
  publicId: string;
  provider: string;
  model: string;
  displayName: string;
  thinkingLevels?: string[];
}

export interface SessionBridgeSendRequest {
  sessionId: string;
  text: string;
  model: { provider: string; model: string; reasoningEffort?: string };
}

export interface SessionBridgeInterruptRequest {
  sessionId: string;
  turn: number;
}

export interface SessionBridgeEventPayload {
  sessionId: string;
  event: LedgerEvent;
}

/**
 * One task-run brief, keyed by the run id the renderer already knows. Named
 * distinctly from the ledger's `TaskBrief` (a snapshot task definition) to
 * avoid a collision in the shared public surface.
 */
export interface SessionBridgeTaskBrief {
  taskRunId: string;
  /** `task_name`, falling back to `task_id` when the definition declares none. */
  taskName?: string;
  /** Task-run status, or `unavailable` when this id could not be resolved. */
  status: string;
  /** Resolved client/provider/model label, when a runtime was resolved. */
  runtime?: string;
  summary?: string;
  usage?: { input?: number; output?: number };
}

export interface SessionBridgeLivePayload {
  sessionId: string;
  live: LiveCall[];
}

/** The `window.wrenyardSession` facade consumed by the renderer session page. */
export interface SessionBridge {
  /** Every known session, newest first (daemon/feature order). */
  list(): Promise<SessionSummary[]>;
  /** Create a session; its workspace snapshot is frozen immediately. */
  create(): Promise<{ sessionId: string }>;
  /**
   * Read a session's complete ledger. The caller is subscribed to that session
   * before the snapshot is returned, so no event can be missed; later events
   * arrive through {@link SessionBridge.onEvent}.
   */
  ledger(sessionId: string): Promise<LedgerEvent[]>;
  /** Send one user message; resolves with the allocated turn number. */
  send(request: SessionBridgeSendRequest): Promise<{ turn: number }>;
  /** Interrupt one running turn. */
  interrupt(request: SessionBridgeInterruptRequest): Promise<void>;
  /** The live gateway models the reason-model picker may offer. */
  models(): Promise<SessionBridgeModelEntry[]>;
  /** Resolve task-run briefs for the given run ids (per-id failures are `unavailable`). */
  tasks(taskRunIds: string[]): Promise<SessionBridgeTaskBrief[]>;
  /** Subscribe to pushed ledger events; the returned function unsubscribes. */
  onEvent(listener: (payload: SessionBridgeEventPayload) => void): () => void;
  /** Subscribe to live streaming snapshots; the returned function unsubscribes. */
  onLive(listener: (payload: SessionBridgeLivePayload) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEventPayload(value: unknown): value is SessionBridgeEventPayload {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && isRecord(value.event);
}

function isLiveCall(value: unknown): value is LiveCall {
  return isRecord(value)
    && typeof value.callId === 'string'
    && typeof value.text === 'string'
    && typeof value.reasoning === 'string';
}

function isLivePayload(value: unknown): value is SessionBridgeLivePayload {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && Array.isArray(value.live)
    && value.live.every(isLiveCall);
}

const bridge: SessionBridge = {
  list(): Promise<SessionSummary[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.list) as Promise<SessionSummary[]>;
  },
  create(): Promise<{ sessionId: string }> {
    return ipcRenderer.invoke(SESSION_CHANNELS.create) as Promise<{ sessionId: string }>;
  },
  ledger(sessionId: string): Promise<LedgerEvent[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.ledger, sessionId) as Promise<LedgerEvent[]>;
  },
  send(request: SessionBridgeSendRequest): Promise<{ turn: number }> {
    return ipcRenderer.invoke(SESSION_CHANNELS.send, request) as Promise<{ turn: number }>;
  },
  interrupt(request: SessionBridgeInterruptRequest): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.interrupt, request) as Promise<void>;
  },
  models(): Promise<SessionBridgeModelEntry[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.models) as Promise<SessionBridgeModelEntry[]>;
  },
  tasks(taskRunIds: string[]): Promise<SessionBridgeTaskBrief[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.tasks, taskRunIds) as Promise<SessionBridgeTaskBrief[]>;
  },
  onEvent(listener: (payload: SessionBridgeEventPayload) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (isEventPayload(payload)) listener(payload);
    };
    ipcRenderer.on(SESSION_CHANNELS.event, handler);
    return () => {
      ipcRenderer.removeListener(SESSION_CHANNELS.event, handler);
    };
  },
  onLive(listener: (payload: SessionBridgeLivePayload) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (isLivePayload(payload)) listener(payload);
    };
    ipcRenderer.on(SESSION_CHANNELS.live, handler);
    return () => {
      ipcRenderer.removeListener(SESSION_CHANNELS.live, handler);
    };
  },
};

/** Expose `window.wrenyardSession`. Called once by the shell preload entry. */
export function exposeSession(): void {
  contextBridge.exposeInMainWorld('wrenyardSession', bridge);
}
