// ── Graph Slip preload ────────────────────────────────────────────────
// Narrow preload: receives bound slip snapshot/loading/error/stale/terminal
// state and exposes openTranscript(nodeId, taskRunId) only.
// It must not accept or expose a graph id, list, refresh, selection, query
// or mutation method.

import { contextBridge, ipcRenderer } from 'electron';
import { exposePetAppearance } from './appearance';
import { latestPush } from './push';

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

// Buffer the initial push so a snapshot/error sent before the panel effect
// subscribes is replayed instead of lost. A fresh snapshot invalidates a
// previously buffered error, matching the panel's "snapshot clears error"
// contract without a new endpoint.
const slipErrorPush = latestPush<unknown>('slip:error');
const slipSnapshotPush = latestPush<GraphSlipDto>('slip:snapshot', () => {
  slipErrorPush.reset();
});

const graphSlipApi = {
  onSnapshot: (cb: (data: GraphSlipDto) => void): (() => void) =>
    slipSnapshotPush.subscribe((data) => cb(data)),

  onError: (cb: (message: string) => void): (() => void) =>
    slipErrorPush.subscribe((message) => cb(typeof message === 'string' ? message : 'Unknown error')),

  openTranscript: (nodeId: string, taskRunId: string): Promise<void> =>
    ipcRenderer.invoke('slip:open-transcript', nodeId, taskRunId),

  reportContentSize: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('slip:report-content-size', width, height),

  close: (): Promise<void> =>
    ipcRenderer.invoke('slip:close'),
};

contextBridge.exposeInMainWorld('graphSlipApi', graphSlipApi);
exposePetAppearance();
