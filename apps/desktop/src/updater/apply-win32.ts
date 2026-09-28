/**
 * Windows applier: reuse the electron-builder NSIS installer for updates.
 *
 * Replacing the install directory directly would desync the Uninstall
 * registry entry, the recorded version and the PATH opt-in, so the update
 * re-runs the same NSIS setup.exe that a fresh install uses.
 */

import type { PlatformApplier, PreparedUpdate, SpawnDetached, UpdateBlocker } from './types.js';

export interface Win32ApplierOptions {
  spawnDetached: SpawnDetached;
}

export function createWin32Applier(options: Win32ApplierOptions): PlatformApplier {
  return {
    // Install scope is fixed to the current user, so nothing can block.
    async preflight(): Promise<UpdateBlocker | null> {
      return null;
    },

    async prepare(assetPath: string, version: string): Promise<PreparedUpdate> {
      return { assetPath, version };
    },

    apply(prepared: PreparedUpdate): void {
      // Assisted NSIS installer. `/S` is silent; `--updated` marks the run as an
      // update (the relaunched app receives `--updated`); `--force-run` makes a
      // silent run still start the app again (electron-builder NsisTarget /
      // installSection.nsh: `${if} ${isForceRun} ${andIf} ${Silent}`).
      options.spawnDetached(prepared.assetPath, ['/S', '--updated', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    },

    // NSIS owns the relaunch and registry bookkeeping; no Desktop-side cleanup.
    async finalize(): Promise<void> {
      // Intentionally empty.
    },
  };
}
