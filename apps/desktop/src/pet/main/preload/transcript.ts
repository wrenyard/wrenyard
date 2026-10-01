import { contextBridge, ipcRenderer } from 'electron';
import { exposePetAppearance } from './appearance';
import { latestPush, queuePush } from './push';

/**
 * Read the task_run_id the transcript window was opened with from the
 * preload's own URL. Structural access keeps this working before the React
 * root mounts (and after a reload) without a new IPC query.
 */
function readInitialTaskRunId(): string {
  const location = (globalThis as { location?: { search?: string } }).location;
  if (!location || typeof location.search !== 'string') return '';
  try {
    return new URLSearchParams(location.search).get('task_run_id') ?? '';
  } catch {
    return '';
  }
}

const initialTaskRunId = readInitialTaskRunId();
// Bind the incremental data channel at module load so the first pushed pages
// are queued for the first subscriber instead of dropping on the cold-start
// race.
const initialDataPush = initialTaskRunId.length > 0
  ? queuePush<unknown>(`transcript:data-${initialTaskRunId}`)
  : undefined;
const transcriptErrorPush = latestPush<unknown>('transcript:error');

const transcriptApi = {
  onData: (taskRunId: string, cb: (data: unknown) => void): (() => void) => {
    if (initialDataPush && taskRunId === initialTaskRunId) {
      return initialDataPush.subscribe((data) => cb(data));
    }
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(`transcript:data-${taskRunId}`, handler);
    return () => {
      ipcRenderer.removeListener(`transcript:data-${taskRunId}`, handler);
    };
  },

  onError: (cb: (message: string) => void): (() => void) =>
    transcriptErrorPush.subscribe((message) => cb(typeof message === 'string' ? message : String(message))),

  retry: (taskRunId: string): Promise<void> => ipcRenderer.invoke('transcript:retry', taskRunId),

  close: (): Promise<void> => ipcRenderer.invoke('transcript:close'),
};

contextBridge.exposeInMainWorld('transcriptApi', transcriptApi);
exposePetAppearance();
