// ── Graph Slip preload ────────────────────────────────────────────────
// Narrow preload: receives bound slip snapshot/loading/error/stale/terminal
// state and exposes openTranscript(nodeId, taskRunId) only.
// It must not accept or expose a graph id, list, refresh, selection, query
// or mutation method.

import { contextBridge, ipcRenderer } from 'electron';

export interface GraphSlipDto {
  graph_id: string;
  revision: number;
  state: string;
  nodes: Record<string, {
    id: string;
    name?: string;
    action_type: string;
    deps: string[];
    state: string;
    task_run_id?: string;
    task_status?: string;
    runtime_ms?: number;
  }>;
  edges: Array<{ from: string; to: string; label: string }>;
}

const graphSlipApi = {
  onSnapshot: (cb: (data: GraphSlipDto) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      cb(data as GraphSlipDto);
    ipcRenderer.on('slip:snapshot', handler);
    return () => {
      ipcRenderer.removeListener('slip:snapshot', handler);
    };
  },

  onError: (cb: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) =>
      cb(typeof message === 'string' ? message : 'Unknown error');
    ipcRenderer.on('slip:error', handler);
    return () => {
      ipcRenderer.removeListener('slip:error', handler);
    };
  },

  openTranscript: (nodeId: string, taskRunId: string): Promise<void> =>
    ipcRenderer.invoke('slip:open-transcript', nodeId, taskRunId),

  reportContentSize: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('slip:report-content-size', width, height),

  close: (): Promise<void> =>
    ipcRenderer.invoke('slip:close'),
};

contextBridge.exposeInMainWorld('graphSlipApi', graphSlipApi);
