// ── Interface zoom ───────────────────────────────────────────────────
// Owns the persisted `appearance.zoom` preference application to the shell
// window. The zoom factor is read from the appearance controller, persisted
// through the preferences controller, and applied to the live shell window;
// every dependency is injected so this module keeps no process-global state.

import { APPEARANCE_ZOOM_MAX, APPEARANCE_ZOOM_MIN, APPEARANCE_ZOOM_STEP } from '../shell-contract.js';
import type { ShellWindowController } from '../shell-window.js';
import type { DesktopAppearanceController } from './appearance.js';
import type { DesktopPreferencesController } from './settings/preferences.js';

export interface InterfaceZoomDeps {
  getShellWindow(): ShellWindowController | null;
  getAppearanceController(): DesktopAppearanceController | null;
  getPreferencesController(): DesktopPreferencesController | null;
}

export interface InterfaceZoom {
  clampZoom(value: number): number;
  applyShellZoom(): void;
  setInterfaceZoom(value: number): void;
}

export function createInterfaceZoom(deps: InterfaceZoomDeps): InterfaceZoom {
  /** Rounds an interface zoom percentage to the allowed step and clamps its range. */
  function clampZoom(value: number): number {
    const stepped = Math.round(value / APPEARANCE_ZOOM_STEP) * APPEARANCE_ZOOM_STEP;
    return Math.min(APPEARANCE_ZOOM_MAX, Math.max(APPEARANCE_ZOOM_MIN, stepped));
  }

  /** Apply the persisted `appearance.zoom` to the shell window (100% → factor 1). */
  function applyShellZoom(): void {
    const shell = deps.getShellWindow();
    if (shell === null || shell.window.isDestroyed()) return;
    try {
      shell.window.webContents.setZoomFactor(deps.getAppearanceController()?.zoomFactor() ?? 1);
    } catch {
      // Zoom is best-effort; the window keeps its current factor.
    }
  }

  /** Set one interface-zoom percentage and persist it through the bridge. */
  function setInterfaceZoom(value: number): void {
    deps.getPreferencesController()?.set('appearance.zoom', clampZoom(value));
  }

  return { clampZoom, applyShellZoom, setInterfaceZoom };
}
