// ── Entity preload ───────────────────────────────────────────────────
// Narrow preload: receives fixed entity state and exposes sender-owned open,
// drag, and mouse-passthrough operations. No renderer-supplied graph id.
// No query, list, graph selection or control methods.

import { contextBridge, ipcRenderer } from 'electron';

export interface EntityStatePayload {
  id: string;
  state: string;
  stale: boolean;
  exiting: boolean;
  terminal?: 'done' | 'cancelled';
  terminal_reason?: 'success' | 'node_failed' | 'cancelled';
  error_paused?: boolean;
  /** Normalized graph title; the renderer falls back to 未命名任务图. */
  title?: string;
  /** Revision-safe task completion counts for the avatar fact slip. */
  nodeCounts?: { done: number; total: number };
  placement?: EntityPlacementPayload;
}

export interface EntityPlacementPayload {
  bird_x: number;
  bird_y: number;
  tip_side: 'above' | 'below';
}

const entityApi = {
  openSelf: (): Promise<void> => ipcRenderer.invoke('entity:open-self'),

  entityDragStart: (): void => ipcRenderer.send('entity:drag-start'),
  entityDragMove: (): void => ipcRenderer.send('entity:drag-move'),
  entityDragEnd: (): void => ipcRenderer.send('entity:drag-end'),

  setMousePassthrough: (passthrough: boolean): Promise<void> =>
    ipcRenderer.invoke('entity:set-mouse-passthrough', passthrough),

  getState: (): Promise<EntityStatePayload | null> =>
    ipcRenderer.invoke('entity:get-state'),

  onEntityState: (cb: (data: EntityStatePayload) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      cb(data as EntityStatePayload);
    ipcRenderer.on('entity:state', handler);
    return () => {
      ipcRenderer.removeListener('entity:state', handler);
    };
  },

  onEntityPlacement: (cb: (data: EntityPlacementPayload) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      cb(data as EntityPlacementPayload);
    ipcRenderer.on('entity:placement', handler);
    return () => {
      ipcRenderer.removeListener('entity:placement', handler);
    };
  },
};

contextBridge.exposeInMainWorld('entityApi', entityApi);
