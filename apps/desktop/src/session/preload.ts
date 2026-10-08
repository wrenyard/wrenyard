/**
 * Renderer-facing session bridge.
 *
 * This module is bundled into the shell preload (sandboxed, context-isolated)
 * and intentionally imports nothing but Electron: the channel names live here
 * as the single source of truth and are imported by `ipc.ts` on the main side.
 * The renderer only ever sees the frozen `window.wrenyardSession` facade below.
 */

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { ReasoningEffort } from '@wrenyard/models';
import type { SessionModelEntry } from '@wrenyard/protocol';
import type {
  AttachmentInput,
  ContextInspection,
  LedgerEvent,
  LiveCall,
  SessionFile,
  SessionSummary,
} from '@wrenyard/session';

export type { ContextInspection, LiveCall };
export type { AttachmentInput, SessionFile };

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
  /** Renderer → main: `{ sessionId?, model }`, forwarded to `session.context.inspect`. */
  context: 'session:context',
  /** Renderer → main: `string[]` of task run ids, resolved to briefs. */
  tasks: 'session:tasks',
  /** Renderer → main: `{ sessionId, path }`, forwarded to `session.media.read`. */
  mediaRead: 'session:media-read',
  /** Renderer → main: `{ sessionId, path }`, ledger-validated then revealed in the file manager. */
  mediaReveal: 'session:media-reveal',
  /** Renderer → main: `sessionId`, forwarded to `session.delete`. */
  delete: 'session:delete',
  /** Renderer → main: open the native multi-file picker, returning drafts. */
  mediaPick: 'session:media-pick',
  /** Renderer → main: describe dropped filesystem paths as drafts. */
  mediaDescribe: 'session:media-describe',
  /** Renderer → main: stage a pasted clipboard image as a draft. */
  mediaStageClipboard: 'session:media-stage-clipboard',
  /** Renderer → main: clean up only the staged clipboard drafts passed in. */
  mediaDiscard: 'session:media-discard',
  /** Main → renderer: `{ sessionId, event }` for the subscribed session. */
  event: 'session:event',
  /** Main → renderer: `{ sessionId, live }` streaming snapshot changes. */
  live: 'session:live',
} as const;

/**
 * One selectable model row. Reuses the shared {@link SessionModelEntry} DTO so
 * the bridge and the protocol never drift: the existing fields are preserved
 * and the supply metadata (runtime, provider label, badges, quota facts) is
 * carried verbatim.
 */
export type SessionBridgeModelEntry = SessionModelEntry;

/** Params of the read-only context inspection (`session.context.inspect`). */
export interface SessionBridgeContextInspectRequest {
  /** Omitted means a new session: resident layers plus the workspace snapshot. */
  sessionId?: string;
  /** Gateway public id the input box currently has selected. */
  model: string;
}

export interface SessionBridgeSendRequest {
  sessionId: string;
  text: string;
  /** A send always carries the selected public reasoning effort. */
  model: { provider: string; model: string; reasoningEffort: ReasoningEffort };
  /** Local attachment inputs forwarded untouched to the daemon. */
  attachments?: AttachmentInput[];
}

/**
 * A composer attachment before or alongside a send. Extends the daemon
 * {@link AttachmentInput} with renderer-facing facts; `path` is always
 * preferred so the renderer never needs filesystem access.
 */
export interface DraftAttachment extends AttachmentInput {
  /**
   * Local optimistic/staging identity for this renderer draft; it is never a
   * ledger session-file id (session files are keyed by `path` + `hash`).
   */
  id: string;
  name: string;
  bytes: number;
  mime?: string;
  /** Bounded thumbnail data URL, never persisted to the ledger. */
  preview?: string;
  /** Set when main owns the file (clipboard staging) and may delete it. */
  staged?: boolean;
}

export interface SessionBridgeMediaRequest {
  sessionId: string;
  path: string;
}

export interface SessionMediaReadResult {
  /** Present for images; absent when the daemon only authorizes the path. */
  dataUrl?: string;
  mime?: string;
  path?: string;
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
  /** Read one ledger-known media file (image data URL; nonimages authorize only). */
  mediaRead(request: SessionBridgeMediaRequest): Promise<SessionMediaReadResult>;
  /** Reveal one ledger-known media file in the OS file manager. */
  revealMedia(request: SessionBridgeMediaRequest): Promise<void>;
  /** Delete one session, clearing it from the daemon list. */
  deleteSession(sessionId: string): Promise<void>;
  /** Open the native multi-file picker; returns the selected files as drafts. */
  selectAttachments(): Promise<DraftAttachment[]>;
  /** Describe already-known filesystem paths (drag-and-drop) as drafts. */
  describeAttachments(paths: string[]): Promise<DraftAttachment[]>;
  /** Persist a pasted clipboard image and return it as a staged draft. */
  stageClipboardImage(input: { dataUrl: string; name?: string }): Promise<DraftAttachment>;
  /** Delete only the staged clipboard drafts passed in; source files are never touched. */
  discardDraftAttachments(attachments: readonly DraftAttachment[]): Promise<void>;
  /** Absolute filesystem path of a dropped `File`, via Electron `webUtils`. */
  pathForFile(file: File): string;
  /** Interrupt one running turn. */
  interrupt(request: SessionBridgeInterruptRequest): Promise<void>;
  /** The live gateway models the reason-model picker may offer. */
  models(): Promise<SessionBridgeModelEntry[]>;
  /**
   * Read-only inspection of the next main reasoning view for a session and the
   * currently selected model. Omit `sessionId` for a new session.
   */
  contextInspect(request: SessionBridgeContextInspectRequest): Promise<ContextInspection>;
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
  mediaRead(request: SessionBridgeMediaRequest): Promise<SessionMediaReadResult> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaRead, request) as Promise<SessionMediaReadResult>;
  },
  revealMedia(request: SessionBridgeMediaRequest): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaReveal, request) as Promise<void>;
  },
  deleteSession(sessionId: string): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.delete, sessionId) as Promise<void>;
  },
  selectAttachments(): Promise<DraftAttachment[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaPick) as Promise<DraftAttachment[]>;
  },
  describeAttachments(paths: string[]): Promise<DraftAttachment[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaDescribe, paths) as Promise<DraftAttachment[]>;
  },
  stageClipboardImage(input: { dataUrl: string; name?: string }): Promise<DraftAttachment> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaStageClipboard, input) as Promise<DraftAttachment>;
  },
  discardDraftAttachments(attachments: readonly DraftAttachment[]): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaDiscard, attachments) as Promise<void>;
  },
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  interrupt(request: SessionBridgeInterruptRequest): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.interrupt, request) as Promise<void>;
  },
  models(): Promise<SessionBridgeModelEntry[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.models) as Promise<SessionBridgeModelEntry[]>;
  },
  contextInspect(request: SessionBridgeContextInspectRequest): Promise<ContextInspection> {
    return ipcRenderer.invoke(SESSION_CHANNELS.context, request) as Promise<ContextInspection>;
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
