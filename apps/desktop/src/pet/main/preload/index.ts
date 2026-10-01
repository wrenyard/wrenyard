import { contextBridge, ipcRenderer } from 'electron';
import { HouseRendererState, RendererConfig, WorkerRendererState } from '../../shared/entities';
import { SiteSnapshot } from '../../shared/snapshot';
import type { PetApi } from '../../overlay/api/pet-api';
import { exposePetAppearance } from './appearance';

// ── Cold-start buffers ───────────────────────────────────────────────
// Main can push the initial house/worker state before the React overlay effect
// subscribes (and again after a renderer reload). Remember the latest value from
// module load and replay it to the first subscriber so the first frame is not
// blank. The shared listener is torn down when the last subscriber leaves,
// preserving the existing unsubscribe contract.

const houseSubscribers = new Set<(state: HouseRendererState) => void>();
let latestHouseState: HouseRendererState | undefined;
let hasHouseState = false;
let houseHandler: ((event: Electron.IpcRendererEvent, state: HouseRendererState) => void) | undefined;

function ensureHouseHandler(): (event: Electron.IpcRendererEvent, state: HouseRendererState) => void {
  if (houseHandler) return houseHandler;
  const handler = (_event: Electron.IpcRendererEvent, state: HouseRendererState): void => {
    latestHouseState = state;
    hasHouseState = true;
    for (const listener of [...houseSubscribers]) listener(state);
  };
  ipcRenderer.on('house:update', handler);
  houseHandler = handler;
  return handler;
}

const workerSubscribers = new Set<(state: WorkerRendererState) => void>();
let latestWorkerState: WorkerRendererState | undefined;
let hasWorkerState = false;
let workerHandler: ((event: Electron.IpcRendererEvent, state: WorkerRendererState) => void) | undefined;

function ensureWorkerHandler(): (event: Electron.IpcRendererEvent, state: WorkerRendererState) => void {
  if (workerHandler) return workerHandler;
  const handler = (_event: Electron.IpcRendererEvent, state: WorkerRendererState): void => {
    latestWorkerState = state;
    hasWorkerState = true;
    for (const listener of [...workerSubscribers]) listener(state);
  };
  ipcRenderer.on('worker:update', handler);
  workerHandler = handler;
  return handler;
}

// Bind both channels now, at preload module load, so the first main push is
// buffered even if it lands before any React effect subscribes.
ensureHouseHandler();
ensureWorkerHandler();

const petApi: PetApi = {
  onSnapshot: (cb: (snap: SiteSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snap: SiteSnapshot) => cb(snap);
    ipcRenderer.on('site:snapshot', handler);
    return () => {
      ipcRenderer.removeListener('site:snapshot', handler);
    };
  },
  onHouseUpdate: (cb: (state: HouseRendererState) => void) => {
    houseSubscribers.add(cb);
    const handler = ensureHouseHandler();
    if (hasHouseState) cb(latestHouseState as HouseRendererState);
    return () => {
      houseSubscribers.delete(cb);
      if (houseSubscribers.size === 0 && houseHandler === handler) {
        ipcRenderer.removeListener('house:update', handler);
        houseHandler = undefined;
      }
    };
  },
  onWorkerUpdate: (cb: (state: WorkerRendererState) => void) => {
    workerSubscribers.add(cb);
    const handler = ensureWorkerHandler();
    if (hasWorkerState) cb(latestWorkerState as WorkerRendererState);
    return () => {
      workerSubscribers.delete(cb);
      if (workerSubscribers.size === 0 && workerHandler === handler) {
        ipcRenderer.removeListener('worker:update', handler);
        workerHandler = undefined;
      }
    };
  },
  getConfig: (): Promise<RendererConfig> => {
    return ipcRenderer.invoke('pet:get-config');
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
};

contextBridge.exposeInMainWorld('petApi', petApi);
exposePetAppearance();
