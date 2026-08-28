export interface DesktopActivationHost {
  setActivationPolicy(policy: 'regular'): void;
  showDock?(): Promise<void> | void;
}

/** Keep the Desktop host visible in the macOS Dock even when Pet overlays exist. */
export async function ensureDesktopActivationPolicy(
  host: DesktopActivationHost,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') return;
  host.setActivationPolicy('regular');
  await host.showDock?.();
}
