import { contextBridge, ipcRenderer } from 'electron';

const transcriptApi = {
  onData: (taskRunId: string, cb: (data: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(`transcript:data-${taskRunId}`, handler);
    return () => {
      ipcRenderer.removeListener(`transcript:data-${taskRunId}`, handler);
    };
  },

  onError: (cb: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) => {
      cb(typeof message === 'string' ? message : String(message));
    };
    ipcRenderer.on('transcript:error', handler);
    return () => {
      ipcRenderer.removeListener('transcript:error', handler);
    };
  },

  retry: (taskRunId: string): Promise<void> => ipcRenderer.invoke('transcript:retry', taskRunId),

  close: (): void => {
    ipcRenderer.send('panel:close');
  },
};

contextBridge.exposeInMainWorld('transcriptApi', transcriptApi);
