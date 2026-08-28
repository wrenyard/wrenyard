/**
 * macOS exposes one Dock identity for the whole Electron application rather
 * than one taskbar entry per BrowserWindow. Marking a Pet overlay as skipped
 * there hides the Desktop host as well, so only Windows/Linux overlays opt out
 * of their taskbar.
 */
export function overlaySkipsTaskbar(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'darwin';
}
