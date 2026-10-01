// ── Pet appearance preload ───────────────────────────────────────────
// Exposes the narrow `window.petAppearance` bridge over the existing shell
// appearance channels. There is no new IPC endpoint: the initial snapshot is
// read through the shell's appearanceSnapshot handler and live changes arrive
// on appearanceChanged, which the main-process appearance registry pushes to
// every registered Pet window.

import { contextBridge, ipcRenderer } from 'electron';
import { SHELL_CHANNELS, type ResolvedAppearance } from '../../../shell-contract.js';
import type { PetAppearanceApi, PetAppearanceSnapshot } from '../../shared/appearance';

function toSnapshot(appearance: ResolvedAppearance): PetAppearanceSnapshot {
  return {
    theme: appearance.theme,
    dark: appearance.dark,
    reduceMotion: appearance.reduceMotion,
  };
}

const petAppearanceApi: PetAppearanceApi = {
  getSnapshot: async (): Promise<PetAppearanceSnapshot> =>
    toSnapshot((await ipcRenderer.invoke(SHELL_CHANNELS.appearanceSnapshot)) as ResolvedAppearance),
  onChanged: (listener: (next: PetAppearanceSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, appearance: ResolvedAppearance): void => {
      listener(toSnapshot(appearance));
    };
    ipcRenderer.on(SHELL_CHANNELS.appearanceChanged, handler);
    return () => {
      ipcRenderer.removeListener(SHELL_CHANNELS.appearanceChanged, handler);
    };
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(SHELL_CHANNELS.openExternal, url),
};

/** Expose the shared Pet appearance bridge on `window.petAppearance`. */
export function exposePetAppearance(): void {
  contextBridge.exposeInMainWorld('petAppearance', petAppearanceApi);
}
