import type { AppearanceSettings, DesktopPreferences, PreferenceId } from '../../shell-contract.js';
import { isPreferenceId, validatePreferenceValue } from '../../shell-contract.js';
import type { DesktopSettings, DesktopSettingsStore } from './desktop-settings.js';
import { applyPreference } from './desktop-settings.js';

/** The Desktop settings partition a preference id belongs to. */
type PreferencePartition = 'general' | 'appearance' | 'session' | 'notifications' | 'statusBar' | 'update';

/** Default menu-bar quota flag when `tray.showQuota` is unset. */
export const DEFAULT_MENU_BAR_QUOTA = true;

/** System-backed general values the main process projects into the renderer view. */
export interface DesktopPreferencesSystem {
  /** Native login-item state; read from the OS, never persisted in the document. */
  openAtLogin: boolean;
}

function preferencePartition(id: PreferenceId): PreferencePartition {
  if (id.startsWith('general.')) return 'general';
  if (id.startsWith('appearance.')) return 'appearance';
  if (id.startsWith('session.')) return 'session';
  if (id.startsWith('statusBar.')) return 'statusBar';
  if (id.startsWith('update.')) return 'update';
  return 'notifications';
}

/** Appearance ids whose write must go through the appearance controller. */
function isAppearanceResolvedId(id: PreferenceId): boolean {
  return id === 'appearance.theme'
    || id === 'appearance.colorMode'
    || id === 'appearance.motion'
    || id === 'appearance.zoom';
}

function appearancePatch(id: PreferenceId, value: unknown): Partial<AppearanceSettings> {
  switch (id) {
    case 'appearance.theme':
      return { theme: value as AppearanceSettings['theme'] };
    case 'appearance.colorMode':
      return { colorMode: value as AppearanceSettings['colorMode'] };
    case 'appearance.motion':
      return { motion: value as AppearanceSettings['motion'] };
    case 'appearance.zoom':
      return { zoom: value as number };
    default:
      return {};
  }
}

export function preferencesFromDocument(
  settings: DesktopSettings,
  system: DesktopPreferencesSystem = { openAtLogin: false },
): DesktopPreferences {
  return {
    general: {
      ...settings.general,
      openAtLogin: system.openAtLogin,
      menuBarQuota: settings.tray.showQuota ?? DEFAULT_MENU_BAR_QUOTA,
    },
    appearance: { ...settings.appearance },
    session: { ...settings.session },
    notifications: {
      ...settings.notifications,
      events: { ...settings.notifications.events },
    },
    statusBar: { hidden: [...settings.statusBar.hidden] },
    update: { ...settings.update },
  };
}

export interface DesktopPreferencesControllerOptions {
  store: DesktopSettingsStore;
  /**
   * Appearance theme/colorMode/motion/zoom are owned by the appearance
   * controller, which re-resolves nativeTheme and re-applies window chrome; the
   * preference bridge delegates those ids rather than double-writing.
   */
  saveAppearance?: (patch: Partial<AppearanceSettings>) => void;
  /** Mirrors the do-not-disturb write into the notification center. */
  onDoNotDisturb?: (value: boolean) => void;
  /** Reads the native login-item state for the general projection. */
  readOpenAtLogin?: () => boolean;
  /** Writes the native login-item state; macOS/Windows only. */
  setOpenAtLogin?: (value: boolean) => void;
  /** The persisted `tray.showQuota` flag changed; e.g. rebuild the tray menu. */
  onMenuBarQuotaChanged?: () => void;
}

/**
 * The single main-process writer for the version 3 preference partitions.
 * Every mutation is validated against the shared shell-contract schema before
 * the store is touched, so an illegal value can never be persisted.
 */
export class DesktopPreferencesController {
  constructor(private readonly options: DesktopPreferencesControllerOptions) {}

  get(): DesktopPreferences {
    return preferencesFromDocument(this.options.store.load(), {
      openAtLogin: this.options.readOpenAtLogin?.() ?? false,
    });
  }

  set(id: string, value: unknown): DesktopPreferences {
    if (!isPreferenceId(id)) throw new Error('未知偏好');
    if (!validatePreferenceValue(id, value)) throw new Error(`偏好值无效：${id}`);
    if (isAppearanceResolvedId(id)) {
      this.options.saveAppearance?.(appearancePatch(id, value));
      return this.get();
    }
    // System-backed ids never persist a second copy in the general partition:
    // `openAtLogin` lives in the OS and `menuBarQuota` is `tray.showQuota`.
    if (id === 'general.openAtLogin') {
      this.options.setOpenAtLogin?.(value as boolean);
      return this.get();
    }
    if (id === 'general.menuBarQuota') {
      const tray = this.options.store.load().tray;
      this.options.store.patch('tray', { ...tray, showQuota: value as boolean });
      this.options.onMenuBarQuotaChanged?.();
      return this.get();
    }
    const next = applyPreference(this.options.store.load(), id, value);
    this.options.store.patch(preferencePartition(id), next[preferencePartition(id)]);
    if (id === 'notifications.doNotDisturb') {
      this.options.onDoNotDisturb?.(value as boolean);
    }
    return this.get();
  }
}
