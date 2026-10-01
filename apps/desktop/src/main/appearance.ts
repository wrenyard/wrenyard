import { app, BrowserWindow, nativeTheme, systemPreferences } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getTheme } from '@wrenyard/themes';
import { TITLE_BAR_HEIGHT } from '../window-chrome.js';
import type { DesktopSettingsStore } from './settings/desktop-settings.js';
import type {
  AppearanceSettings,
  ResolvedAppearance,
} from '../shell-contract.js';

export interface DesktopAppearanceControllerOptions {
  /** The single settings store; the appearance partition lives inside it. */
  store: DesktopSettingsStore;
  /** Invoked whenever the resolved appearance differs from the last push. */
  onChanged?: (appearance: ResolvedAppearance) => void;
}

function sameAppearance(a: ResolvedAppearance, b: ResolvedAppearance): boolean {
  return a.theme === b.theme && a.dark === b.dark && a.reduceMotion === b.reduceMotion;
}

/** OS "reduce motion" setting; unsupported platforms report `false`. */
function systemPrefersReducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion === true;
  } catch {
    return false;
  }
}

/**
 * Owns the shared appearance preference in the Desktop main process.
 *
 * It persists the preference partition without touching the other partitions,
 * resolves it against `nativeTheme` and the OS reduced-motion setting, applies
 * it to every window (background, Windows title bar palette, window/Dock
 * icons), and pushes the resolved value to renderers only when it changes.
 * Theme metadata comes from the shared theme package, so Desktop never keeps
 * its own color table or theme list.
 */
export class DesktopAppearanceController {
  private readonly store: DesktopSettingsStore;
  private readonly onChanged: ((appearance: ResolvedAppearance) => void) | undefined;
  private lastPushed: ResolvedAppearance | null = null;
  private initialized = false;
  private readonly handleNativeThemeUpdated = (): void => this.refresh();

  constructor(options: DesktopAppearanceControllerOptions) {
    this.store = options.store;
    this.onChanged = options.onChanged;
  }

  /** Apply the persisted preference once the app is ready. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    nativeTheme.themeSource = this.getSettings().colorMode;
    nativeTheme.on('updated', this.handleNativeThemeUpdated);
    this.refresh();
  }

  /** Detach the native theme listener during teardown. */
  dispose(): void {
    nativeTheme.removeListener('updated', this.handleNativeThemeUpdated);
  }

  getSettings(): AppearanceSettings {
    return { ...this.store.load().appearance };
  }

  /** Interface zoom as a webContents zoom factor (`100%` → `1`). */
  zoomFactor(): number {
    return this.getSettings().zoom / 100;
  }

  resolve(): ResolvedAppearance {
    const settings = this.getSettings();
    const dark = settings.colorMode === 'system' ? nativeTheme.shouldUseDarkColors : settings.colorMode === 'dark';
    const reduceMotion = settings.motion === 'reduce'
      || (settings.motion === 'system' && systemPrefersReducedMotion());
    return { theme: settings.theme, dark, reduceMotion };
  }

  /** Merge a validated partial preference, persist it, and re-resolve. */
  save(patch: Partial<AppearanceSettings>): AppearanceSettings {
    const next: AppearanceSettings = { ...this.getSettings(), ...patch };
    this.store.patch('appearance', next);
    if (nativeTheme.themeSource !== next.colorMode) nativeTheme.themeSource = next.colorMode;
    // Setting `themeSource` fires `updated` only on an actual change; refresh
    // here so a theme/motion-only change still propagates immediately.
    this.refresh();
    return next;
  }

  /** `additionalArguments` value so a preload can set the theme before React. */
  arguments(): string[] {
    const resolved = this.resolve();
    const mode = resolved.dark ? 'dark' : 'light';
    const motion = resolved.reduceMotion ? 'reduce' : 'system';
    return [`--wy-appearance=${resolved.theme}:${mode}:${motion}`];
  }

  backgroundColor(): string {
    const resolved = this.resolve();
    return getTheme(resolved.theme).modes[resolved.dark ? 'dark' : 'light'].windowBackground;
  }

  titleBarOverlay(): { color: string; symbolColor: string } {
    const resolved = this.resolve();
    return { ...getTheme(resolved.theme).modes[resolved.dark ? 'dark' : 'light'].titleBarOverlay };
  }

  /**
   * Absolute theme icon path. Packaged builds read the `resources/themes/<id>`
   * copy staged by electron-builder; a source run resolves the same file from
   * the shared theme package.
   *
   * `mac1024` is the squircle variant macOS shows verbatim, so the Dock uses
   * it; `png256` stays the plain artwork for the Windows window/taskbar.
   */
  iconPath(size: 'png1024' | 'png256' | 'mac1024'): string | undefined {
    const theme = getTheme(this.resolve().theme);
    const relative = size === 'mac1024'
      ? theme.icon.png1024.replace(/[^/]+$/, 'icon-mac-1024.png')
      : theme.icon[size];
    const file = relative.split('/').pop();
    if (!file) return undefined;
    const packaged = join(process.resourcesPath, 'themes', theme.id, 'assets', file);
    if (app.isPackaged && existsSync(packaged)) return packaged;
    const source = join(app.getAppPath(), '..', '..', 'packages', 'themes', relative);
    if (existsSync(source)) return source;
    return existsSync(packaged) ? packaged : undefined;
  }

  /** Apply the resolved appearance to one window in place. */
  applyToWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    // Preserve transparent Pet carriers; their DOM/theme migration is out of scope.
    if (window.getBackgroundColor().toLowerCase() === '#00000000') return;
    try {
      window.setBackgroundColor(this.backgroundColor());
    } catch {
      // A window can vanish between the checks; appearance is best-effort.
    }
    if (process.platform !== 'win32') return;
    try {
      window.setTitleBarOverlay({ ...this.titleBarOverlay(), height: TITLE_BAR_HEIGHT });
    } catch {
      // Frames without an overlay (e.g. a dialog) reject the call.
    }
    try {
      const icon = this.iconPath('png256');
      if (icon) window.setIcon(icon);
    } catch {
      // Ignore icon failures; the theme still applies.
    }
  }

  /** Re-resolve, push only on change, and re-apply to every live window. */
  refresh(): void {
    const resolved = this.resolve();
    if (this.lastPushed === null || !sameAppearance(this.lastPushed, resolved)) {
      this.lastPushed = resolved;
      this.onChanged?.(resolved);
    }
    for (const window of BrowserWindow.getAllWindows()) this.applyToWindow(window);
    this.applyDockIcon();
  }

  private applyDockIcon(): void {
    if (process.platform !== 'darwin' || !app.dock) return;
    const icon = this.iconPath('mac1024');
    if (!icon) return;
    try {
      app.dock.setIcon(icon);
    } catch {
      // The Dock can be unavailable in headless contexts.
    }
  }
}
