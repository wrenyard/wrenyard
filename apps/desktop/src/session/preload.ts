/**
 * Renderer-facing session bridge.
 *
 * This module is bundled into the shell preload (sandboxed, context-isolated)
 * and intentionally imports nothing but Electron: the channel names live here
 * as the single source of truth and are imported by `ipc.ts` on the main side.
 * The renderer only ever sees the frozen `window.wrenyardSession` facade below.
 */

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
  SessionContextInspectParams,
  SessionInterruptParams,
  SessionMediaReadParams,
  SessionModelEntry,
  SessionPromptCancelParams,
  SessionPromptSuggestParams,
  SessionPromptSuggestResult,
  SessionRoutesPreviewParams,
  SessionRoutesPreviewRole,
  SessionRoutesPreviewResult,
  SessionSendParams,
} from '@wrenyard/protocol';
import type {
  AttachmentInput,
  ContextInspection,
  LedgerEvent,
  LiveCall,
  SessionFile,
  SessionSummary,
} from '@wrenyard/session';
import type { DesktopTaskBrief } from '../shell-contract.js';
import type { SafeTaskRunEventsResult } from '../pet/shared/taskgraph.js';
import type { SessionSeenState } from './seen-store.js';

export type { ContextInspection, LiveCall };
export type { AttachmentInput, SessionFile };
export type { SessionRoutesPreviewParams, SessionRoutesPreviewRole, SessionRoutesPreviewResult };
export type { SessionPromptSuggestParams, SessionPromptSuggestResult, SessionPromptCancelParams };
export type { SessionSeenState };

/** Exact main↔renderer channels of the session surface. */
export const SESSION_CHANNELS = {
  /** Renderer → main: the session list. */
  list: 'session:list',
  /** Renderer → main: create a session. */
  create: 'session:create',
  /** Renderer → main: read a session's full ledger (also subscribes the caller). */
  ledger: 'session:ledger',
  /** Renderer → main: read a ledger snapshot without starting or replacing a live subscription. */
  ledgerSnapshot: 'session:ledger-snapshot',
  /** Renderer → main: `{ sessionId, text, model }`. */
  send: 'session:send',
  /** Renderer → main: `{ sessionId, turn }`. */
  interrupt: 'session:interrupt',
  /** Renderer → main: a task run id, forwarded to `task.run.cancel`. */
  cancelTask: 'session:cancel-task',
  /** Renderer → main: the gateway model list. */
  models: 'session:models',
  /** Renderer → main: `{ sessionId?, model }`, forwarded to `session.context.inspect`. */
  context: 'session:context',
  /** Renderer → main: `{ sessionId? }`, forwarded to `session.routes.preview`. */
  routesPreview: 'session:routes-preview',
  /** Renderer → main: `{ sessionId, requestId }`, forwarded to `session.prompt.suggest`. */
  promptSuggest: 'session:prompt-suggest',
  /** Renderer → main: `{ sessionId, requestId }`, forwarded to `session.prompt.cancel`. */
  promptCancel: 'session:prompt-cancel',
  /** Renderer → main: `string[]` of task run ids, resolved to briefs. */
  tasks: 'session:tasks',
  /** Renderer → main: `{ taskRunId, afterSeq? }`, one safe task-run event page. */
  taskRunEvents: 'session:task-run-events',
  /** Renderer → main: `{ sessionId, path }`, forwarded to `session.media.read`. */
  mediaRead: 'session:media-read',
  /** Renderer → main: `{ sessionId, path }`, ledger-validated then revealed in the file manager. */
  mediaReveal: 'session:media-reveal',
  /** Renderer → main: `{ sessionId, path }`; the original image as a data URL (the preview when remote). */
  mediaOriginal: 'session:media-original',
  /** Renderer → main: `{ sessionId, path }`, opened with the default app (local only). */
  mediaOpen: 'session:media-open',
  /** Renderer → main: `{ sessionId, path }`, the image copied to the clipboard. */
  mediaCopy: 'session:media-copy',
  /** Renderer → main: `sessionId`, forwarded to `session.delete`. */
  delete: 'session:delete',
  /** Renderer → main: `{ sessionId, title }`, forwarded to `session.rename`. */
  rename: 'session:rename',
  /** Renderer → main: `sessionId`, forwarded to `session.title.regenerate`; resolves with the title. */
  regenerateTitle: 'session:regenerate-title',
  /** Renderer → main: `{ sessionId, archived?, pinned? }`, forwarded to `session.updateMetadata`. */
  updateMetadata: 'session:update-metadata',
  /** Renderer → main: open the native multi-file picker, returning drafts. */
  mediaPick: 'session:media-pick',
  /** Renderer → main: describe dropped filesystem paths as drafts. */
  mediaDescribe: 'session:media-describe',
  /** Renderer → main: stage a pasted clipboard image as a draft. */
  mediaStageClipboard: 'session:media-stage-clipboard',
  /** Renderer → main: clean up only the staged clipboard drafts passed in. */
  mediaDiscard: 'session:media-discard',
  /** Renderer → main: `sessionId` to mark seen; the caller is trusted-gated. */
  seen: 'session:seen',
  /** Renderer → main: read the shared seen snapshot. */
  seenState: 'session:seen-state',
  /** Main → renderer: the updated seen snapshot, broadcast to every trusted window. */
  seenChanged: 'session:seen-changed',
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
export type SessionBridgeContextInspectRequest = SessionContextInspectParams;

/** Params of the read-only route preview (`session.routes.preview`). */
export type SessionBridgeRoutesPreviewRequest = SessionRoutesPreviewParams;

/** Params of `session.send`; the bridge forwards the request untouched. */
export type SessionBridgeSendRequest = SessionSendParams;

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

export type SessionBridgeMediaRequest = SessionMediaReadParams;

export interface SessionMediaReadResult {
  /** Present for images; absent when the daemon only authorizes the path. */
  dataUrl?: string;
  mime?: string;
  path?: string;
}

export type SessionBridgeInterruptRequest = SessionInterruptParams;

export interface SessionBridgeEventPayload {
  sessionId: string;
  event: LedgerEvent;
}

/**
 * One task-run brief, keyed by the run id the renderer already knows. Reuses the
 * shared {@link DesktopTaskBrief} shape so the bridge, the main-process
 * projection and the renderer metrics panel never drift; the full per-run usage
 * rides along when the daemon returned one.
 */
export type SessionBridgeTaskBrief = DesktopTaskBrief;

/** One safe task-run transcript page; the shared pet/main allowlist shape. */
export type SessionBridgeTaskRunEvents = SafeTaskRunEventsResult;

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
   * Read a session's ledger. The caller is subscribed to that session before
   * the snapshot is returned, so no event can be missed; later events arrive
   * through {@link SessionBridge.onEvent}. With `afterSeq` the read starts
   * after that sequence, so a caller holding a cached tail only receives the
   * delta.
   */
  ledger(sessionId: string, afterSeq?: number): Promise<LedgerEvent[]>;
  /** Read a complete ledger snapshot without changing the caller's live subscription. */
  ledgerSnapshot(sessionId: string): Promise<LedgerEvent[]>;
  /** Send one user message; resolves with the allocated turn number. */
  send(request: SessionBridgeSendRequest): Promise<{ turn: number }>;
  /** Read one ledger-known media file (image data URL; nonimages authorize only). */
  mediaRead(request: SessionBridgeMediaRequest): Promise<SessionMediaReadResult>;
  /** Reveal one ledger-known media file in the OS file manager. */
  revealMedia(request: SessionBridgeMediaRequest): Promise<void>;
  /** The original image as a data URL; the preview when the daemon is remote. */
  readOriginalMedia(request: SessionBridgeMediaRequest): Promise<string | undefined>;
  /** Open one session file with the system's default app (local only). */
  openMedia(request: SessionBridgeMediaRequest): Promise<void>;
  /** Copy one session image to the clipboard. */
  copyMedia(request: SessionBridgeMediaRequest): Promise<void>;
  /** Delete one session, clearing it from the daemon list. */
  deleteSession(sessionId: string): Promise<void>;
  /** Rename one session with a manual title; the new title is persisted. */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Generate a new title on request and save it as the manual title. */
  regenerateTitle(sessionId: string): Promise<string>;
  /**
   * Change one session's archived / pinned list flags; an omitted field keeps
   * its prior value.
   */
  updateMetadata(sessionId: string, patch: { archived?: boolean; pinned?: boolean }): Promise<void>;
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
  /** Cancel one dispatched task run. */
  cancelTask(taskRunId: string): Promise<void>;
  /** The live gateway models the reason-model picker may offer. */
  models(): Promise<SessionBridgeModelEntry[]>;
  /**
   * Read-only inspection of the next main reasoning view for a session and the
   * currently selected model. Omit `sessionId` for a new session.
   */
  contextInspect(request: SessionBridgeContextInspectRequest): Promise<ContextInspection>;
  /**
   * Read-only preview of each auxiliary role's rank-1 route (model, effort,
   * display name and window). Never calls a model.
   */
  routesPreview(request?: SessionBridgeRoutesPreviewRequest): Promise<SessionRoutesPreviewResult>;
  /**
   * Request one next-input suggestion for a session. The daemon reads the
   * conversation from the session itself; only the request id crosses the wire,
   * so a late result can be matched to its request and dropped.
   */
  promptSuggest(request: SessionPromptSuggestParams): Promise<SessionPromptSuggestResult>;
  /** Cancel one in-flight suggestion request by the id it was requested with. */
  promptCancel(request: SessionPromptCancelParams): Promise<void>;
  /** Resolve task-run briefs for the given run ids (per-id failures are `unavailable`). */
  tasks(taskRunIds: string[]): Promise<SessionBridgeTaskBrief[]>;
  /**
   * Read one page of a task run's safe transcript events (the
   * SafeTranscriptEventData allowlist) plus the authoritative run facts, for
   * the in-shell activity-panel preview. `afterSeq` continues the stream.
   */
  taskRunEvents(taskRunId: string, afterSeq?: number): Promise<SessionBridgeTaskRunEvents>;
  /** Subscribe to pushed ledger events; the returned function unsubscribes. */
  onEvent(listener: (payload: SessionBridgeEventPayload) => void): () => void;
  /** Subscribe to live streaming snapshots; the returned function unsubscribes. */
  onLive(listener: (payload: SessionBridgeLivePayload) => void): () => void;
  /** Mark one session as seen now; the shared snapshot is pushed to every window. */
  markSeen(sessionId: string): Promise<void>;
  /** Read the shared seen snapshot (baseline plus per-session last-seen times). */
  getSeen(): Promise<SessionSeenState>;
  /** Subscribe to the shared seen snapshot; the returned function unsubscribes. */
  onSeenChanged(listener: (state: SessionSeenState) => void): () => void;
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
    && typeof value.spanId === 'string'
    && typeof value.text === 'string'
    && typeof value.reasoning === 'string';
}

function isLivePayload(value: unknown): value is SessionBridgeLivePayload {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && Array.isArray(value.live)
    && value.live.every(isLiveCall);
}

function isSeenState(value: unknown): value is SessionSeenState {
  return isRecord(value)
    && typeof value.baselineAt === 'string'
    && isRecord(value.seen);
}

const bridge: SessionBridge = {
  list(): Promise<SessionSummary[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.list) as Promise<SessionSummary[]>;
  },
  create(): Promise<{ sessionId: string }> {
    return ipcRenderer.invoke(SESSION_CHANNELS.create) as Promise<{ sessionId: string }>;
  },
  ledger(sessionId: string, afterSeq?: number): Promise<LedgerEvent[]> {
    // Keep the bare-id payload when no cursor is given so existing callers
    // stay on the original wire shape.
    return ipcRenderer.invoke(
      SESSION_CHANNELS.ledger,
      afterSeq === undefined ? sessionId : { sessionId, afterSeq },
    ) as Promise<LedgerEvent[]>;
  },
  ledgerSnapshot(sessionId: string): Promise<LedgerEvent[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.ledgerSnapshot, sessionId) as Promise<LedgerEvent[]>;
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
  readOriginalMedia(request: SessionBridgeMediaRequest): Promise<string | undefined> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaOriginal, request) as Promise<string | undefined>;
  },
  openMedia(request: SessionBridgeMediaRequest): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaOpen, request) as Promise<void>;
  },
  copyMedia(request: SessionBridgeMediaRequest): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.mediaCopy, request) as Promise<void>;
  },
  deleteSession(sessionId: string): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.delete, sessionId) as Promise<void>;
  },
  renameSession(sessionId: string, title: string): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.rename, { sessionId, title }) as Promise<void>;
  },
  regenerateTitle(sessionId: string): Promise<string> {
    return ipcRenderer.invoke(SESSION_CHANNELS.regenerateTitle, sessionId) as Promise<string>;
  },
  updateMetadata(sessionId: string, patch: { archived?: boolean; pinned?: boolean }): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.updateMetadata, { sessionId, ...patch }) as Promise<void>;
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
  cancelTask(taskRunId: string): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.cancelTask, taskRunId) as Promise<void>;
  },
  models(): Promise<SessionBridgeModelEntry[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.models) as Promise<SessionBridgeModelEntry[]>;
  },
  contextInspect(request: SessionBridgeContextInspectRequest): Promise<ContextInspection> {
    return ipcRenderer.invoke(SESSION_CHANNELS.context, request) as Promise<ContextInspection>;
  },
  routesPreview(request: SessionBridgeRoutesPreviewRequest = {}): Promise<SessionRoutesPreviewResult> {
    return ipcRenderer.invoke(SESSION_CHANNELS.routesPreview, request) as Promise<SessionRoutesPreviewResult>;
  },
  promptSuggest(request: SessionPromptSuggestParams): Promise<SessionPromptSuggestResult> {
    return ipcRenderer.invoke(SESSION_CHANNELS.promptSuggest, request) as Promise<SessionPromptSuggestResult>;
  },
  promptCancel(request: SessionPromptCancelParams): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.promptCancel, request) as Promise<void>;
  },
  tasks(taskRunIds: string[]): Promise<SessionBridgeTaskBrief[]> {
    return ipcRenderer.invoke(SESSION_CHANNELS.tasks, taskRunIds) as Promise<SessionBridgeTaskBrief[]>;
  },
  taskRunEvents(taskRunId: string, afterSeq?: number): Promise<SessionBridgeTaskRunEvents> {
    return ipcRenderer.invoke(
      SESSION_CHANNELS.taskRunEvents,
      afterSeq === undefined ? { taskRunId } : { taskRunId, afterSeq },
    ) as Promise<SessionBridgeTaskRunEvents>;
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
  markSeen(sessionId: string): Promise<void> {
    return ipcRenderer.invoke(SESSION_CHANNELS.seen, sessionId) as Promise<void>;
  },
  getSeen(): Promise<SessionSeenState> {
    return ipcRenderer.invoke(SESSION_CHANNELS.seenState) as Promise<SessionSeenState>;
  },
  onSeenChanged(listener: (state: SessionSeenState) => void): () => void {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      if (isSeenState(state)) listener(state);
    };
    ipcRenderer.on(SESSION_CHANNELS.seenChanged, handler);
    return () => {
      ipcRenderer.removeListener(SESSION_CHANNELS.seenChanged, handler);
    };
  },
};

/** Expose `window.wrenyardSession`. Called once by the shell preload entry. */
export function exposeSession(): void {
  contextBridge.exposeInMainWorld('wrenyardSession', bridge);
}
