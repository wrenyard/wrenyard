import { contextBridge, ipcRenderer } from 'electron';
import { HouseRendererState, RendererConfig, WorkerRendererState } from '../shared/entities';
import { SiteSnapshot } from '../shared/snapshot';
import type { PetApi } from '../overlay/api/pet-api';

const settingsPanelApi = {
  load: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('settings:load'),
  save: (partial: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('settings:save', partial),
  saveAndRestart: (): Promise<void> => ipcRenderer.invoke('settings:save-and-restart'),
};

const statsPanelApi = {
  load: (): Promise<unknown> => ipcRenderer.invoke('stats:load'),
  onData: (cb: (data: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('stats:data', handler);
    return () => {
      ipcRenderer.removeListener('stats:data', handler);
    };
  },
};

const panelClose = (): void => {
  ipcRenderer.send('panel:close');
};

const petApi: PetApi = {
  onSnapshot: (cb: (snap: SiteSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snap: SiteSnapshot) => cb(snap);
    ipcRenderer.on('site:snapshot', handler);
    return () => {
      ipcRenderer.removeListener('site:snapshot', handler);
    };
  },
  onHouseUpdate: (cb: (state: HouseRendererState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: HouseRendererState) => cb(state);
    ipcRenderer.on('house:update', handler);
    return () => {
      ipcRenderer.removeListener('house:update', handler);
    };
  },
  onWorkerUpdate: (cb: (state: WorkerRendererState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkerRendererState) => cb(state);
    ipcRenderer.on('worker:update', handler);
    return () => {
      ipcRenderer.removeListener('worker:update', handler);
    };
  },
  getConfig: (): Promise<RendererConfig> => {
    return ipcRenderer.invoke('get-config');
  },
  setHouseMousePassthrough: (passthrough: boolean) => {
    ipcRenderer.sendSync('house:mouse-passthrough', passthrough);
  },
  getHouseCursorPoint: (): Promise<{ x: number; y: number; inside: boolean } | null> => {
    return ipcRenderer.invoke('house:get-cursor-point');
  },
  houseDragStart: () => {
    ipcRenderer.send('house:drag-start');
  },
  houseDragMove: () => {
    ipcRenderer.send('house:drag-move');
  },
  houseDragEnd: () => {
    ipcRenderer.send('house:drag-end');
  },
  dismissBroadcast: (id?: string) => {
    ipcRenderer.send('house:broadcast-dismiss', id);
  },
  setWorkerMousePassthrough: (id: string, passthrough: boolean) => {
    ipcRenderer.send('worker:mouse-passthrough', id, passthrough);
  },
  workerDragStart: (id: string) => {
    ipcRenderer.send('worker:drag-start', id);
  },
  workerDragMove: (id: string) => {
    ipcRenderer.send('worker:drag-move', id);
  },
  workerDragEnd: (id: string) => {
    ipcRenderer.send('worker:drag-end', id);
  },
  openSettings: (): Promise<void> => ipcRenderer.invoke('house:open-settings'),
  openStats: (): Promise<void> => ipcRenderer.invoke('house:open-stats'),
};

contextBridge.exposeInMainWorld('petApi', petApi);
contextBridge.exposeInMainWorld('settingsPanelApi', settingsPanelApi);
contextBridge.exposeInMainWorld('statsPanelApi', { ...statsPanelApi, close: panelClose });
contextBridge.exposeInMainWorld('panelClose', panelClose);
