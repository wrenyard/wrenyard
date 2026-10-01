import {
  PREFERENCES,
  isPreferenceId,
  validatePreferenceValue,
  writePreferenceValue,
  type AppearanceSettings,
  type DesktopPreferences,
  type PreferenceId,
} from '../../shell-contract.js';
import type { DesktopSettings, DesktopSettingsStore } from './desktop-settings.js';

/** Default menu-bar quota flag when `tray.showQuota` is unset. */
export const DEFAULT_MENU_BAR_QUOTA = true;

/** System-backed general values the main process projects into the renderer view. */
export interface DesktopPreferencesSystem {
  /** Native login-item state; read from the OS, never persisted in the document. */
  openAtLogin: boolean;
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
 * Ids whose write is owned elsewhere — the appearance controller, the OS login
 * item, or the tray — so the document write is skipped and the id-keyed side
 * effect runs instead.
 */
const DELEGATED_PREFERENCE_IDS: ReadonlySet<PreferenceId> = new Set([
  'appearance.theme',
  'appearance.colorMode',
  'appearance.motion',
  'appearance.zoom',
  'general.openAtLogin',
  'general.menuBarQuota',
]);

/**
 * The single main-process writer for the version 3 preference partitions.
 * Every mutation is validated against the shared shell-contract schema before
 * the store is touched, so an illegal value can never be persisted. Storage is
 * generic (the shell-contract descriptor table owns the path); only genuinely
 * id-dependent side effects live in the map below.
 */
export class DesktopPreferencesController {
  /** Id-dependent side effects; delegated ids run instead of the document write. */
  private readonly sideEffects: Partial<Record<PreferenceId, (value: unknown) => void>>;

  constructor(private readonly options: DesktopPreferencesControllerOptions) {
    this.sideEffects = {
      'appearance.theme': (value) => options.saveAppearance?.({ theme: value as AppearanceSettings['theme'] }),
      'appearance.colorMode': (value) => options.saveAppearance?.({ colorMode: value as AppearanceSettings['colorMode'] }),
      'appearance.motion': (value) => options.saveAppearance?.({ motion: value as AppearanceSettings['motion'] }),
      'appearance.zoom': (value) => options.saveAppearance?.({ zoom: value as number }),
      'general.openAtLogin': (value) => options.setOpenAtLogin?.(value as boolean),
      'general.menuBarQuota': (value) => {
        const tray = options.store.load().tray;
        options.store.patch('tray', { ...tray, showQuota: value as boolean });
        options.onMenuBarQuotaChanged?.();
      },
      'notifications.doNotDisturb': (value) => options.onDoNotDisturb?.(value as boolean),
    };
  }

  get(): DesktopPreferences {
    return preferencesFromDocument(this.options.store.load(), {
      openAtLogin: this.options.readOpenAtLogin?.() ?? false,
    });
  }

  set(id: string, value: unknown): DesktopPreferences {
    if (!isPreferenceId(id)) throw new Error('未知偏好');
    if (!validatePreferenceValue(id, value)) throw new Error(`偏好值无效：${id}`);
    const sideEffect = this.sideEffects[id];
    if (DELEGATED_PREFERENCE_IDS.has(id)) {
      sideEffect?.(value);
      return this.get();
    }
    // Generic storage: the descriptor table maps the id to its partition path.
    const next = writePreferenceValue(this.options.store.load(), id, value);
    const section = PREFERENCES[id].path[0] as keyof Omit<DesktopSettings, 'version'>;
    this.options.store.patch(section, next[section]);
    // Mirrored ids (e.g. do-not-disturb) notify their owner after the write.
    sideEffect?.(value);
    return this.get();
  }
}
