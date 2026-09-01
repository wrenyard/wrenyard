/**
 * macOS exposes one Dock identity for the whole Electron application rather
 * than one taskbar entry per BrowserWindow. Marking a Pet overlay as skipped
 * there hides the Desktop host as well, so only Windows/Linux overlays opt out
 * of their taskbar.
 */
export function overlaySkipsTaskbar(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'darwin';
}

export interface OverlayWorkspaceVisibilityOptions {
  visibleOnFullScreen: true;
  skipTransformProcessType?: true;
}

/**
 * Electron transforms the whole macOS process into a UIElement application by
 * default when a window opts into all-workspace/fullscreen visibility. Pet
 * overlays must not change the Desktop host's regular application identity.
 */
export function overlayWorkspaceVisibilityOptions(
  platform: NodeJS.Platform = process.platform,
): OverlayWorkspaceVisibilityOptions {
  return platform === 'darwin'
    ? { visibleOnFullScreen: true, skipTransformProcessType: true }
    : { visibleOnFullScreen: true };
}
